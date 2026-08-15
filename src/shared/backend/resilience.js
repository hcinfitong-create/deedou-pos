import { BACKEND_MODES } from "./config.js";

export const OPERATIONAL_STATES = Object.freeze({
  ONLINE: "ONLINE",
  RECONNECTING: "RECONNECTING",
  OFFLINE: "OFFLINE",
  DEGRADED: "DEGRADED",
  STALE: "STALE"
});

export const AUTH_HEALTH_STATES = Object.freeze({
  UNKNOWN: "UNKNOWN",
  AUTHENTICATED: "AUTHENTICATED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  ERROR: "ERROR"
});

export const REALTIME_HEALTH_STATES = Object.freeze({
  UNKNOWN: "UNKNOWN",
  SUBSCRIBING: "SUBSCRIBING",
  SUBSCRIBED: "SUBSCRIBED",
  DISCONNECTED: "DISCONNECTED",
  ERROR: "ERROR"
});

const DEFAULT_STALE_AFTER_MS = 45_000;
const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization|cookie|card|bank)/i;

export function createOperationalStateController(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && options.staleAfterMs > 0
    ? options.staleAfterMs
    : DEFAULT_STALE_AFTER_MS;
  const mode = options.mode || BACKEND_MODES.LOCAL_DEMO;
  const listeners = new Set();
  let reconnecting = false;
  let backendHealthy = mode !== BACKEND_MODES.SUPABASE;
  let authState = mode === BACKEND_MODES.SUPABASE ? AUTH_HEALTH_STATES.UNKNOWN : AUTH_HEALTH_STATES.AUTHENTICATED;
  let realtimeState = mode === BACKEND_MODES.SUPABASE ? REALTIME_HEALTH_STATES.UNKNOWN : REALTIME_HEALTH_STATES.SUBSCRIBED;
  let lastAuthoritativeRefreshAt = "";
  let lastBackendProbeAt = "";
  let lastCommandFailureCode = "";
  let lastCorrelationId = "";
  let reason = mode === BACKEND_MODES.SUPABASE ? "INITIALIZING" : "LOCAL_DEMO";

  function snapshot() {
    const now = clock();
    const state = deriveOperationalState({
      mode,
      reconnecting,
      backendHealthy,
      authState,
      realtimeState,
      lastAuthoritativeRefreshAt,
      staleAfterMs,
      now
    });
    return {
      state,
      mode,
      backendHealthy,
      authState,
      realtimeState,
      lastAuthoritativeRefreshAt,
      lastBackendProbeAt,
      lastCommandFailureCode,
      lastCorrelationId,
      reason,
      checkedAt: new Date(now).toISOString()
    };
  }

  function emit() {
    const next = snapshot();
    listeners.forEach((listener) => listener(next));
    return next;
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    beginReconnect(nextReason = "RECONNECTING") {
      if (mode !== BACKEND_MODES.SUPABASE) return snapshot();
      reconnecting = true;
      reason = safeCode(nextReason, "RECONNECTING");
      return emit();
    },
    markBackendProbe({ ok, reason: nextReason = "" } = {}) {
      backendHealthy = ok === true;
      lastBackendProbeAt = new Date(clock()).toISOString();
      reason = safeCode(nextReason, ok ? "BACKEND_PROBE_OK" : "BACKEND_PROBE_FAILED");
      if (!backendHealthy) reconnecting = false;
      return emit();
    },
    markAuth(nextAuthState, nextReason = "") {
      authState = Object.values(AUTH_HEALTH_STATES).includes(nextAuthState)
        ? nextAuthState
        : AUTH_HEALTH_STATES.ERROR;
      if ([AUTH_HEALTH_STATES.UNAUTHENTICATED, AUTH_HEALTH_STATES.ERROR].includes(authState)) reconnecting = false;
      reason = safeCode(nextReason, `AUTH_${authState}`);
      return emit();
    },
    markRealtime(nextRealtimeState, nextReason = "") {
      realtimeState = Object.values(REALTIME_HEALTH_STATES).includes(nextRealtimeState)
        ? nextRealtimeState
        : REALTIME_HEALTH_STATES.ERROR;
      if ([REALTIME_HEALTH_STATES.ERROR, REALTIME_HEALTH_STATES.DISCONNECTED].includes(realtimeState)) reconnecting = false;
      reason = safeCode(nextReason, `REALTIME_${realtimeState}`);
      return emit();
    },
    markAuthoritativeRefresh({ correlationId = "", reason: nextReason = "AUTHORITATIVE_REFRESH_OK" } = {}) {
      lastAuthoritativeRefreshAt = new Date(clock()).toISOString();
      lastCorrelationId = safeCorrelationId(correlationId);
      reconnecting = false;
      reason = safeCode(nextReason, "AUTHORITATIVE_REFRESH_OK");
      return emit();
    },
    markCommandFailure({ category = "BACKEND_UNAVAILABLE", reason: nextReason = "", correlationId = "" } = {}) {
      lastCommandFailureCode = safeCode(category, "BACKEND_UNAVAILABLE");
      lastCorrelationId = safeCorrelationId(correlationId);
      reason = safeCode(nextReason, lastCommandFailureCode);
      if (lastCommandFailureCode === "UNAUTHENTICATED") {
        authState = AUTH_HEALTH_STATES.UNAUTHENTICATED;
        reconnecting = false;
      }
      return emit();
    },
    clearCommandFailure() {
      lastCommandFailureCode = "";
      return emit();
    },
    mutationGuard(commandName = "AUTHORITATIVE_COMMAND") {
      return evaluateMutationSafety(snapshot(), commandName);
    }
  };
}

export function deriveOperationalState({
  mode,
  reconnecting,
  backendHealthy,
  authState,
  realtimeState,
  lastAuthoritativeRefreshAt,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = Date.now()
} = {}) {
  if (mode !== BACKEND_MODES.SUPABASE) return OPERATIONAL_STATES.ONLINE;
  if (reconnecting) return OPERATIONAL_STATES.RECONNECTING;
  if (!backendHealthy) return OPERATIONAL_STATES.OFFLINE;
  if (authState !== AUTH_HEALTH_STATES.AUTHENTICATED) return OPERATIONAL_STATES.DEGRADED;
  if (realtimeState !== REALTIME_HEALTH_STATES.SUBSCRIBED) return OPERATIONAL_STATES.DEGRADED;
  if (!lastAuthoritativeRefreshAt) return OPERATIONAL_STATES.STALE;
  const refreshMs = Date.parse(lastAuthoritativeRefreshAt);
  if (!Number.isFinite(refreshMs) || now - refreshMs > staleAfterMs) return OPERATIONAL_STATES.STALE;
  return OPERATIONAL_STATES.ONLINE;
}

export function evaluateMutationSafety(operationalState = {}, commandName = "AUTHORITATIVE_COMMAND") {
  if (operationalState.mode !== BACKEND_MODES.SUPABASE) {
    return { ok: true, category: "OK", reason: "LOCAL_DEMO", commandName };
  }
  if (!operationalState.backendHealthy || operationalState.state === OPERATIONAL_STATES.OFFLINE) {
    return { ok: false, category: "BACKEND_UNAVAILABLE", reason: "OFFLINE_WRITE_BLOCKED", commandName };
  }
  if (operationalState.authState !== AUTH_HEALTH_STATES.AUTHENTICATED) {
    return { ok: false, category: "UNAUTHENTICATED", reason: "REAUTH_REQUIRED", commandName };
  }
  return {
    ok: true,
    category: operationalState.state === OPERATIONAL_STATES.ONLINE ? "OK" : "DEGRADED",
    reason: operationalState.state === OPERATIONAL_STATES.ONLINE ? "" : "AUTHORITATIVE_WRITE_ALLOWED_WITH_REFETCH_REQUIRED",
    commandName
  };
}

export function createCorrelationId(prefix = "req") {
  const safePrefix = safeCode(prefix, "req").toLowerCase();
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${safePrefix}:${uuid}`;
  return `${safePrefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function sanitizeOperationalDiagnostic(input = {}) {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
    .map(([key, value]) => [key, sanitizeDiagnosticValue(value)]));
}

function sanitizeDiagnosticValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 160);
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeDiagnosticValue);
  if (typeof value === "object") return sanitizeOperationalDiagnostic(value);
  return String(value).slice(0, 160);
}

function safeCode(value, fallback) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9:_-]+/g, "_").slice(0, 120);
  return normalized || fallback;
}

function safeCorrelationId(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9:._-]+/g, "").slice(0, 160);
}
