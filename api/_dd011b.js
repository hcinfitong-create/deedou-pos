import { createHash, randomBytes, randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const DEVICE_SESSION_COOKIE = "__Host-deedou_device_session";
export const ACTIVATION_COOKIE = "__Host-deedou_activation";
export const DEVICE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const ACTIVATION_TTL_SECONDS = 5 * 60;

export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function isValidUsername(value) {
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(normalizeUsername(value));
}

export function staffLoginEmail(value) {
  const username = normalizeUsername(value);
  return isValidUsername(username) ? `${username}@staff.deedou.invalid` : "";
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function verificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function readCookie(request, name) {
  const raw = String(request?.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function secureCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function appendSetCookie(response, cookie) {
  const existing = response.getHeader?.("Set-Cookie");
  const values = Array.isArray(existing) ? existing : existing ? [existing] : [];
  response.setHeader("Set-Cookie", [...values, cookie]);
}

export function json(response, status, body) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(body);
}

export function serviceError(response, status, reason) {
  return json(response, status, { ok: false, reason: String(reason || "SECURITY_REQUEST_FAILED").slice(0, 160) });
}

export function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHostname(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function allowedBackendUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname));
  } catch {
    return false;
  }
}

export function backendConfig(env = process.env) {
  const supabaseUrl = String(env.DEEDOU_SUPABASE_URL || env.SUPABASE_URL || "").trim();
  const publishableKey = String(env.DEEDOU_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  const serviceRoleKey = String(env.DEEDOU_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!allowedBackendUrl(supabaseUrl) || !publishableKey || !serviceRoleKey) return null;
  return { supabaseUrl, publishableKey, serviceRoleKey };
}

export function bearerToken(request) {
  const header = String(request?.headers?.authorization || "").trim();
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

export function sameOriginAllowed(request) {
  const origin = String(request?.headers?.origin || "").trim();
  if (!origin) return true;
  const forwardedHost = String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "").split(",")[0].trim();
  if (!forwardedHost) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== forwardedHost) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export async function authenticatedCaller(request, env = process.env) {
  const config = backendConfig(env);
  if (!config) return { ok: false, reason: "BACKEND_SECURITY_CONFIG_MISSING" };
  const token = bearerToken(request);
  if (!token) return { ok: false, reason: "SIGN_IN_REQUIRED" };

  const userClient = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const serviceClient = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user?.id) return { ok: false, reason: "SIGN_IN_REQUIRED" };
  return { ok: true, token, user: data.user, userClient, serviceClient, config };
}

export async function ownerContext(caller) {
  const { data, error } = await caller.userClient.rpc("dd011b_owner_context");
  const row = firstRow(data) || {};
  if (error) return { ok: false, reason: error.message || error.code || "OWNER_CONTEXT_FAILED" };
  return {
    ok: row.ok === true,
    reason: String(row.reason || ""),
    staffProfileId: String(row.staff_profile_id || ""),
    locationId: String(row.location_id || "")
  };
}

export async function resolveDeviceSession(caller, request) {
  const token = readCookie(request, DEVICE_SESSION_COOKIE);
  if (!token) return { ok: false, reason: "DEVICE_SESSION_REQUIRED" };
  const { data, error } = await caller.serviceClient.rpc("dd011b_service_resolve_device_session", {
    p_auth_user_id: caller.user.id,
    p_session_token_hash: sha256(token)
  });
  const row = firstRow(data) || {};
  if (error || row.ok !== true) return { ok: false, reason: String(row.reason || error?.message || "DEVICE_SESSION_REQUIRED") };
  return {
    ok: true,
    staffProfileId: String(row.staff_profile_id || ""),
    deviceId: String(row.device_id || ""),
    locationId: String(row.location_id || ""),
    workstationMode: String(row.workstation_mode || ""),
    deviceCredential: String(row.device_credential || "")
  };
}

export async function requireOwnerDevice(caller, request) {
  const [owner, device] = await Promise.all([ownerContext(caller), resolveDeviceSession(caller, request)]);
  if (!owner.ok) return owner;
  if (!device.ok) return device;
  if (owner.staffProfileId !== device.staffProfileId || owner.locationId !== device.locationId) {
    return { ok: false, reason: "OWNER_DEVICE_MISMATCH" };
  }
  return { ok: true, ...owner, device };
}

export function sessionExpiryIso(ttlSeconds = DEVICE_SESSION_TTL_SECONDS) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

export function activationExpiryIso() {
  return new Date(Date.now() + ACTIVATION_TTL_SECONDS * 1000).toISOString();
}
