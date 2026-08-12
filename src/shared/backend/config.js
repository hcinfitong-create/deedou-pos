export const BACKEND_MODES = Object.freeze({
  LOCAL_DEMO: "LOCAL_DEMO",
  SUPABASE: "SUPABASE"
});

export const CONNECTION_STATES = Object.freeze({
  UNCONFIGURED: "UNCONFIGURED",
  CONNECTING: "CONNECTING",
  ONLINE: "ONLINE",
  OFFLINE: "OFFLINE",
  ERROR: "ERROR"
});

export const BACKEND_CONFIG_KEYS = Object.freeze({
  MODE: "DEEDOU_BACKEND_MODE",
  SUPABASE_URL: "DEEDOU_SUPABASE_URL",
  SUPABASE_PUBLISHABLE_KEY: "DEEDOU_SUPABASE_PUBLISHABLE_KEY"
});

const SECRET_FIELD_NAMES = Object.freeze([
  "serviceRoleKey",
  "service_role_key",
  "supabaseServiceRoleKey",
  "secretKey",
  "jwtSecret",
  "databasePassword",
  "dbPassword",
  "accessToken",
  "privateKey"
]);

const SECRET_VALUE_PATTERNS = Object.freeze([
  /service[_-]?role/i,
  /supabase[_-]?secret/i,
  /\bsb_secret_/i,
  /\bsecret\b/i,
  /postgres(?:ql)?:\/\//i,
  /BEGIN [A-Z ]*PRIVATE KEY/i,
  /\bjwt[_-]?secret\b/i
]);

export function getBackendMode(input) {
  return getBackendConfig(input).mode;
}

export function getBackendConfig(input = readRuntimeBackendConfig()) {
  const raw = normalizeInput(input);
  const requestedMode = normalizeMode(raw.mode || raw[BACKEND_CONFIG_KEYS.MODE]);
  const supabaseUrl = normalizeText(raw.supabaseUrl || raw.url || raw[BACKEND_CONFIG_KEYS.SUPABASE_URL]);
  const supabasePublishableKey = normalizeText(
    raw.supabasePublishableKey
      || raw.supabaseAnonKey
      || raw.anonKey
      || raw.publishableKey
      || raw[BACKEND_CONFIG_KEYS.SUPABASE_PUBLISHABLE_KEY]
  );
  const safety = validatePublicBackendConfig(raw);

  if (!safety.ok) {
    return localDemoConfig(safety.reason);
  }

  if (requestedMode !== BACKEND_MODES.SUPABASE) {
    return localDemoConfig("LOCAL_DEMO_DEFAULT");
  }

  if (!supabaseUrl || !supabasePublishableKey) {
    return localDemoConfig("SUPABASE_CONFIG_INCOMPLETE");
  }

  if (!isSafeSupabaseUrl(supabaseUrl)) {
    return localDemoConfig("SUPABASE_URL_UNSAFE");
  }

  return {
    mode: BACKEND_MODES.SUPABASE,
    reason: "",
    isConfigured: true,
    supabaseUrl,
    supabasePublishableKey
  };
}

export function validatePublicBackendConfig(input = {}) {
  const raw = normalizeInput(input);
  const unsafeField = SECRET_FIELD_NAMES.find((field) => normalizeText(raw[field]));
  if (unsafeField) return { ok: false, reason: "SECRET_FIELD_IN_BROWSER_CONFIG", field: unsafeField };

  const unsafeValue = Object.entries(raw).find(([, value]) => {
    const text = normalizeText(value);
    return text && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
  });
  if (unsafeValue) return { ok: false, reason: "SECRET_VALUE_IN_BROWSER_CONFIG", field: unsafeValue[0] };

  return { ok: true, reason: "" };
}

export function readRuntimeBackendConfig(root = globalThis) {
  const source = root?.DEEDOU_BACKEND_CONFIG
    || root?.__DEEDOU_BACKEND_CONFIG__
    || root?.window?.DEEDOU_BACKEND_CONFIG
    || root?.window?.__DEEDOU_BACKEND_CONFIG__
    || {};
  return normalizeInput(source);
}

function localDemoConfig(reason) {
  return {
    mode: BACKEND_MODES.LOCAL_DEMO,
    reason,
    isConfigured: false,
    supabaseUrl: "",
    supabasePublishableKey: ""
  };
}

function normalizeInput(input) {
  return input && typeof input === "object" ? input : {};
}

function normalizeMode(value) {
  const mode = normalizeText(value).toUpperCase();
  return mode === BACKEND_MODES.SUPABASE ? BACKEND_MODES.SUPABASE : BACKEND_MODES.LOCAL_DEMO;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isSafeSupabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
