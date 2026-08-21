import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createCorrelationId } from "./resilience.js";

const DEVICE_CREDENTIAL_KEY = "deedou_device_credential";
const REALTIME_SUBSCRIBE_TIMEOUT_MS = 8_000;

export function createAdminBackendApi(options = {}) {
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

  async function rpc(functionName, params = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE) return failure("BACKEND_UNAVAILABLE", "SUPABASE_REQUIRED");
    const client = await authApi?.getClient?.();
    if (!client?.rpc) return failure("BACKEND_UNAVAILABLE", "SUPABASE_CLIENT_MISSING");
    const context = authorityContext(params.locationId);
    if (!context.locationId || !context.credential) return failure("FORBIDDEN", "ADMIN_CONTEXT_INCOMPLETE");
    const correlationId = createCorrelationId("admin");
    const { data, error } = await client.rpc(functionName, {
      p_location_id: context.locationId,
      p_workstation_mode: context.workstationMode,
      p_device_credential: context.credential,
      ...params.rpcParams
    });
    if (error) return failure(categoryForError(error), sanitizeReason(error.message || error.code), correlationId);
    return normalizeResult(data, correlationId);
  }

  async function subscribeMenuRefresh({ locationId, onRefresh, onState, timeoutMs = REALTIME_SUBSCRIBE_TIMEOUT_MS } = {}) {
    if (config.mode !== BACKEND_MODES.SUPABASE) return failure("BACKEND_UNAVAILABLE", "SUPABASE_REQUIRED");
    const client = await authApi?.getClient?.();
    if (!client?.rpc || !client?.channel) return failure("BACKEND_UNAVAILABLE", "SUPABASE_REALTIME_CLIENT_MISSING");
    const context = authorityContext(locationId);
    if (!context.locationId || !context.credential) return failure("FORBIDDEN", "ADMIN_CONTEXT_INCOMPLETE");

    const correlationId = createCorrelationId("admin-realtime");
    const { data, error } = await client.rpc("dd008c_issue_realtime_ticket", {
      p_location_id: context.locationId,
      p_audience: "admin",
      p_workstation_mode: context.workstationMode,
      p_device_credential: context.credential
    });
    if (error) return failure(categoryForError(error), sanitizeReason(error.message || error.code), correlationId);

    const ticket = normalizeResult(data, correlationId);
    if (!ticket.ok) return ticket;
    const topic = text(ticket.payload?.topic);
    if (!topic) return failure("BACKEND_UNAVAILABLE", "ADMIN_REALTIME_TOPIC_MISSING", correlationId);

    let closed = false;
    const channel = client
      .channel(topic, { config: { private: true } })
      .on("broadcast", { event: "refresh" }, (event) => {
        if (closed) return;
        const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
        onRefresh?.(payload);
      });

    const subscribed = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: "ADMIN_REALTIME_SUBSCRIBE_TIMEOUT" });
      }, Math.max(1, Number(timeoutMs) || REALTIME_SUBSCRIBE_TIMEOUT_MS));

      channel.subscribe((status, channelError) => {
        const normalizedStatus = text(status).toUpperCase();
        if (closed) return;
        if (channelError && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: sanitizeReason(channelError.message || channelError.code || "ADMIN_REALTIME_CHANNEL_ERROR") });
          return;
        }
        if (normalizedStatus === "SUBSCRIBED" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true });
          return;
        }
        if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(normalizedStatus)) {
          const reason = `ADMIN_REALTIME_${normalizedStatus}`;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, reason });
          } else {
            onState?.("ERROR", reason);
          }
        }
      });
    });

    if (!subscribed.ok) {
      closed = true;
      channel?.unsubscribe?.();
      return failure("BACKEND_UNAVAILABLE", subscribed.reason, correlationId);
    }

    return {
      ok: true,
      category: "OK",
      reason: "",
      entityType: ticket.entityType || "realtime_subscription",
      entityId: ticket.entityId,
      version: ticket.version,
      payload: ticket.payload,
      correlationId,
      topic,
      unsubscribe() {
        if (closed) return;
        closed = true;
        channel?.unsubscribe?.();
      }
    };
  }

  return {
    fetchMenu({ locationId } = {}) {
      return rpc("dd008d_get_admin_menu_snapshot", { locationId });
    },
    createProduct({ id, kind, category, nameVi, nameEn, descVi = "", descEn = "", priceVnd, stationCode, periods = [], imageUrl = "", color = "", art = "", available = true, idempotencyKey, locationId } = {}) {
      return rpc("dd012_create_product", {
        locationId,
        rpcParams: {
          p_product_id: text(id),
          p_kind: text(kind).toUpperCase(),
          p_category: text(category).toLowerCase(),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_desc_vi: text(descVi),
          p_desc_en: text(descEn),
          p_price_vnd: integerOrNull(priceVnd),
          p_station_code: text(stationCode).toUpperCase(),
          p_periods: stringArray(periods),
          p_image_url: text(imageUrl),
          p_color: text(color),
          p_art: text(art),
          p_available: available !== false,
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    updateProduct({ id, kind, category, nameVi, nameEn, descVi = "", descEn = "", priceVnd, stationCode, periods = [], imageUrl = "", color = "", art = "", expectedUpdatedAt, idempotencyKey, locationId } = {}) {
      return rpc("dd012_update_product", {
        locationId,
        rpcParams: {
          p_product_id: text(id),
          p_kind: text(kind).toUpperCase(),
          p_category: text(category).toLowerCase(),
          p_name_vi: text(nameVi),
          p_name_en: text(nameEn),
          p_desc_vi: text(descVi),
          p_desc_en: text(descEn),
          p_price_vnd: integerOrNull(priceVnd),
          p_station_code: text(stationCode).toUpperCase(),
          p_periods: stringArray(periods),
          p_image_url: text(imageUrl),
          p_color: text(color),
          p_art: text(art),
          p_expected_updated_at: expectedUpdatedAt || null,
          p_idempotency_key: text(idempotencyKey)
        }
      });
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
    },
    fetchTableLayout({ locationId } = {}) {
      return rpc("dd010a_get_admin_table_layout", { locationId });
    },
    createPhysicalTable({ code, zone, seatCount = 4, shape = "RECTANGLE", layoutX = 0, layoutY = 0, layoutWidth = 2, layoutHeight = 2, displayOrder = 0, idempotencyKey, locationId } = {}) {
      return rpc("dd010a_create_physical_table", {
        locationId,
        rpcParams: {
          p_code: text(code),
          p_zone: text(zone),
          p_seat_count: integer(seatCount),
          p_shape: text(shape).toUpperCase(),
          p_layout_x: integer(layoutX),
          p_layout_y: integer(layoutY),
          p_layout_width: integer(layoutWidth),
          p_layout_height: integer(layoutHeight),
          p_display_order: integer(displayOrder),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    updatePhysicalTable({ tableId, code, zone, seatCount, shape, layoutX, layoutY, layoutWidth, layoutHeight, displayOrder, expectedVersion, idempotencyKey, locationId } = {}) {
      return rpc("dd010a_update_physical_table", {
        locationId,
        rpcParams: {
          p_table_id: text(tableId),
          p_code: text(code),
          p_zone: text(zone),
          p_seat_count: integer(seatCount),
          p_shape: text(shape).toUpperCase(),
          p_layout_x: integer(layoutX),
          p_layout_y: integer(layoutY),
          p_layout_width: integer(layoutWidth),
          p_layout_height: integer(layoutHeight),
          p_display_order: integer(displayOrder),
          p_expected_version: integer(expectedVersion),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    setPhysicalTableActive({ tableId, active, expectedVersion, idempotencyKey, locationId } = {}) {
      return rpc("dd010a_set_physical_table_active", {
        locationId,
        rpcParams: {
          p_table_id: text(tableId),
          p_active: active === true,
          p_expected_version: integer(expectedVersion),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    rotatePhysicalTableQr({ tableId, expectedVersion, idempotencyKey, locationId } = {}) {
      return rpc("dd010a_rotate_physical_table_qr", {
        locationId,
        rpcParams: {
          p_table_id: text(tableId),
          p_expected_version: integer(expectedVersion),
          p_idempotency_key: text(idempotencyKey)
        }
      });
    },
    subscribeMenuRefresh
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

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
