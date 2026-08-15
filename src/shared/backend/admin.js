import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createCorrelationId } from "./resilience.js";

const DEVICE_CREDENTIAL_KEY = "deedou_device_credential";

export function createAdminBackendApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi || null;
  const deviceStorage = options.deviceStorage || globalThis.localStorage;
  const authStateRef = typeof options.authStateRef === "function" ? options.authStateRef : () => ({});

  async function rpc(functionName, params = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE) return failure("BACKEND_UNAVAILABLE", "SUPABASE_REQUIRED");
    const client = await authApi?.getClient?.();
    if (!client?.rpc) return failure("BACKEND_UNAVAILABLE", "SUPABASE_CLIENT_MISSING");
    const authState = authStateRef() || {};
    const locationId = text(params.locationId || authState.locationId || "deedou-demo");
    const workstationMode = text(authState.authorization?.workstationMode || authState.workstationMode || "ADMIN") || "ADMIN";
    const credential = readCredential(deviceStorage);
    if (!locationId || !credential) return failure("FORBIDDEN", "ADMIN_CONTEXT_INCOMPLETE");
    const correlationId = createCorrelationId("admin");
    const { data, error } = await client.rpc(functionName, {
      p_location_id: locationId,
      p_workstation_mode: workstationMode,
      p_device_credential: credential,
      ...params.rpcParams
    });
    if (error) return failure(categoryForError(error), sanitizeReason(error.message || error.code), correlationId);
    return normalizeResult(data, correlationId);
  }

  return {
    fetchMenu({ locationId } = {}) {
      return rpc("dd008d_get_admin_menu_snapshot", { locationId });
    },
    setProductAvailability({ productId, available, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd008d_set_product_availability", {
        locationId,
        rpcParams: {
          p_product_id: text(productId),
          p_available: available === true,
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    }
  };
}

function normalizeResult(data, correlationId) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return failure("BACKEND_UNAVAILABLE", "EMPTY_RPC_RESULT", correlationId);
  return {
    ok: row.ok === true,
    category: text(row.category || (row.ok ? "OK" : "VALIDATION_ERROR")),
    reason: sanitizeReason(row.reason),
    entityType: text(row.entity_type || row.entityType),
    entityId: text(row.entity_id || row.entityId),
    version: row.version ?? null,
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    correlationId
  };
}

function failure(category, reason, correlationId = "") {
  return { ok: false, category, reason, entityType: "", entityId: "", version: null, payload: {}, correlationId };
}

function readCredential(storage) {
  try {
    return text(storage?.getItem?.(DEVICE_CREDENTIAL_KEY));
  } catch {
    return "";
  }
}

function categoryForError(error = {}) {
  const message = `${error.code || ""} ${error.message || ""}`.toLowerCase();
  if (message.includes("jwt") || message.includes("auth")) return "UNAUTHENTICATED";
  if (message.includes("permission") || message.includes("forbidden") || message.includes("42501")) return "FORBIDDEN";
  return "BACKEND_UNAVAILABLE";
}

function sanitizeReason(value) {
  return text(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer_[REDACTED]")
    .replace(/[^A-Za-z0-9:_-]+/g, "_")
    .slice(0, 160);
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
