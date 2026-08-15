import { BACKEND_MODES, getBackendConfig } from "./config.js";

export const COMMAND_FAILURE_CATEGORIES = Object.freeze({
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  INVALID_STATE: "INVALID_STATE",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  VALIDATION_ERROR: "VALIDATION_ERROR"
});

const DEVICE_CREDENTIAL_KEY = "deedou_device_credential";

const STAFF_COMMAND_PARAMS = Object.freeze({
  locationId: "p_location_id",
  workstationMode: "p_workstation_mode",
  deviceCredential: "p_device_credential"
});

export function createAuthoritativeBackendApi(options = {}) {
  const config = getBackendConfig(options.config);
  const authApi = options.authApi || null;
  const deviceStorage = options.deviceStorage || safeLocalStorage();
  const authStateRef = options.authStateRef || (() => ({}));

  async function getClient() {
    if (config.mode !== BACKEND_MODES.SUPABASE) return null;
    if (typeof authApi?.getClient === "function") return authApi.getClient();
    if (authApi?.client) return authApi.client;
    return null;
  }

  async function rpc(functionName, params = {}) {
    const client = await getClient();
    if (!client || typeof client.rpc !== "function") {
      return commandFailure("BACKEND_UNAVAILABLE", "SUPABASE_CLIENT_UNAVAILABLE");
    }
    const { data, error } = await client.rpc(functionName, params);
    if (error) return commandFailure(categoryForRpcError(error), sanitizeReason(error.message || error.code || "RPC_FAILED"));
    return normalizeCommandResult(data);
  }

  function staffParams(extra = {}) {
    const authState = authStateRef() || {};
    return {
      [STAFF_COMMAND_PARAMS.locationId]: text(extra.locationId || authState.locationId || "deedou-demo"),
      [STAFF_COMMAND_PARAMS.workstationMode]: text(extra.workstationMode || authState.authorization?.workstationMode || authState.workstationMode),
      [STAFF_COMMAND_PARAMS.deviceCredential]: readStoredDeviceCredential(deviceStorage),
      ...extra.params
    };
  }

  async function fetchStaffSnapshot(options = {}) {
    return rpc("dd008c_get_location_snapshot", staffParams({ locationId: options.locationId, workstationMode: options.workstationMode }));
  }

  async function fetchPublicTableSnapshot(qrToken) {
    return rpc("dd008c_get_public_table_snapshot", { p_qr_token: text(qrToken) });
  }

  async function submitQrOrder({ qrToken, items, note, idempotencyKey } = {}) {
    return rpc("submit_qr_order", {
      p_qr_token: text(qrToken),
      p_items: toJsonArray(items),
      p_note: text(note),
      p_idempotency_key: text(idempotencyKey)
    });
  }

  async function createServiceRequest({ qrToken, type, idempotencyKey } = {}) {
    return rpc("create_service_request", {
      p_qr_token: text(qrToken),
      p_type: text(type),
      p_idempotency_key: text(idempotencyKey)
    });
  }

  async function completeServiceRequest({ requestId, expectedVersion, idempotencyKey } = {}) {
    return rpc("complete_service_request", staffParams({
      params: {
        p_request_id: text(requestId),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function createStaffOrder({ items, tableCode, fulfillmentType, note, idempotencyKey } = {}) {
    return rpc("create_staff_order", staffParams({
      params: {
        p_items: toJsonArray(items),
        p_table_code: text(tableCode),
        p_fulfillment_type: text(fulfillmentType || "DINE_IN"),
        p_note: text(note),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function setOrderStatus({ orderId, status, expectedVersion, idempotencyKey } = {}) {
    return rpc("set_order_status", staffParams({
      params: {
        p_order_id: text(orderId),
        p_status: text(status),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function updateKdsLinePrep({ orderId, lineIds, nextPrepStatus, expectedVersion, idempotencyKey } = {}) {
    return rpc("update_kds_line_prep", staffParams({
      params: {
        p_order_id: text(orderId),
        p_line_ids: asTextArray(lineIds),
        p_next_prep_status: text(nextPrepStatus),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function serveOrderLine({ orderId, lineId, qty, expectedVersion, idempotencyKey } = {}) {
    return rpc("serve_order_line", staffParams({
      params: {
        p_order_id: text(orderId),
        p_line_id: text(lineId),
        p_qty: optionalInteger(qty) || 1,
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function serveAllReady({ orderId, expectedVersion, idempotencyKey } = {}) {
    return rpc("serve_all_ready", staffParams({
      params: {
        p_order_id: text(orderId),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function updateOrderLineBillQty({ orderId, lineId, billQty, expectedVersion, idempotencyKey } = {}) {
    return rpc("update_order_line_bill_qty", staffParams({
      params: {
        p_order_id: text(orderId),
        p_line_id: text(lineId),
        p_bill_qty: optionalInteger(billQty),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function assignFamilyCourse({ orderId, familyLineId, course, idempotencyKey } = {}) {
    return rpc("assign_order_family_course", staffParams({
      params: { p_order_id: text(orderId), p_family_line_id: text(familyLineId), p_course: text(course), p_idempotency_key: text(idempotencyKey) }
    }));
  }

  async function holdFamily({ orderId, familyLineId, idempotencyKey } = {}) {
    return rpc("hold_order_family", staffParams({
      params: { p_order_id: text(orderId), p_family_line_id: text(familyLineId), p_idempotency_key: text(idempotencyKey) }
    }));
  }

  async function fireFamily({ orderId, familyLineId, idempotencyKey } = {}) {
    return rpc("fire_order_family", staffParams({
      params: { p_order_id: text(orderId), p_family_line_id: text(familyLineId), p_idempotency_key: text(idempotencyKey) }
    }));
  }

  async function fireCourse({ orderId, course, idempotencyKey } = {}) {
    return rpc("fire_order_course", staffParams({
      params: { p_order_id: text(orderId), p_course: text(course), p_idempotency_key: text(idempotencyKey) }
    }));
  }

  async function openTableVisit({ tableCode, idempotencyKey } = {}) {
    return rpc("open_table_visit", staffParams({
      params: { p_table_code: text(tableCode), p_idempotency_key: text(idempotencyKey) }
    }));
  }

  async function transferTableVisit({ tableSessionId, toTableCode, expectedVersion, idempotencyKey } = {}) {
    return rpc("transfer_table_visit", staffParams({
      params: {
        p_table_session_id: text(tableSessionId),
        p_to_table_code: text(toTableCode),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function closeTableVisit({ tableSessionId, expectedVersion, idempotencyKey } = {}) {
    return rpc("close_table_visit", staffParams({
      params: {
        p_table_session_id: text(tableSessionId),
        p_expected_version: optionalInteger(expectedVersion),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function recordOrderPayment({ orderId, method, amountVnd, tenderGroupId, idempotencyKey } = {}) {
    return rpc("record_order_payment", staffParams({
      params: {
        p_order_id: text(orderId),
        p_method: text(method),
        p_amount_vnd: optionalInteger(amountVnd),
        p_tender_group_id: text(tenderGroupId),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function voidOrderPayment({ orderId, paymentId, idempotencyKey } = {}) {
    return rpc("void_order_payment", staffParams({
      params: { p_order_id: text(orderId), p_payment_id: text(paymentId), p_idempotency_key: text(idempotencyKey) }
    }));
  }

  async function refundOrderPayment({ orderId, paymentId, amountVnd, idempotencyKey } = {}) {
    return rpc("refund_order_payment", staffParams({
      params: {
        p_order_id: text(orderId),
        p_payment_id: text(paymentId),
        p_amount_vnd: optionalInteger(amountVnd),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  async function recordTableTender({ tableSessionId, method, amountVnd, idempotencyKey } = {}) {
    return rpc("record_table_tender", staffParams({
      params: {
        p_table_session_id: text(tableSessionId),
        p_method: text(method),
        p_amount_vnd: optionalInteger(amountVnd),
        p_idempotency_key: text(idempotencyKey)
      }
    }));
  }

  function subscribeLocationRefresh({ locationId, onRefresh, onError } = {}) {
    let subscription = null;
    let closed = false;
    getClient()
      .then((client) => {
        if (closed || !client?.channel) return;
        const channel = client
          .channel(`dd008c-location-${text(locationId)}`)
          .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: "dd008c_refresh_hints",
            filter: `location_id=eq.${text(locationId)}`
          }, (event) => onRefresh?.(event))
          .subscribe((status, error) => {
            if (error) onError?.(error);
            if (status === "CHANNEL_ERROR") onError?.(new Error("CHANNEL_ERROR"));
          });
        subscription = channel;
      })
      .catch((error) => onError?.(error));
    return {
      unsubscribe() {
        closed = true;
        subscription?.unsubscribe?.();
      }
    };
  }

  return {
    isAvailable: config.mode === BACKEND_MODES.SUPABASE,
    config,
    fetchStaffSnapshot,
    fetchPublicTableSnapshot,
    submitQrOrder,
    createServiceRequest,
    completeServiceRequest,
    createStaffOrder,
    setOrderStatus,
    updateKdsLinePrep,
    serveOrderLine,
    serveAllReady,
    updateOrderLineBillQty,
    assignFamilyCourse,
    holdFamily,
    fireFamily,
    fireCourse,
    openTableVisit,
    transferTableVisit,
    closeTableVisit,
    recordOrderPayment,
    voidOrderPayment,
    refundOrderPayment,
    recordTableTender,
    subscribeLocationRefresh
  };
}

export function normalizeCommandResult(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return commandFailure("BACKEND_UNAVAILABLE", "COMMAND_RESULT_MISSING");
  return {
    ok: row.ok === true,
    category: text(row.category || (row.ok === true ? "OK" : "BACKEND_UNAVAILABLE")),
    reason: sanitizeReason(row.reason),
    entityType: text(row.entity_type || row.entityType),
    entityId: text(row.entity_id || row.entityId),
    version: optionalInteger(row.version),
    payload: row.payload && typeof row.payload === "object" ? row.payload : {}
  };
}

export function commandFailure(category, reason) {
  return {
    ok: false,
    category: COMMAND_FAILURE_CATEGORIES[category] || category || COMMAND_FAILURE_CATEGORIES.BACKEND_UNAVAILABLE,
    reason: sanitizeReason(reason || "COMMAND_FAILED"),
    entityType: "",
    entityId: "",
    version: null,
    payload: {}
  };
}

function categoryForRpcError(error = {}) {
  const message = `${error.message || ""} ${error.code || ""}`.toUpperCase();
  if (message.includes("JWT") || message.includes("AUTH")) return "UNAUTHENTICATED";
  if (message.includes("DENIED") || message.includes("PERMISSION") || message.includes("42501")) return "FORBIDDEN";
  if (message.includes("CONFLICT") || message.includes("23505")) return "CONFLICT";
  if (message.includes("INVALID_STATE")) return "INVALID_STATE";
  if (message.includes("VALIDATION") || message.includes("22")) return "VALIDATION_ERROR";
  return "BACKEND_UNAVAILABLE";
}

function toJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function asTextArray(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function sanitizeReason(value) {
  return text(value).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]").slice(0, 240);
}

function text(value) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readStoredDeviceCredential(storage = safeLocalStorage()) {
  return text(storage?.getItem?.(DEVICE_CREDENTIAL_KEY));
}
