import {
  authenticatedCaller,
  json,
  resolveDeviceSession,
  sameOriginAllowed
} from "./_dd011b.js";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function postgrestError(response, status, reason, code = "DD011B") {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  return response.status(status).json({
    code,
    details: null,
    hint: null,
    message: String(reason || "STAFF_RPC_FAILED").slice(0, 200)
  });
}

export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { ok: false, reason: "METHOD_NOT_ALLOWED" });
  if (!sameOriginAllowed(request)) return postgrestError(response, 403, "ORIGIN_DENIED");

  const caller = await authenticatedCaller(request);
  if (!caller.ok) return postgrestError(response, 401, caller.reason, "AUTH_REQUIRED");

  const device = await resolveDeviceSession(caller, request);
  if (!device.ok) return postgrestError(response, 403, device.reason, "DEVICE_SESSION_REQUIRED");

  const body = object(request.body);
  const functionName = String(body.functionName || "").trim();
  const params = object(body.params);
  if (!/^[a-z0-9_]{3,96}$/.test(functionName)) {
    return postgrestError(response, 400, "INVALID_RPC_NAME", "VALIDATION_ERROR");
  }

  const carriesDeviceProof = Object.prototype.hasOwnProperty.call(params, "p_device_credential")
    || Object.prototype.hasOwnProperty.call(params, "p_current_device_credential");
  if (!carriesDeviceProof) {
    return postgrestError(response, 403, "STAFF_RPC_DEVICE_PROOF_REQUIRED", "FORBIDDEN");
  }

  const safeParams = { ...params };
  if (Object.prototype.hasOwnProperty.call(safeParams, "p_device_credential")) {
    safeParams.p_device_credential = device.deviceCredential;
  }
  if (Object.prototype.hasOwnProperty.call(safeParams, "p_current_device_credential")) {
    safeParams.p_current_device_credential = device.deviceCredential;
  }
  if (Object.prototype.hasOwnProperty.call(safeParams, "p_workstation_mode")) {
    safeParams.p_workstation_mode = device.workstationMode;
  }
  if (Object.prototype.hasOwnProperty.call(safeParams, "p_current_workstation_mode")) {
    safeParams.p_current_workstation_mode = device.workstationMode;
  }
  if (Object.prototype.hasOwnProperty.call(safeParams, "p_location_id")) {
    safeParams.p_location_id = device.locationId;
  }

  const { data, error } = await caller.userClient.rpc(functionName, safeParams);
  if (error) {
    const status = String(error.code || "").includes("42501") ? 403 : 400;
    return postgrestError(response, status, error.message || error.code || "RPC_FAILED", error.code || "RPC_FAILED");
  }

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  return response.status(200).json(data);
}
