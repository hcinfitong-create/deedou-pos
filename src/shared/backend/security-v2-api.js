import { createSupabasePasswordAuthApi } from "../auth/index.js";
import { BACKEND_MODES, getBackendConfig } from "./config.js";

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function createSecurityV2Api(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi || createSupabasePasswordAuthApi({ config, storage: globalThis.localStorage, deviceStorage: null });
  const fetchFn = options.fetch || globalThis.fetch;

  async function accessToken() {
    const client = await authApi.getClient?.();
    const { data, error } = await client?.auth?.getSession?.() || {};
    if (error || !data?.session?.access_token) return "";
    return data.session.access_token;
  }

  async function call(path, payload = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE || typeof fetchFn !== "function") {
      return { ok: false, reason: "SUPABASE_REQUIRED" };
    }
    const token = await accessToken();
    if (!token) return { ok: false, reason: "SIGN_IN_REQUIRED" };
    const response = await fetchFn(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) return { ok: false, reason: text(body?.reason || `HTTP_${response.status}`), ...body };
    return body && typeof body === "object" ? body : { ok: true };
  }

  async function client() {
    return authApi.getClient?.();
  }

  return {
    config,
    authApi,
    status() { return call("/api/security", { action: "status" }); },
    requestActivation({ deviceLabel, workstationMode } = {}) {
      return call("/api/security", { action: "requestActivation", deviceLabel: text(deviceLabel), workstationMode: text(workstationMode).toUpperCase() });
    },
    bootstrapOwnerDevice({ deviceLabel = "Owner Admin" } = {}) {
      return call("/api/security", { action: "bootstrapOwnerDevice", deviceLabel: text(deviceLabel) });
    },
    logoutDevice() { return call("/api/security", { action: "logoutDevice" }); },
    securitySnapshot() { return call("/api/security-admin", { action: "snapshot" }); },
    createStaff({ displayName, username, password, roleId, locationId } = {}) {
      return call("/api/security-admin", { action: "createStaff", displayName: text(displayName), username: text(username), password: String(password || ""), roleId: text(roleId), locationId: text(locationId) });
    },
    approveActivation(requestId) { return call("/api/security-admin", { action: "approveActivation", requestId: text(requestId) }); },
    rejectActivation(requestId) { return call("/api/security-admin", { action: "rejectActivation", requestId: text(requestId) }); },
    setStaffActive(staffProfileId, active) { return call("/api/security-admin", { action: "setStaffActive", staffProfileId: text(staffProfileId), active: active === true }); },
    setLocationActive(staffProfileId, active) { return call("/api/security-admin", { action: "setLocationActive", staffProfileId: text(staffProfileId), active: active === true }); },
    assignRole(staffProfileId, roleId) { return call("/api/security-admin", { action: "assignRole", staffProfileId: text(staffProfileId), roleId: text(roleId) }); },
    revokeRole(staffProfileId, roleId) { return call("/api/security-admin", { action: "revokeRole", staffProfileId: text(staffProfileId), roleId: text(roleId) }); },
    revokeDevice(deviceId) { return call("/api/security-admin", { action: "revokeDevice", deviceId: text(deviceId) }); },
    async getMfaState() {
      const activeClient = await client();
      const [{ data: aalData, error: aalError }, { data: factorData, error: factorError }] = await Promise.all([
        activeClient.auth.mfa.getAuthenticatorAssuranceLevel(),
        activeClient.auth.mfa.listFactors()
      ]);
      if (aalError || factorError) return { ok: false, reason: text(aalError?.message || factorError?.message) };
      return { ok: true, currentLevel: text(aalData?.currentLevel), nextLevel: text(aalData?.nextLevel), totp: Array.isArray(factorData?.totp) ? factorData.totp : [] };
    },
    async enrollTotp(friendlyName = "DeeDou Owner") {
      const activeClient = await client();
      const { data, error } = await activeClient.auth.mfa.enroll({ factorType: "totp", friendlyName });
      if (error) return { ok: false, reason: text(error.message) };
      return { ok: true, factorId: text(data?.id), qrCode: text(data?.totp?.qr_code), secret: text(data?.totp?.secret) };
    },
    async verifyTotp({ factorId, code } = {}) {
      const activeClient = await client();
      const challenge = await activeClient.auth.mfa.challenge({ factorId: text(factorId) });
      if (challenge.error) return { ok: false, reason: text(challenge.error.message) };
      const verify = await activeClient.auth.mfa.verify({ factorId: text(factorId), challengeId: text(challenge.data?.id), code: text(code) });
      if (verify.error) return { ok: false, reason: text(verify.error.message) };
      const aal = await activeClient.auth.mfa.getAuthenticatorAssuranceLevel();
      return { ok: !aal.error && aal.data?.currentLevel === "aal2", reason: text(aal.error?.message), currentLevel: text(aal.data?.currentLevel) };
    }
  };
}
