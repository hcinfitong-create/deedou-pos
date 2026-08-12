import { BACKEND_MODES, CONNECTION_STATES, getBackendConfig } from "./config.js";

let currentConnectionState = {
  state: CONNECTION_STATES.UNCONFIGURED,
  mode: BACKEND_MODES.LOCAL_DEMO,
  reason: "LOCAL_DEMO_DEFAULT",
  checkedAt: ""
};

const listeners = new Set();

export function getConnectionState() {
  return { ...currentConnectionState };
}

export function subscribeConnectionState(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  listener(getConnectionState());
  return () => listeners.delete(listener);
}

export function createBackendClient(options = {}) {
  const config = getBackendConfig(options.config);
  if (config.mode !== BACKEND_MODES.SUPABASE) {
    updateConnectionState({
      state: CONNECTION_STATES.UNCONFIGURED,
      mode: config.mode,
      reason: config.reason
    });
    return { ok: false, client: null, config, reason: config.reason };
  }

  const factory = resolveSupabaseFactory(options);
  if (typeof factory !== "function") {
    updateConnectionState({
      state: CONNECTION_STATES.ERROR,
      mode: config.mode,
      reason: "SUPABASE_CLIENT_FACTORY_MISSING"
    });
    return { ok: false, client: null, config, reason: "SUPABASE_CLIENT_FACTORY_MISSING" };
  }

  const client = factory(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  updateConnectionState({
    state: CONNECTION_STATES.CONNECTING,
    mode: config.mode,
    reason: "PROBE_REQUIRED"
  });

  return { ok: true, client, config, state: getConnectionState() };
}

export async function probeBackendConnection(client, options = {}) {
  if (!client || typeof client.from !== "function") {
    updateConnectionState({
      state: CONNECTION_STATES.UNCONFIGURED,
      mode: BACKEND_MODES.LOCAL_DEMO,
      reason: "CLIENT_MISSING"
    });
    return getConnectionState();
  }

  updateConnectionState({
    state: CONNECTION_STATES.CONNECTING,
    mode: BACKEND_MODES.SUPABASE,
    reason: "PROBING"
  });

  try {
    const query = client.from(options.healthView || "public_backend_health").select("ok").limit(1);
    const result = typeof query?.then === "function" ? await query : query;
    if (result?.error) {
      updateConnectionState({
        state: CONNECTION_STATES.ERROR,
        mode: BACKEND_MODES.SUPABASE,
        reason: result.error.message || "BACKEND_PROBE_ERROR"
      });
    } else {
      updateConnectionState({
        state: CONNECTION_STATES.ONLINE,
        mode: BACKEND_MODES.SUPABASE,
        reason: "BACKEND_PROBE_OK"
      });
    }
  } catch (error) {
    updateConnectionState({
      state: CONNECTION_STATES.OFFLINE,
      mode: BACKEND_MODES.SUPABASE,
      reason: error?.message || "BACKEND_PROBE_FAILED"
    });
  }

  return getConnectionState();
}

function resolveSupabaseFactory(options = {}) {
  if (typeof options.supabaseFactory === "function") return options.supabaseFactory;
  const root = options.globalObject || globalThis;
  return root?.supabase?.createClient || root?.createClient || null;
}

function updateConnectionState(next) {
  currentConnectionState = {
    ...currentConnectionState,
    ...next,
    checkedAt: new Date().toISOString()
  };
  const snapshot = getConnectionState();
  listeners.forEach((listener) => listener(snapshot));
}
