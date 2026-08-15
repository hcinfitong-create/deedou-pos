import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createAdminBackendApi } from "./admin.js";
import { createAuthoritativeBackendApi as createOperationalBackendApi } from "./authoritative.js";
import { AUTH_HEALTH_STATES, REALTIME_HEALTH_STATES } from "./resilience.js";

const RECONNECT_DELAY_MS = 1_500;

export function createAuthoritativeBackendApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi || null;
  const authStateRef = typeof options.authStateRef === "function" ? options.authStateRef : () => ({});
  const base = createOperationalBackendApi(options);
  const adminApi = createAdminBackendApi(options);

  function isAdminWorkstation() {
    const authState = authStateRef() || {};
    return String(authState.authorization?.workstationMode || authState.workstationMode || "").trim().toUpperCase() === "ADMIN";
  }

  async function fetchStaffSnapshot(args = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE || !isAdminWorkstation()) {
      return base.fetchStaffSnapshot(args);
    }

    const result = await adminApi.fetchMenu({ locationId: args.locationId });
    if (!result?.ok) {
      if (result?.category === "UNAUTHENTICATED") {
        base.operational?.markAuth?.(AUTH_HEALTH_STATES.UNAUTHENTICATED, result.reason || "SIGN_IN_REQUIRED");
      }
      if (result?.category === "BACKEND_UNAVAILABLE") {
        base.operational?.markBackendProbe?.({ ok: false, reason: result.reason || "ADMIN_MENU_REFETCH_FAILED" });
      }
      base.operational?.markCommandFailure?.({
        category: result?.category || "BACKEND_UNAVAILABLE",
        reason: result?.reason || "ADMIN_MENU_REFETCH_FAILED",
        correlationId: result?.correlationId || ""
      });
      return result;
    }

    base.operational?.markBackendProbe?.({ ok: true, reason: "ADMIN_MENU_AUTHORITY_OK" });
    base.operational?.markAuth?.(AUTH_HEALTH_STATES.AUTHENTICATED, "AUTH_SESSION_OK");
    base.operational?.markAuthoritativeRefresh?.({
      correlationId: result.correlationId || "",
      reason: "ADMIN_MENU_REFRESH_OK"
    });
    base.operational?.clearCommandFailure?.();

    return {
      ...result,
      entityType: "location",
      entityId: String(args.locationId || result.entityId || "").trim(),
      payload: {
        locationId: String(args.locationId || result.payload?.locationId || "").trim(),
        products: normalizeAdminProducts(result.payload?.products),
        orders: [],
        tableSessions: [],
        events: []
      }
    };
  }

  function subscribeLocationRefresh({ locationId, onRefresh, onError } = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE || !isAdminWorkstation()) {
      return base.subscribeLocationRefresh({ locationId, onRefresh, onError });
    }

    let closed = false;
    let subscription = null;
    let reconnectTimer = null;
    let connecting = false;
    let authSubscription = null;

    const clearRealtime = () => {
      subscription?.unsubscribe?.();
      subscription = null;
    };

    const scheduleReconnect = (reason = "ADMIN_REALTIME_RECONNECT_REQUIRED") => {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(reason).catch((error) => {
          onError?.(error);
          scheduleReconnect("ADMIN_REALTIME_RECONNECT_FAILED");
        });
      }, RECONNECT_DELAY_MS);
    };

    const connect = async (reason = "ADMIN_REALTIME_CONNECT") => {
      if (closed || connecting) return;
      connecting = true;
      clearRealtime();
      base.operational?.beginReconnect?.(reason);
      try {
        const sessionResult = await authApi?.getSessionInfo?.();
        if (closed) return;
        if (!sessionResult?.ok || !sessionResult.session) {
          base.operational?.markAuth?.(AUTH_HEALTH_STATES.UNAUTHENTICATED, sessionResult?.reason || "SIGN_IN_REQUIRED");
          onError?.(new Error(sessionResult?.reason || "SIGN_IN_REQUIRED"));
          return;
        }
        base.operational?.markAuth?.(AUTH_HEALTH_STATES.AUTHENTICATED, "AUTH_SESSION_OK");
        base.operational?.markRealtime?.(REALTIME_HEALTH_STATES.SUBSCRIBING, "ADMIN_REALTIME_SUBSCRIBING");

        const next = await adminApi.subscribeMenuRefresh({
          locationId,
          onRefresh(payload) {
            if (closed) return;
            onRefresh?.(normalizeAdminRefresh(payload, locationId));
          },
          onState(state, nextReason = "") {
            if (closed) return;
            if (state === "ERROR" || state === "DISCONNECTED") {
              base.operational?.markRealtime?.(REALTIME_HEALTH_STATES.ERROR, nextReason || `ADMIN_REALTIME_${state}`);
              scheduleReconnect(nextReason || `ADMIN_REALTIME_${state}`);
            }
          }
        });

        if (closed) {
          next?.unsubscribe?.();
          return;
        }
        if (!next?.ok) {
          if (next?.category === "UNAUTHENTICATED") {
            base.operational?.markAuth?.(AUTH_HEALTH_STATES.UNAUTHENTICATED, next.reason || "SIGN_IN_REQUIRED");
          } else {
            base.operational?.markRealtime?.(REALTIME_HEALTH_STATES.ERROR, next?.reason || "ADMIN_REALTIME_TICKET_FAILED");
            scheduleReconnect(next?.reason || "ADMIN_REALTIME_TICKET_FAILED");
          }
          onError?.(new Error(next?.reason || next?.category || "ADMIN_REALTIME_TICKET_FAILED"));
          return;
        }

        subscription = next;
        base.operational?.markBackendProbe?.({ ok: true, reason: "ADMIN_REALTIME_BACKEND_OK" });
        base.operational?.markRealtime?.(REALTIME_HEALTH_STATES.SUBSCRIBED, "ADMIN_REALTIME_SUBSCRIBED");

        // A private broadcast channel is only a refresh hint. Force the same
        // app-level authoritative refetch used by staff/cashier before ONLINE.
        onRefresh?.(normalizeAdminRefresh({ reason: "RECONNECT_AUTHORITATIVE_REFETCH_REQUIRED" }, locationId, true));
      } finally {
        connecting = false;
      }
    };

    authSubscription = authApi?.onAuthStateChange?.(({ event, session }) => {
      if (closed) return;
      if (!session) {
        clearRealtime();
        base.operational?.markAuth?.(AUTH_HEALTH_STATES.UNAUTHENTICATED, event || "SIGNED_OUT");
        base.operational?.markRealtime?.(REALTIME_HEALTH_STATES.DISCONNECTED, "AUTH_SESSION_ENDED");
        return;
      }
      base.operational?.markAuth?.(AUTH_HEALTH_STATES.AUTHENTICATED, event || "AUTH_SESSION_CHANGED");
      if (["SIGNED_IN", "TOKEN_REFRESHED", "INITIAL_SESSION", "USER_UPDATED"].includes(event)) {
        connect(`AUTH_${event}`).catch((error) => {
          onError?.(error);
          scheduleReconnect("ADMIN_AUTH_RECONNECT_FAILED");
        });
      }
    });

    const onlineHandler = () => connect("BROWSER_NETWORK_HINT").catch((error) => {
      onError?.(error);
      scheduleReconnect("ADMIN_NETWORK_RECONNECT_FAILED");
    });
    globalThis.addEventListener?.("online", onlineHandler);
    connect("INITIAL_ADMIN_REALTIME_CONNECT").catch((error) => {
      onError?.(error);
      scheduleReconnect("INITIAL_ADMIN_REALTIME_FAILED");
    });

    return {
      operational: base.operational,
      unsubscribe() {
        closed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        clearRealtime();
        authSubscription?.unsubscribe?.();
        globalThis.removeEventListener?.("online", onlineHandler);
        base.operational?.markRealtime?.(REALTIME_HEALTH_STATES.DISCONNECTED, "ADMIN_REALTIME_UNSUBSCRIBED");
      }
    };
  }

  return {
    ...base,
    fetchStaffSnapshot,
    subscribeLocationRefresh
  };
}

function normalizeAdminProducts(products) {
  return (Array.isArray(products) ? products : []).map((product) => ({
    id: String(product?.id || "").trim(),
    kind: String(product?.kind || "").trim(),
    category: String(product?.category || "").trim(),
    vi: String(product?.nameVi || product?.name_vi || "").trim(),
    en: String(product?.nameEn || product?.name_en || "").trim(),
    price: Number(product?.priceVnd ?? product?.price_vnd ?? 0),
    available: product?.available === true,
    periods: Array.isArray(product?.periods) ? product.periods : [],
    variants: [],
    modifierGroups: [],
    components: []
  })).filter((product) => product.id);
}

function normalizeAdminRefresh(payload = {}, locationId = "", reconnect = false) {
  return {
    broadcast: true,
    audience: "admin",
    reconnect,
    new: {
      location_id: String(payload.locationId || locationId || "").trim(),
      audience: "admin",
      entity_type: String(payload.entityType || "product").trim(),
      entity_id: String(payload.entityId || "").trim(),
      payload: {
        ...payload,
        locationId: String(payload.locationId || locationId || "").trim(),
        audience: "admin"
      }
    }
  };
}
