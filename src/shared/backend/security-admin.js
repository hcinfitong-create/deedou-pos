import { BACKEND_MODES, getBackendConfig } from "./config.js";
import {
  DEVICE_CREDENTIAL_KEY,
  STAFF_LOCATION_KEY,
  WORKSTATION_MODE_KEY,
  readStoredDeviceCredential,
  writeStoredDeviceCredential
} from "../auth/index.js";

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] : value;
}

function rows(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

export function createSecurityAdminApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi;
  const storage = options.storage || globalThis.localStorage;

  async function client() {
    if (config.mode !== BACKEND_MODES.SUPABASE || !authApi?.getClient) {
      throw new Error("SUPABASE_REQUIRED");
    }
    return authApi.getClient();
  }

  function context(overrides = {}) {
    return {
      locationId: text(overrides.locationId || storage?.getItem?.(STAFF_LOCATION_KEY)),
      workstationMode: text(overrides.workstationMode || storage?.getItem?.(WORKSTATION_MODE_KEY)).toUpperCase(),
      deviceCredential: readStoredDeviceCredential(storage)
    };
  }

  async function rpc(name, params = {}) {
    const activeClient = await client();
    const { data, error } = await activeClient.rpc(name, params);
    if (error) return { ok: false, reason: text(error.message || error.code), payload: data };
    return { ok: true, payload: data };
  }

  function privilegedParams(extra = {}, overrides = {}) {
    const ctx = context(overrides);
    return {
      ...extra,
      p_location_id: ctx.locationId,
      p_current_workstation_mode: ctx.workstationMode,
      p_current_device_credential: ctx.deviceCredential
    };
  }

  async function mutation(name, extra = {}, overrides = {}) {
    const result = await rpc(name, privilegedParams(extra, overrides));
    if (!result.ok) return result;
    const row = firstRow(result.payload) || {};
    return { ok: row.ok === true, reason: text(row.reason), row };
  }

  return {
    config,
    context,
    async getMfaState() {
      const activeClient = await client();
      const [{ data: aalData, error: aalError }, { data: factorData, error: factorError }] = await Promise.all([
        activeClient.auth.mfa.getAuthenticatorAssuranceLevel(),
        activeClient.auth.mfa.listFactors()
      ]);
      if (aalError || factorError) return { ok: false, reason: text(aalError?.message || factorError?.message) };
      return {
        ok: true,
        currentLevel: text(aalData?.currentLevel),
        nextLevel: text(aalData?.nextLevel),
        totp: Array.isArray(factorData?.totp) ? factorData.totp : []
      };
    },
    async enrollTotp(friendlyName = "DeeDou Admin") {
      const activeClient = await client();
      const { data, error } = await activeClient.auth.mfa.enroll({ factorType: "totp", friendlyName });
      if (error) return { ok: false, reason: text(error.message) };
      return {
        ok: true,
        factorId: text(data?.id),
        qrCode: text(data?.totp?.qr_code),
        secret: text(data?.totp?.secret),
        uri: text(data?.totp?.uri)
      };
    },
    async challengeAndVerifyTotp({ factorId, code } = {}) {
      const activeClient = await client();
      const challenge = await activeClient.auth.mfa.challenge({ factorId: text(factorId) });
      if (challenge.error) return { ok: false, reason: text(challenge.error.message) };
      const verify = await activeClient.auth.mfa.verify({
        factorId: text(factorId),
        challengeId: text(challenge.data?.id),
        code: text(code)
      });
      if (verify.error) return { ok: false, reason: text(verify.error.message) };
      const aal = await activeClient.auth.mfa.getAuthenticatorAssuranceLevel();
      return {
        ok: !aal.error && aal.data?.currentLevel === "aal2",
        reason: text(aal.error?.message),
        currentLevel: text(aal.data?.currentLevel)
      };
    },
    async listStaff(overrides = {}) {
      const ctx = context(overrides);
      const result = await rpc("dd011_list_staff_admin", {
        p_location_id: ctx.locationId,
        p_workstation_mode: ctx.workstationMode,
        p_device_credential: ctx.deviceCredential
      });
      return { ok: result.ok, reason: result.reason, rows: rows(result.payload) };
    },
    async listRoles(overrides = {}) {
      const ctx = context(overrides);
      const result = await rpc("dd011_list_roles_admin", {
        p_location_id: ctx.locationId,
        p_workstation_mode: ctx.workstationMode,
        p_device_credential: ctx.deviceCredential
      });
      return { ok: result.ok, reason: result.reason, rows: rows(result.payload) };
    },
    async linkStaffByEmail({ email, displayName } = {}, overrides = {}) {
      return mutation("dd011_link_staff_by_email", {
        p_email: text(email),
        p_display_name: text(displayName)
      }, overrides);
    },
    async assignRole({ staffProfileId, roleId } = {}, overrides = {}) {
      return mutation("assign_staff_role_at_location", {
        p_target_staff_profile_id: text(staffProfileId),
        p_role_id: text(roleId)
      }, overrides);
    },
    async revokeRole({ staffProfileId, roleId } = {}, overrides = {}) {
      return mutation("dd011_revoke_staff_role_at_location", {
        p_target_staff_profile_id: text(staffProfileId),
        p_role_id: text(roleId)
      }, overrides);
    },
    async setStaffActive({ staffProfileId, active } = {}, overrides = {}) {
      return mutation("dd011_set_staff_active", {
        p_target_staff_profile_id: text(staffProfileId),
        p_active: active === true
      }, overrides);
    },
    async setLocationActive({ staffProfileId, active } = {}, overrides = {}) {
      return mutation("dd011_set_staff_location_active", {
        p_target_staff_profile_id: text(staffProfileId),
        p_active: active === true
      }, overrides);
    },
    async listDevices(overrides = {}) {
      const ctx = context(overrides);
      const result = await rpc("dd011_list_devices_admin", {
        p_location_id: ctx.locationId,
        p_workstation_mode: ctx.workstationMode,
        p_device_credential: ctx.deviceCredential
      });
      return { ok: result.ok, reason: result.reason, rows: rows(result.payload) };
    },
    async registerDevice({ label, mode, activateThisBrowser = false } = {}, overrides = {}) {
      const result = await mutation("register_workstation_device", {
        p_label: text(label),
        p_mode: text(mode).toUpperCase()
      }, overrides);
      if (!result.ok) return result;
      const credential = text(result.row?.device_credential);
      if (activateThisBrowser && credential) {
        const ctx = context(overrides);
        writeStoredDeviceCredential(storage, credential);
        storage?.setItem?.(STAFF_LOCATION_KEY, ctx.locationId);
        storage?.setItem?.(WORKSTATION_MODE_KEY, text(mode).toUpperCase());
      }
      return { ...result, deviceId: text(result.row?.device_id), deviceCredential: credential };
    },
    async rotateDevice({ deviceId, currentDevice = false } = {}, overrides = {}) {
      const result = await mutation("dd011_rotate_workstation_device", {
        p_device_id: text(deviceId)
      }, overrides);
      if (!result.ok) return result;
      const credential = text(result.row?.device_credential);
      if (currentDevice && credential) writeStoredDeviceCredential(storage, credential);
      return { ...result, deviceId: text(result.row?.device_id), deviceCredential: credential };
    },
    async revokeDevice({ deviceId } = {}, overrides = {}) {
      return mutation("revoke_workstation_device", { p_device_id: text(deviceId) }, overrides);
    },
    async touchCurrentDevice(overrides = {}) {
      const ctx = context(overrides);
      const result = await rpc("dd011_touch_current_device", {
        p_location_id: ctx.locationId,
        p_workstation_mode: ctx.workstationMode,
        p_device_credential: ctx.deviceCredential
      });
      const row = firstRow(result.payload) || {};
      return { ok: result.ok && row.ok === true, reason: text(result.reason || row.reason), row };
    },
    async activateCredential({ credential, locationId, workstationMode } = {}) {
      const normalizedCredential = text(credential);
      const normalizedLocation = text(locationId);
      const normalizedMode = text(workstationMode).toUpperCase();
      const activeClient = await client();
      const { data, error } = await activeClient.rpc("get_my_staff_context", {
        p_location_id: normalizedLocation,
        p_workstation_mode: normalizedMode,
        p_device_credential: normalizedCredential
      });
      if (error || rows(data).length === 0) return { ok: false, reason: text(error?.message || "DEVICE_UNREGISTERED") };
      writeStoredDeviceCredential(storage, normalizedCredential);
      storage?.setItem?.(STAFF_LOCATION_KEY, normalizedLocation);
      storage?.setItem?.(WORKSTATION_MODE_KEY, normalizedMode);
      return { ok: true, reason: "" };
    },
    clearDeviceCredential() {
      storage?.removeItem?.(DEVICE_CREDENTIAL_KEY);
    }
  };
}
