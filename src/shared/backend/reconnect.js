import { BACKEND_MODES } from "./config.js";
import { AUTH_HEALTH_STATES, REALTIME_HEALTH_STATES } from "./resilience.js";

const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 8_000;

export function createReconnectCoordinator(options = {}) {
  const mode = options.mode || BACKEND_MODES.LOCAL_DEMO;
  const authApi = options.authApi || null;
  const backendApi = options.backendApi || null;
  const operational = options.operationalController || null;
  const onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : () => {};
  const onRefresh = typeof options.onRefresh === "function" ? options.onRefresh : () => {};
  const subscribeTimeoutMs = Number.isFinite(options.subscribeTimeoutMs) && options.subscribeTimeoutMs > 0
    ? options.subscribeTimeoutMs
    : DEFAULT_SUBSCRIBE_TIMEOUT_MS;
  let channels = [];
  let generation = 0;

  function disconnect() {
    generation += 1;
    channels.forEach((channel) => channel?.unsubscribe?.());
    channels = [];
    operational?.markRealtime?.(REALTIME_HEALTH_STATES.DISCONNECTED, "REALTIME_DISCONNECTED");
  }

  async function recover({ locationId, audiences = ["ops"], reason = "RECONNECT_REQUESTED" } = {}) {
    if (mode !== BACKEND_MODES.SUPABASE) {
      return { ok: true, reason: "LOCAL_DEMO", snapshot: null };
    }
    const recoveryGeneration = ++generation;
    channels.forEach((channel) => channel?.unsubscribe?.());
    channels = [];
    operational?.beginReconnect?.(reason);

    const sessionResult = await authApi?.getSessionInfo?.();
    if (recoveryGeneration !== generation) return cancelled();
    if (!sessionResult?.ok || !sessionResult.session) {
      operational?.markAuth?.(AUTH_HEALTH_STATES.UNAUTHENTICATED, sessionResult?.reason || "SIGN_IN_REQUIRED");
      operational?.markBackendProbe?.({ ok: Boolean(sessionResult?.ok), reason: sessionResult?.reason || "AUTH_SESSION_MISSING" });
      return { ok: false, category: "UNAUTHENTICATED", reason: sessionResult?.reason || "SIGN_IN_REQUIRED" };
    }
    operational?.markAuth?.(AUTH_HEALTH_STATES.AUTHENTICATED, "AUTH_SESSION_OK");

    const client = await authApi?.getClient?.();
    if (recoveryGeneration !== generation) return cancelled();
    if (!client?.channel) {
      operational?.markBackendProbe?.({ ok: false, reason: "SUPABASE_CLIENT_UNAVAILABLE" });
      operational?.markRealtime?.(REALTIME_HEALTH_STATES.ERROR, "REALTIME_CLIENT_UNAVAILABLE");
      return { ok: false, category: "BACKEND_UNAVAILABLE", reason: "SUPABASE_CLIENT_UNAVAILABLE" };
    }

    operational?.markRealtime?.(REALTIME_HEALTH_STATES.SUBSCRIBING, "REALTIME_SUBSCRIBING");
    const topics = [];
    for (const audience of uniqueAudiences(audiences)) {
      const ticket = await backendApi?.issueRealtimeTicket?.({ locationId, audience });
      if (recoveryGeneration !== generation) return cancelled();
      if (!ticket?.ok) {
        operational?.markRealtime?.(REALTIME_HEALTH_STATES.ERROR, ticket?.reason || "REALTIME_TICKET_DENIED");
        return { ok: false, category: ticket?.category || "FORBIDDEN", reason: ticket?.reason || "REALTIME_TICKET_DENIED" };
      }
      const topic = text(ticket.payload?.topic);
      if (!topic) {
        operational?.markRealtime?.(REALTIME_HEALTH_STATES.ERROR, "REALTIME_TICKET_TOPIC_MISSING");
        return { ok: false, category: "BACKEND_UNAVAILABLE", reason: "REALTIME_TICKET_TOPIC_MISSING" };
      }
      topics.push({ audience, topic });
    }

    try {
      const subscribed = await Promise.all(topics.map(({ audience, topic }) => subscribePrivateChannel({
        client,
        topic,
        audience,
        timeoutMs: subscribeTimeoutMs,
        onBroadcast: async (event) => {
          if (recoveryGeneration !== generation) return;
          const refreshResult = await authoritativeRefetch({ locationId, correlationId: text(event?.payload?.correlationId) });
          if (refreshResult.ok) onRefresh(refreshResult.snapshot, event);
        }
      })));
      if (recoveryGeneration !== generation) {
        subscribed.forEach((channel) => channel?.unsubscribe?.());
        return cancelled();
      }
      channels = subscribed;
      operational?.markRealtime?.(REALTIME_HEALTH_STATES.SUBSCRIBED, "REALTIME_SUBSCRIBED");
    } catch (error) {
      channels.forEach((channel) => channel?.unsubscribe?.());
      channels = [];
      operational?.markRealtime?.(REALTIME_HEALTH_STATES.ERROR, safeReason(error, "REALTIME_SUBSCRIBE_FAILED"));
      operational?.markBackendProbe?.({ ok: false, reason: safeReason(error, "REALTIME_SUBSCRIBE_FAILED") });
      return { ok: false, category: "BACKEND_UNAVAILABLE", reason: safeReason(error, "REALTIME_SUBSCRIBE_FAILED") };
    }

    const refreshResult = await authoritativeRefetch({ locationId });
    if (recoveryGeneration !== generation) return cancelled();
    if (!refreshResult.ok) return refreshResult;
    onSnapshot(refreshResult.snapshot);
    return { ok: true, reason: "RECOVERY_COMPLETE", snapshot: refreshResult.snapshot };
  }

  async function authoritativeRefetch({ locationId, correlationId = "" } = {}) {
    const result = await backendApi?.fetchStaffSnapshot?.({ locationId });
    if (!result?.ok) {
      operational?.markBackendProbe?.({ ok: false, reason: result?.reason || result?.category || "AUTHORITATIVE_REFETCH_FAILED" });
      operational?.markCommandFailure?.({
        category: result?.category || "BACKEND_UNAVAILABLE",
        reason: result?.reason || "AUTHORITATIVE_REFETCH_FAILED",
        correlationId
      });
      return { ok: false, category: result?.category || "BACKEND_UNAVAILABLE", reason: result?.reason || "AUTHORITATIVE_REFETCH_FAILED" };
    }
    operational?.markBackendProbe?.({ ok: true, reason: "AUTHORITATIVE_BACKEND_OK" });
    operational?.markAuthoritativeRefresh?.({ correlationId, reason: "AUTHORITATIVE_REFRESH_OK" });
    return { ok: true, snapshot: result.payload || {}, result };
  }

  return {
    recover,
    disconnect,
    authoritativeRefetch,
    get subscriptionCount() {
      return channels.length;
    }
  };
}

function subscribePrivateChannel({ client, topic, audience, timeoutMs, onBroadcast }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const channel = client
      .channel(topic, { config: { private: true } })
      .on("broadcast", { event: "refresh" }, (event) => onBroadcast?.({ ...event, audience }))
      .subscribe((status, error) => {
        if (error) {
          finish(reject, new Error(safeReason(error, "REALTIME_SUBSCRIBE_ERROR")));
          return;
        }
        if (status === "SUBSCRIBED") {
          finish(resolve, channel);
          return;
        }
        if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          finish(reject, new Error(`REALTIME_${status}`));
        }
      });
    timer = setTimeout(() => finish(reject, new Error("REALTIME_SUBSCRIBE_TIMEOUT")), timeoutMs);
  });
}

function uniqueAudiences(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map(text).filter((item) => ["ops", "cashier", "audit"].includes(item)))];
}

function cancelled() {
  return { ok: false, category: "CONFLICT", reason: "RECOVERY_SUPERSEDED" };
}

function safeReason(error, fallback) {
  return text(error?.message || error?.code || error || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer_[REDACTED]")
    .replace(/[^A-Za-z0-9:_-]+/g, "_")
    .slice(0, 160) || fallback;
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
