import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createAuthoritativeBackendApi as createBaseAuthoritativeBackendApi } from "./commands.js";
import {
  AUTH_HEALTH_STATES,
  REALTIME_HEALTH_STATES,
  createOperationalStateController,
  sanitizeOperationalDiagnostic
} from "./resilience.js";

const STAFF_MUTATION_METHODS = new Set([
  "completeServiceRequest",
  "createStaffOrder",
  "setOrderStatus",
  "voidOrder",
  "updateKdsLinePrep",
  "serveOrderLine",
  "serveAllReady",
  "updateOrderLineBillQty",
  "assignFamilyCourse",
  "holdFamily",
  "fireFamily",
  "fireCourse",
  "openTableVisit",
  "transferTableVisit",
  "closeTableVisit",
  "recordOrderPayment",
  "voidOrderPayment",
  "refundOrderPayment",
  "recordTableTender"
]);

const REALTIME_SUBSCRIBE_TIMEOUT_MS = 8_000;
const REALTIME_RECONNECT_MAX_MS = 15_000;
export const OPERATIONAL_STATE_EVENT = "deedou:operational-state";

export function createAuthoritativeBackendApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi || null;
  const authStateRef = typeof options.authStateRef === "function" ? options.authStateRef : () => ({});
  const base = createBaseAuthoritativeBackendApi(options);
  const operational = options.operationalController || createOperationalStateController({ mode: config.mode });
  const unsubscribeOperational = operational.subscribe((state) => emitOperationalState(state));

  async function fetchStaffSnapshot(fetchOptions = {}) {
    const result = await base.fetchStaffSnapshot(fetchOptions);
    if (result?.ok) {
      operational.markBackendProbe({ ok: true, reason: "AUTHORITATIVE_BACKEND_OK" });
      operational.markAuth(AUTH_HEALTH_STATES.AUTHENTICATED, "AUTH_SESSION_OK");
      operational.markAuthoritativeRefresh({
        correlationId: safeCorrelationId(result?.payload?.correlationId),
        reason: "AUTHORITATIVE_REFRESH_OK"
      });
    } else {
      markFailure(result, "AUTHORITATIVE_REFETCH_FAILED");
    }
    return result;
  }

  async function executeGuarded(name, args) {
    const guard = operational.mutationGuard(name);
    if (!guard.ok) {
      const blocked = {
        ok: false,
        category: guard.category,
        reason: guard.reason,
        entityType: "",
        entityId: "",
        version: null,
        payload: {}
      };
      operational.markCommandFailure({ category: blocked.category, reason: blocked.reason });
      return blocked;
    }
    const result = await base[name](args);
    if (result?.ok) {
      operational.markBackendProbe({ ok: true, reason: "AUTHORITATIVE_COMMAND_OK" });
      operational.clearCommandFailure();
    } else {
      markFailure(result, `${name}_FAILED`);
    }
    return result;
  }

  function markFailure(result, fallbackReason) {
    const category = String(result?.category || "BACKEND_UNAVAILABLE");
    const reason = String(result?.reason || fallbackReason || "AUTHORITATIVE_COMMAND_FAILED");
    if (category === "UNAUTHENTICATED") operational.markAuth(AUTH_HEALTH_STATES.UNAUTHENTICATED, reason);
    if (category === "BACKEND_UNAVAILABLE") operational.markBackendProbe({ ok: false, reason });
    operational.markCommandFailure({ category, reason });
  }

  function subscribeLocationRefresh({ locationId, onRefresh, onError } = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE) return base.subscribeLocationRefresh({ locationId, onRefresh, onError });
    let closed = false;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let channels = [];
    let authSubscription = null;
    let connecting = false;

    const cleanupChannels = () => {
      channels.forEach((channel) => channel?.unsubscribe?.());
      channels = [];
    };

    const scheduleReconnect = (reason = "REALTIME_RECONNECT_REQUIRED") => {
      if (closed || reconnectTimer) return;
      operational.markRealtime(REALTIME_HEALTH_STATES.DISCONNECTED, reason);
      const delay = Math.min(REALTIME_RECONNECT_MAX_MS, 750 * (2 ** Math.min(reconnectAttempt, 5)));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(reason).catch((error) => {
          reportError(error, "REALTIME_RECONNECT_FAILED");
          scheduleReconnect("REALTIME_RECONNECT_FAILED");
        });
      }, delay);
    };

    const reportError = (error, fallback = "REALTIME_ERROR") => {
      const reason = safeReason(error, fallback);
      onError?.(new Error(reason));
      return reason;
    };

    const connect = async (reason = "REALTIME_CONNECT") => {
      if (closed || connecting) return;
      connecting = true;
      const activeGeneration = ++generation;
      cleanupChannels();
      operational.beginReconnect(reason);
      try {
        const sessionResult = await authApi?.getSessionInfo?.();
        if (closed || activeGeneration !== generation) return;
        if (!sessionResult?.ok || !sessionResult.session) {
          operational.markAuth(AUTH_HEALTH_STATES.UNAUTHENTICATED, sessionResult?.reason || "SIGN_IN_REQUIRED");
          reportError(sessionResult?.reason || "SIGN_IN_REQUIRED", "SIGN_IN_REQUIRED");
          return;
        }
        operational.markAuth(AUTH_HEALTH_STATES.AUTHENTICATED, "AUTH_SESSION_OK");

        const client = await authApi?.getClient?.();
        if (closed || activeGeneration !== generation) return;
        if (!client?.channel) throw new Error("SUPABASE_CLIENT_UNAVAILABLE");

        operational.markRealtime(REALTIME_HEALTH_STATES.SUBSCRIBING, "REALTIME_SUBSCRIBING");
        const audiences = refreshAudiences(locationId, authStateRef());
        const nextChannels = [];
        for (const audience of audiences) {
          const ticket = await base.issueRealtimeTicket({ locationId, audience });
          if (closed || activeGeneration !== generation) return;
          if (!ticket?.ok) {
            if (audience === "ops") throw new Error(ticket?.reason || "REALTIME_TICKET_DENIED");
            continue;
          }
          const topic = String(ticket?.payload?.topic || "").trim();
          if (!topic) throw new Error("REALTIME_TICKET_TOPIC_MISSING");
          const channel = await subscribePrivateChannel({
            client,
            topic,
            audience,
            timeoutMs: REALTIME_SUBSCRIBE_TIMEOUT_MS,
            onRefresh,
            onTerminal: (status) => {
              if (closed || activeGeneration !== generation) return;
              reportError(status, "REALTIME_CHANNEL_ERROR");
              scheduleReconnect(status);
            }
          });
          nextChannels.push(channel);
        }
        if (closed || activeGeneration !== generation) {
          nextChannels.forEach((channel) => channel?.unsubscribe?.());
          return;
        }
        channels = nextChannels;
        reconnectAttempt = 0;
        operational.markBackendProbe({ ok: true, reason: "REALTIME_BACKEND_OK" });
        operational.markRealtime(REALTIME_HEALTH_STATES.SUBSCRIBED, "REALTIME_SUBSCRIBED");

        // Realtime is only a refresh hint. Force the existing app path to refetch
        // its authoritative snapshot before the controller can become ONLINE.
        onRefresh?.(syntheticRefresh(locationId, "RECONNECT_AUTHORITATIVE_REFETCH_REQUIRED"));
      } catch (error) {
        if (closed || activeGeneration !== generation) return;
        cleanupChannels();
        const failureReason = reportError(error, "REALTIME_CONNECT_FAILED");
        operational.markRealtime(REALTIME_HEALTH_STATES.ERROR, failureReason);
        if (failureReason !== "SIGN_IN_REQUIRED") scheduleReconnect(failureReason);
      } finally {
        connecting = false;
      }
    };

    authSubscription = authApi?.onAuthStateChange?.(({ event, session }) => {
      if (closed) return;
      if (!session) {
        cleanupChannels();
        operational.markAuth(AUTH_HEALTH_STATES.UNAUTHENTICATED, event || "SIGNED_OUT");
        operational.markRealtime(REALTIME_HEALTH_STATES.DISCONNECTED, "AUTH_SESSION_ENDED");
        return;
      }
      operational.markAuth(AUTH_HEALTH_STATES.AUTHENTICATED, event || "AUTH_SESSION_CHANGED");
      if (["SIGNED_IN", "TOKEN_REFRESHED", "INITIAL_SESSION", "USER_UPDATED"].includes(event)) {
        connect(`AUTH_${event}`).catch((error) => scheduleReconnect(reportError(error)));
      }
    });

    const onlineHandler = () => connect("BROWSER_NETWORK_HINT").catch((error) => scheduleReconnect(reportError(error)));
    globalThis.addEventListener?.("online", onlineHandler);
    connect("INITIAL_REALTIME_CONNECT").catch((error) => scheduleReconnect(reportError(error)));

    return {
      operational,
      unsubscribe() {
        closed = true;
        generation += 1;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        cleanupChannels();
        authSubscription?.unsubscribe?.();
        globalThis.removeEventListener?.("online", onlineHandler);
        operational.markRealtime(REALTIME_HEALTH_STATES.DISCONNECTED, "REALTIME_UNSUBSCRIBED");
        unsubscribeOperational?.();
      }
    };
  }

  const api = {
    ...base,
    fetchStaffSnapshot,
    subscribeLocationRefresh,
    operational
  };

  for (const method of STAFF_MUTATION_METHODS) {
    if (typeof base[method] !== "function") continue;
    api[method] = (args = {}) => executeGuarded(method, args);
  }

  return api;
}

function subscribePrivateChannel({ client, topic, audience, timeoutMs, onRefresh, onTerminal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const channel = client
      .channel(topic, { config: { private: true } })
      .on("broadcast", { event: "refresh" }, (event) => onRefresh?.(normalizeRefreshBroadcast(event, audience)));

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };

    timer = setTimeout(() => finish(reject, new Error("REALTIME_SUBSCRIBE_TIMEOUT")), timeoutMs);
    channel.subscribe((status, error) => {
      if (error) {
        if (!settled) finish(reject, error);
        else onTerminal?.("REALTIME_CHANNEL_ERROR");
        return;
      }
      if (status === "SUBSCRIBED") {
        finish(resolve, channel);
        return;
      }
      if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        if (!settled) finish(reject, new Error(`REALTIME_${status}`));
        else onTerminal?.(`REALTIME_${status}`);
      }
    });
  });
}

function refreshAudiences(locationId, authState = {}) {
  const audiences = ["ops"];
  const mode = String(authState.authorization?.workstationMode || authState.workstationMode || "").trim();
  const rows = Array.isArray(authState.staffContext) ? authState.staffContext : [];
  const location = String(locationId || "").trim();
  const row = rows.find((item) => String(item.locationId || item.location_id || "").trim() === location) || rows[0] || {};
  const permissions = Array.isArray(row.permissions) ? row.permissions.map((item) => String(item || "").trim()) : [];
  if (["CASHIER", "ADMIN"].includes(mode) && (permissions.includes("payments.read") || permissions.includes("payments.record"))) {
    audiences.push("cashier");
  }
  return audiences;
}

function normalizeRefreshBroadcast(event = {}, audience = "ops") {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  return {
    broadcast: true,
    audience,
    new: {
      location_id: String(payload.locationId || "").trim(),
      audience: String(payload.audience || audience || "").trim(),
      entity_type: String(payload.entityType || "").trim(),
      entity_id: String(payload.entityId || "").trim(),
      payload
    }
  };
}

function syntheticRefresh(locationId, reason) {
  return {
    broadcast: true,
    audience: "ops",
    reconnect: true,
    new: {
      location_id: String(locationId || "").trim(),
      audience: "ops",
      entity_type: "connection",
      entity_id: "authoritative-refetch",
      payload: { locationId: String(locationId || "").trim(), audience: "ops", entityType: "connection", entityId: "authoritative-refetch", reason }
    }
  };
}

function emitOperationalState(state) {
  const detail = sanitizeOperationalDiagnostic(state);
  try {
    if (typeof globalThis.CustomEvent === "function" && typeof globalThis.dispatchEvent === "function") {
      globalThis.dispatchEvent(new CustomEvent(OPERATIONAL_STATE_EVENT, { detail }));
    }
  } catch {
    // Diagnostics must never break the command path.
  }
}

function safeReason(error, fallback = "BACKEND_UNAVAILABLE") {
  return String(error?.message || error?.code || error || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer_[REDACTED]")
    .replace(/[^A-Za-z0-9:_-]+/g, "_")
    .slice(0, 160) || fallback;
}

function safeCorrelationId(value) {
  return String(value || "").replace(/[^A-Za-z0-9:._-]+/g, "").slice(0, 160);
}
