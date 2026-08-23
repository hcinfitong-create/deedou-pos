import {
  ACTIVATION_COOKIE,
  ACTIVATION_TTL_SECONDS,
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_TTL_SECONDS,
  activationExpiryIso,
  appendSetCookie,
  authenticatedCaller,
  clearCookie,
  firstRow,
  json,
  randomToken,
  readCookie,
  resolveDeviceSession,
  sameOriginAllowed,
  secureCookie,
  sessionExpiryIso,
  sha256,
  verificationCode
} from "./_dd011b.js";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function profileFor(caller) {
  const { data, error } = await caller.serviceClient
    .from("staff_profiles")
    .select("id,username,display_name,active,provisioning_status")
    .eq("auth_user_id", caller.user.id)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function isOwnerProfile(caller, staffProfileId) {
  if (!staffProfileId) return false;
  const { count, error } = await caller.serviceClient
    .from("staff_role_assignments")
    .select("*", { count: "exact", head: true })
    .eq("staff_profile_id", staffProfileId)
    .eq("role_id", "OWNER")
    .eq("active", true);
  return !error && Number(count || 0) === 1;
}

async function activationForCookie(caller, request) {
  const token = readCookie(request, ACTIVATION_COOKIE);
  if (!token) return null;
  const tokenHash = sha256(token);
  const { data, error } = await caller.serviceClient
    .from("staff_activation_requests")
    .select("id,staff_profile_id,status,activation_kind,verification_code,expires_at,location_id,role_id,device_label,workstation_mode")
    .eq("request_token_hash", tokenHash)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { token, tokenHash, row: data };
}

async function completeApprovedActivation(caller, request, response, activation) {
  const sessionToken = randomToken();
  const { data, error } = await caller.serviceClient.rpc("dd011b_service_complete_activation", {
    p_auth_user_id: caller.user.id,
    p_request_token_hash: activation.tokenHash,
    p_session_token_hash: sha256(sessionToken),
    p_session_expires_at: sessionExpiryIso()
  });
  const row = firstRow(data) || {};
  if (error || row.ok !== true) {
    return { ok: false, reason: String(row.reason || error?.message || "ACTIVATION_COMPLETE_FAILED") };
  }
  appendSetCookie(response, secureCookie(DEVICE_SESSION_COOKIE, sessionToken, DEVICE_SESSION_TTL_SECONDS));
  appendSetCookie(response, clearCookie(ACTIVATION_COOKIE));
  return {
    ok: true,
    status: "COMPLETED",
    deviceId: String(row.device_id || ""),
    locationId: String(row.location_id || ""),
    workstationMode: String(row.workstation_mode || "")
  };
}

export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { ok: false, reason: "METHOD_NOT_ALLOWED" });
  if (!sameOriginAllowed(request)) return json(response, 403, { ok: false, reason: "ORIGIN_DENIED" });

  const caller = await authenticatedCaller(request);
  if (!caller.ok) return json(response, 401, caller);
  const body = object(request.body);
  const action = String(body.action || "status").trim();

  if (action === "status") {
    const profile = await profileFor(caller);
    const owner = await isOwnerProfile(caller, profile?.id);
    const device = await resolveDeviceSession(caller, request);
    const activation = await activationForCookie(caller, request);

    if (activation?.row?.status === "APPROVED" && new Date(activation.row.expires_at).getTime() > Date.now()) {
      const completed = await completeApprovedActivation(caller, request, response, activation);
      if (completed.ok) {
        return json(response, 200, {
          ok: true,
          profile,
          isOwner: owner,
          device: completed,
          activation: { status: "COMPLETED" }
        });
      }
    }

    return json(response, 200, {
      ok: true,
      profile,
      isOwner: owner,
      device: device.ok ? {
        active: true,
        deviceId: device.deviceId,
        locationId: device.locationId,
        workstationMode: device.workstationMode
      } : { active: false, reason: device.reason },
      activation: activation ? {
        requestId: activation.row.id,
        status: activation.row.status,
        activationKind: activation.row.activation_kind,
        verificationCode: activation.row.verification_code,
        expiresAt: activation.row.expires_at,
        deviceLabel: activation.row.device_label,
        workstationMode: activation.row.workstation_mode
      } : null
    });
  }

  if (action === "bootstrapOwnerDevice") {
    const { data, error } = await caller.userClient.rpc("dd011b_owner_bootstrap_eligible");
    const eligible = firstRow(data) || {};
    if (error || eligible.ok !== true) {
      return json(response, 403, { ok: false, reason: String(eligible.reason || error?.message || "OWNER_BOOTSTRAP_DENIED") });
    }

    const sessionToken = randomToken();
    const { data: bootstrapData, error: bootstrapError } = await caller.serviceClient.rpc("dd011b_service_bootstrap_owner_device", {
      p_owner_auth_user_id: caller.user.id,
      p_label: String(body.deviceLabel || "Owner Admin").trim().slice(0, 80),
      p_session_token_hash: sha256(sessionToken),
      p_expires_at: sessionExpiryIso()
    });
    const row = firstRow(bootstrapData) || {};
    if (bootstrapError || row.ok !== true) {
      return json(response, 403, { ok: false, reason: String(row.reason || bootstrapError?.message || "OWNER_BOOTSTRAP_FAILED") });
    }

    appendSetCookie(response, secureCookie(DEVICE_SESSION_COOKIE, sessionToken, DEVICE_SESSION_TTL_SECONDS));
    return json(response, 200, {
      ok: true,
      deviceId: String(row.device_id || ""),
      locationId: String(row.location_id || ""),
      workstationMode: "ADMIN"
    });
  }

  if (action === "requestActivation") {
    const existingDevice = await resolveDeviceSession(caller, request);
    if (existingDevice.ok) return json(response, 409, { ok: false, reason: "DEVICE_ALREADY_ACTIVE" });

    const profile = await profileFor(caller);
    if (!profile) return json(response, 403, { ok: false, reason: "STAFF_NOT_FOUND" });
    if (await isOwnerProfile(caller, profile.id)) return json(response, 409, { ok: false, reason: "OWNER_USES_BOOTSTRAP" });

    const deviceLabel = String(body.deviceLabel || "").trim().slice(0, 80);
    const workstationMode = String(body.workstationMode || "").trim().toUpperCase();
    if (!deviceLabel || !["CASHIER", "STAFF", "KDS_KITCHEN", "KDS_BAR", "KDS_DESSERT", "ADMIN"].includes(workstationMode)) {
      return json(response, 400, { ok: false, reason: "VALIDATION_ERROR" });
    }

    const code = verificationCode();
    const activationToken = randomToken();
    const expiresAt = activationExpiryIso();
    const { data, error } = await caller.serviceClient.rpc("dd011b_service_create_activation_request", {
      p_auth_user_id: caller.user.id,
      p_device_label: deviceLabel,
      p_workstation_mode: workstationMode,
      p_verification_code: code,
      p_request_token_hash: sha256(activationToken),
      p_expires_at: expiresAt
    });
    const row = firstRow(data) || {};
    if (error || row.ok !== true) {
      return json(response, 403, { ok: false, reason: String(row.reason || error?.message || "ACTIVATION_REQUEST_FAILED") });
    }

    appendSetCookie(response, secureCookie(ACTIVATION_COOKIE, activationToken, ACTIVATION_TTL_SECONDS));
    return json(response, 200, {
      ok: true,
      requestId: String(row.request_id || ""),
      activationKind: String(row.activation_kind || ""),
      verificationCode: code,
      locationId: String(row.location_id || ""),
      roleId: String(row.role_id || ""),
      expiresAt: row.expires_at || expiresAt
    });
  }

  if (action === "logoutDevice") {
    const token = readCookie(request, DEVICE_SESSION_COOKIE);
    if (token) {
      await caller.serviceClient
        .from("workstation_device_sessions")
        .update({ active: false, revoked_at: new Date().toISOString() })
        .eq("auth_user_id", caller.user.id)
        .eq("session_token_hash", sha256(token));
    }
    appendSetCookie(response, clearCookie(DEVICE_SESSION_COOKIE));
    appendSetCookie(response, clearCookie(ACTIVATION_COOKIE));
    return json(response, 200, { ok: true });
  }

  return json(response, 400, { ok: false, reason: "UNKNOWN_ACTION" });
}
