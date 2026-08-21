import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createCorrelationId } from "./resilience.js";

const DEVICE_CREDENTIAL_KEY = "deedou_device_credential";

export function createAdminOptionsBackendApi(options = {}) {
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
    const correlationId = createCorrelationId("admin-options");
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
    createVariant({ productId, id, variantKey, nameVi, nameEn, priceDeltaVnd = 0, available = true, displayOrder = 0, idempotencyKey, locationId } = {}) {
      return rpc("dd012_create_variant", {
        locationId,
        rpcParams: {
          p_product_id: lower(productId),
          p_variant_id: lower(id),
          p_variant_key: lower(variantKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_price_delta_vnd: integerOrNull(priceDeltaVnd),
          p_available: available !== false,
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    updateVariant({ id, variantKey, nameVi, nameEn, priceDeltaVnd = 0, available = true, displayOrder = 0, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_update_variant", {
        locationId,
        rpcParams: {
          p_variant_id: lower(id),
          p_variant_key: lower(variantKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_price_delta_vnd: integerOrNull(priceDeltaVnd),
          p_available: available !== false,
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    deleteVariant({ id, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_delete_variant", {
        locationId,
        rpcParams: {
          p_variant_id: lower(id),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    createModifierGroup({ id, groupKey, nameVi, nameEn, required = false, multiple = false, minSelect = 0, maxSelect = 1, displayOrder = 0, idempotencyKey, locationId } = {}) {
      return rpc("dd012_create_modifier_group", {
        locationId,
        rpcParams: {
          p_modifier_group_id: lower(id),
          p_group_key: lower(groupKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_required: required === true,
          p_multiple: multiple === true,
          p_min_select: nonNegativeIntegerOrNull(minSelect),
          p_max_select: nonNegativeIntegerOrNull(maxSelect),
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    updateModifierGroup({ id, groupKey, nameVi, nameEn, required = false, multiple = false, minSelect = 0, maxSelect = 1, displayOrder = 0, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_update_modifier_group", {
        locationId,
        rpcParams: {
          p_modifier_group_id: lower(id),
          p_group_key: lower(groupKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_required: required === true,
          p_multiple: multiple === true,
          p_min_select: nonNegativeIntegerOrNull(minSelect),
          p_max_select: nonNegativeIntegerOrNull(maxSelect),
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    deleteModifierGroup({ id, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_delete_modifier_group", {
        locationId,
        rpcParams: {
          p_modifier_group_id: lower(id),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    createModifierOption({ modifierGroupId, id, optionKey, nameVi, nameEn, priceDeltaVnd = 0, available = true, displayOrder = 0, idempotencyKey, locationId } = {}) {
      return rpc("dd012_create_modifier_option", {
        locationId,
        rpcParams: {
          p_modifier_group_id: lower(modifierGroupId),
          p_modifier_option_id: lower(id),
          p_option_key: lower(optionKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_price_delta_vnd: integerOrNull(priceDeltaVnd),
          p_available: available !== false,
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    updateModifierOption({ id, optionKey, nameVi, nameEn, priceDeltaVnd = 0, available = true, displayOrder = 0, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_update_modifier_option", {
        locationId,
        rpcParams: {
          p_modifier_option_id: lower(id),
          p_option_key: lower(optionKey),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_price_delta_vnd: integerOrNull(priceDeltaVnd),
          p_available: available !== false,
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    deleteModifierOption({ id, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_delete_modifier_option", {
        locationId,
        rpcParams: {
          p_modifier_option_id: lower(id),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    setProductModifierGroupAssignment({ productId, modifierGroupId, assigned, displayOrder = 0, expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_set_product_modifier_group_assignment", {
        locationId,
        rpcParams: {
          p_product_id: lower(productId),
          p_modifier_group_id: lower(modifierGroupId),
          p_assigned: assigned === true,
          p_display_order: nonNegativeIntegerOrNull(displayOrder),
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
