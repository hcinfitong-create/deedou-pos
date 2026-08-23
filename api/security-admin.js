import {
  authenticatedCaller,
  firstRow,
  isValidUsername,
  json,
  normalizeUsername,
  requireOwnerDevice,
  sameOriginAllowed,
  staffLoginEmail
} from "./_dd011b.js";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return String(value || "").trim();
}

async function ownerRpc(caller, owner, functionName, params) {
  const { data, error } = await caller.userClient.rpc(functionName, {
    ...params,
    p_location_id: owner.locationId,
    p_current_workstation_mode: owner.device.workstationMode,
    p_current_device_credential: owner.device.deviceCredential
  });
  const row = firstRow(data) || {};
  if (error) return { ok: false, reason: text(error.message || error.code) };
  return { ok: row.ok === true, reason: text(row.reason), row };
}

export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { ok: false, reason: "METHOD_NOT_ALLOWED" });
  if (!sameOriginAllowed(request)) return json(response, 403, { ok: false, reason: "ORIGIN_DENIED" });

  const caller = await authenticatedCaller(request);
  if (!caller.ok) return json(response, 401, caller);
  const owner = await requireOwnerDevice(caller, request);
  if (!owner.ok) return json(response, 403, { ok: false, reason: owner.reason });

  const body = object(request.body);
  const action = text(body.action || "snapshot");

  if (action === "snapshot") {
    const { data, error } = await caller.serviceClient.rpc("dd011b_service_owner_security_snapshot", {
      p_owner_auth_user_id: caller.user.id
    });
    if (error || data?.ok === false) return json(response, 403, { ok: false, reason: text(data?.reason || error?.message || "SECURITY_SNAPSHOT_FAILED") });
    return json(response, 200, data || { ok: true, staff: [], pendingActivations: [], devices: [], roles: [] });
  }

  if (action === "createStaff") {
    const username = normalizeUsername(body.username);
    const displayName = text(body.displayName).slice(0, 120);
    const password = String(body.password || "");
    const roleId = text(body.roleId).toUpperCase();
    const locationId = text(body.locationId || owner.locationId);

    if (!isValidUsername(username) || !displayName || password.length < 10 || password.length > 128) {
      return json(response, 400, { ok: false, reason: "VALIDATION_ERROR" });
    }
    if (roleId === "OWNER") return json(response, 403, { ok: false, reason: "SINGLE_OWNER_ENFORCED" });
    if (locationId !== owner.locationId) return json(response, 403, { ok: false, reason: "LOCATION_DENIED" });

    const email = staffLoginEmail(username);
    const { data: created, error: createError } = await caller.serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { deedou_username: username, display_name: displayName }
    });
    if (createError || !created?.user?.id) {
      const reason = /already|registered|exists/i.test(createError?.message || "") ? "USERNAME_EXISTS" : "AUTH_USER_CREATE_FAILED";
      return json(response, 409, { ok: false, reason });
    }

    const { data, error } = await caller.serviceClient.rpc("dd011b_service_create_pending_staff", {
      p_owner_auth_user_id: caller.user.id,
      p_target_auth_user_id: created.user.id,
      p_username: username,
      p_display_name: displayName,
      p_location_id: locationId,
      p_role_id: roleId
    });
    const row = firstRow(data) || {};
    if (error || row.ok !== true) {
      await caller.serviceClient.auth.admin.deleteUser(created.user.id).catch(() => {});
      return json(response, 409, { ok: false, reason: text(row.reason || error?.message || "STAFF_CREATE_FAILED") });
    }

    return json(response, 200, {
      ok: true,
      staffProfileId: text(row.staff_profile_id),
      username,
      displayName,
      roleId,
      locationId,
      provisioningStatus: "PENDING_FIRST_LOGIN"
    });
  }

  if (action === "approveActivation" || action === "rejectActivation") {
    const requestId = text(body.requestId);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json(response, 400, { ok: false, reason: "VALIDATION_ERROR" });
    const rpcName = action === "approveActivation" ? "dd011b_service_approve_activation" : "dd011b_service_reject_activation";
    const { data, error } = await caller.serviceClient.rpc(rpcName, {
      p_owner_auth_user_id: caller.user.id,
      p_request_id: requestId
    });
    const row = firstRow(data) || {};
    if (error || row.ok !== true) return json(response, 409, { ok: false, reason: text(row.reason || error?.message || "ACTIVATION_MUTATION_FAILED") });
    return json(response, 200, { ok: true });
  }

  if (action === "setStaffActive") {
    const targetStaffProfileId = text(body.staffProfileId);
    const active = body.active === true;
    const result = await ownerRpc(caller, owner, "dd011_set_staff_active", {
      p_target_staff_profile_id: targetStaffProfileId,
      p_active: active
    });
    return json(response, result.ok ? 200 : 403, result);
  }

  if (action === "setLocationActive") {
    const result = await ownerRpc(caller, owner, "dd011_set_staff_location_active", {
      p_target_staff_profile_id: text(body.staffProfileId),
      p_active: body.active === true
    });
    return json(response, result.ok ? 200 : 403, result);
  }

  if (action === "assignRole") {
    const roleId = text(body.roleId).toUpperCase();
    if (roleId === "OWNER") return json(response, 403, { ok: false, reason: "SINGLE_OWNER_ENFORCED" });
    const result = await ownerRpc(caller, owner, "assign_staff_role_at_location", {
      p_target_staff_profile_id: text(body.staffProfileId),
      p_role_id: roleId
    });
    return json(response, result.ok ? 200 : 403, result);
  }

  if (action === "revokeRole") {
    const roleId = text(body.roleId).toUpperCase();
    if (roleId === "OWNER") return json(response, 403, { ok: false, reason: "SOLE_OWNER_PROTECTED" });
    const result = await ownerRpc(caller, owner, "dd011_revoke_staff_role_at_location", {
      p_target_staff_profile_id: text(body.staffProfileId),
      p_role_id: roleId
    });
    return json(response, result.ok ? 200 : 403, result);
  }

  if (action === "revokeDevice") {
    const result = await ownerRpc(caller, owner, "revoke_workstation_device", {
      p_device_id: text(body.deviceId)
    });
    return json(response, result.ok ? 200 : 403, result);
  }

  return json(response, 400, { ok: false, reason: "UNKNOWN_ACTION" });
}
