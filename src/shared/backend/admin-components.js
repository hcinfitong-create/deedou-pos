import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createCorrelationId } from "./resilience.js";

const DEVICE_CREDENTIAL_KEY = "deedou_device_credential";

export function createAdminComponentsBackendApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi || null;
  const deviceStorage = options.deviceStorage || globalThis.localStorage;
  const authStateRef = typeof options.authStateRef === "function" ? options.authStateRef : () => ({});

  function authorityContext(locationId = "") {
    const authState = authStateRef() || {};
    return {
      locationId: text(locationId || authState.locationId || "deedou-demo"),
      workstationMode: text(authState.authorization?.workstationMode || authState.workstationMode || "ADMIN") || "ADMIN",
      credential: readCredential(deviceStorage)
    };
  }

  async function rpc(functionName, { locationId = "", rpcParams = {} } = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE) return failure("BACKEND_UNAVAILABLE", "SUPABASE_REQUIRED");
    const client = await authApi?.getClient?.();
    if (!client?.rpc) return failure("BACKEND_UNAVAILABLE", "SUPABASE_CLIENT_MISSING");
    const context = authorityContext(locationId);
    if (!context.locationId || !context.credential) return failure("FORBIDDEN", "ADMIN_CONTEXT_INCOMPLETE");
    const correlationId = createCorrelationId("admin-components");
    const { data, error } = await client.rpc(functionName, {
      p_location_id: context.locationId,
      p_workstation_mode: context.workstationMode,
      p_device_credential: context.credential,
      ...rpcParams
    });
    if (error) return failure(categoryForError(error), sanitizeReason(error.message || error.code), correlationId);
    return normalizeResult(data, correlationId);
  }

  return {
    createComponent({ parentProductId, id, componentKey, nameVi, nameEn, qty, stationCode, displayOrder = 0, idempotencyKey, locationId } = {}) {
      return rpc("dd012_create_product_component", {
        locationId,
        rpcParams: {
          p_parent_product_id: lower(parentProductId),
          p_component_id: lower(id),
          p_component_key: lower(componentKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_qty: positiveIntegerOrNull(qty),
          p_station_code: text(stationCode).toUpperCase(),
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    updateComponent({ id, componentKey, nameVi, nameEn, qty, stationCode, displayOrder = 0, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_update_product_component", {
        locationId,
        rpcParams: {
          p_component_id: lower(id),
          p_component_key: lower(componentKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_qty: positiveIntegerOrNull(qty),
          p_station_code: text(stationCode).toUpperCase(),
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    deleteComponent({ id, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_delete_product_component", {
        locationId,
        rpcParams: {
          p_component_id: lower(id),
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

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function positiveIntegerOrNull(value) {
  const number = integerOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegativeIntegerOrNull(value) {
  const number = integerOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function lower(value) {
  return text(value).toLowerCase();
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
