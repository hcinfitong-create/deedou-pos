function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isSafeSupabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeJwtPayload(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isBrowserPublishableKey(value) {
  if (value.startsWith("sb_publishable_")) return true;
  const payload = decodeJwtPayload(value);
  return normalizeText(payload?.role).toLowerCase() === "anon";
}

export function buildRuntimeBackendConfig(env = process.env) {
  const mode = normalizeText(env.DEEDOU_BACKEND_MODE).toUpperCase();
  const supabaseUrl = normalizeText(env.DEEDOU_SUPABASE_URL);
  const supabasePublishableKey = normalizeText(env.DEEDOU_SUPABASE_PUBLISHABLE_KEY);

  if (
    mode !== "SUPABASE"
    || !isSafeSupabaseUrl(supabaseUrl)
    || !isBrowserPublishableKey(supabasePublishableKey)
  ) {
    return { mode: "LOCAL_DEMO" };
  }

  return {
    mode: "SUPABASE",
    supabaseUrl,
    supabasePublishableKey
  };
}

export function serializeRuntimeBackendConfig(config) {
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return [
    `window.DEEDOU_BACKEND_CONFIG = Object.freeze(${serialized});`,
    "window.__DEEDOU_BACKEND_CONFIG__ = window.DEEDOU_BACKEND_CONFIG;",
    ""
  ].join("\n");
}

export default function handler(_request, response) {
  const config = buildRuntimeBackendConfig();
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(200).send(serializeRuntimeBackendConfig(config));
}
