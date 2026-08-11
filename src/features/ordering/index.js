export function clampBillQty(value, maxQty) {
  const max = Math.max(0, Number(maxQty) || 0);
  const rawValue = value === undefined || value === null || value === "" ? max : Number(value);
  const safeValue = Number.isFinite(rawValue) ? rawValue : max;
  return Math.min(max, Math.max(0, Math.round(safeValue)));
}

export function chargedQty(line) {
  return clampBillQty(line.billQty, line.qty);
}

export function lineSubtotal(line) {
  return line.isBillable ? chargedQty(line) * (Number(line.price) || 0) : 0;
}

export function billableTotal(items) {
  return (items || []).reduce((sum, line) => sum + lineSubtotal(line), 0);
}

export function recalcOrderTotal(order) {
  order.total = billableTotal(order.items);
  return order.total;
}

export const SERVICE_MODES = Object.freeze({
  COUNTER_SERVICE: "COUNTER_SERVICE",
  TABLE_SERVICE: "TABLE_SERVICE"
});

export const FULFILLMENT_TYPES = Object.freeze({
  DINE_IN: "DINE_IN",
  TAKEAWAY: "TAKEAWAY"
});

export const ORDER_SOURCES = Object.freeze({
  CUSTOMER_QR: "CUSTOMER_QR",
  STAFF: "STAFF",
  COUNTER: "COUNTER"
});

const SERVICE_MODE_ALIASES = Object.freeze({
  COUNTER: SERVICE_MODES.COUNTER_SERVICE,
  COUNTER_SERVICE: SERVICE_MODES.COUNTER_SERVICE,
  CAFE: SERVICE_MODES.COUNTER_SERVICE,
  QUICK_SERVICE: SERVICE_MODES.COUNTER_SERVICE,
  TABLE: SERVICE_MODES.TABLE_SERVICE,
  TABLE_SERVICE: SERVICE_MODES.TABLE_SERVICE,
  RESTAURANT: SERVICE_MODES.TABLE_SERVICE
});

const FULFILLMENT_TYPE_ALIASES = Object.freeze({
  DINE_IN: FULFILLMENT_TYPES.DINE_IN,
  DINEIN: FULFILLMENT_TYPES.DINE_IN,
  EAT_IN: FULFILLMENT_TYPES.DINE_IN,
  QR: FULFILLMENT_TYPES.DINE_IN,
  CUSTOMER_QR: FULFILLMENT_TYPES.DINE_IN,
  CASHIER: FULFILLMENT_TYPES.DINE_IN,
  TAKEAWAY: FULFILLMENT_TYPES.TAKEAWAY,
  TAKE_AWAY: FULFILLMENT_TYPES.TAKEAWAY,
  TAKEOUT: FULFILLMENT_TYPES.TAKEAWAY,
  TO_GO: FULFILLMENT_TYPES.TAKEAWAY
});

const ORDER_SOURCE_ALIASES = Object.freeze({
  QR: ORDER_SOURCES.CUSTOMER_QR,
  CUSTOMER: ORDER_SOURCES.CUSTOMER_QR,
  CUSTOMER_QR: ORDER_SOURCES.CUSTOMER_QR,
  STAFF: ORDER_SOURCES.STAFF,
  WAITER: ORDER_SOURCES.STAFF,
  SERVER: ORDER_SOURCES.STAFF,
  CASHIER: ORDER_SOURCES.COUNTER,
  COUNTER: ORDER_SOURCES.COUNTER,
  POS: ORDER_SOURCES.COUNTER,
  TAKEAWAY: ORDER_SOURCES.COUNTER
});

const OPEN_ORDER_STATUSES = Object.freeze(["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"]);
const CLOSED_ORDER_STATUSES = Object.freeze(["PAID", "REJECTED", "VOIDED", "REFUNDED"]);
const READY_ITEM_STATUSES = Object.freeze(["READY", "SERVED"]);
const ACTIVE_STATION_STATUSES = Object.freeze(["ACKNOWLEDGED", "PREPARING", "READY"]);
const ORDER_TIMESTAMP_FIELDS = Object.freeze(["createdAt", "acceptedAt", "prepStartedAt", "readyAt", "servedAt"]);

export function normalizeServiceMode(value, context = {}) {
  const normalized = enumAlias(value, SERVICE_MODE_ALIASES);
  if (normalized) return normalized;
  const fulfillmentType = context.fulfillmentType || FULFILLMENT_TYPES.DINE_IN;
  const table = normalizePhysicalTableCode(context.table);
  if (fulfillmentType === FULFILLMENT_TYPES.TAKEAWAY) return SERVICE_MODES.COUNTER_SERVICE;
  if (table) return SERVICE_MODES.TABLE_SERVICE;
  if (context.orderSource === ORDER_SOURCES.CUSTOMER_QR) return SERVICE_MODES.TABLE_SERVICE;
  return SERVICE_MODES.COUNTER_SERVICE;
}

export function normalizeFulfillmentType(value) {
  return enumAlias(value, FULFILLMENT_TYPE_ALIASES) || FULFILLMENT_TYPES.DINE_IN;
}

export function normalizeOrderSource(value) {
  return enumAlias(value, ORDER_SOURCE_ALIASES) || ORDER_SOURCES.CUSTOMER_QR;
}

export function normalizePhysicalTableCode(value) {
  const table = String(value || "").trim();
  if (!table) return "";
  if (["TAKEAWAY", "TAKE_AWAY", "TAKEOUT", "COUNTER", "WALK_IN"].includes(table.toUpperCase())) return "";
  return table;
}

export function normalizeOrderTimestamps(order = {}) {
  return Object.fromEntries(ORDER_TIMESTAMP_FIELDS.map((field) => [field, normalizeIsoTimestamp(order[field])]));
}

export function normalizeOrderLineOperationalFields(line = {}) {
  return {
    course: line.course || "",
    holdState: line.holdState || "",
    seat: line.seat || "",
    targetPrepStation: line.targetPrepStation || line.station || "",
    targetPrepMinutes: normalizeOptionalPositiveNumber(line.targetPrepMinutes),
    ticketAgeAlertMinutes: normalizeOptionalPositiveNumber(line.ticketAgeAlertMinutes)
  };
}

export function normalizeOrderOperationalFields(order = {}) {
  return {
    guestCount: normalizeOptionalPositiveNumber(order.guestCount),
    serviceSequence: order.serviceSequence || ""
  };
}

export function normalizeOrderServiceContext(order = {}) {
  const orderSource = normalizeOrderSource(order.orderSource || order.source || order.channel);
  const legacyTable = normalizePhysicalTableCode(order.table || order.tableCode);
  const fulfillmentType = normalizeFulfillmentType(order.fulfillmentType || order.fulfillment || order.channel || order.table);
  const serviceMode = normalizeServiceMode(order.serviceMode, {
    fulfillmentType,
    orderSource,
    table: legacyTable
  });
  return {
    serviceMode,
    fulfillmentType,
    orderSource,
    zone: String(order.zone || "").trim(),
    table: legacyTable
  };
}

export function validateOrderServiceContext(order = {}) {
  const context = normalizeOrderServiceContext(order);
  const errors = [];
  if (context.serviceMode === SERVICE_MODES.TABLE_SERVICE && context.fulfillmentType === FULFILLMENT_TYPES.DINE_IN && !context.table) {
    errors.push("TABLE_REQUIRED");
  }
  return { ok: errors.length === 0, errors, context };
}

export function isOpenOrderStatus(status) {
  return OPEN_ORDER_STATUSES.includes(normalizeOrderStatus(status));
}

export function isClosedOrderStatus(status) {
  return CLOSED_ORDER_STATUSES.includes(normalizeOrderStatus(status));
}

export function isOpenPhysicalTableOrder(order) {
  const context = normalizeOrderServiceContext(order);
  return context.serviceMode === SERVICE_MODES.TABLE_SERVICE
    && context.fulfillmentType === FULFILLMENT_TYPES.DINE_IN
    && !!context.table
    && isOpenOrderStatus(order?.status);
}

export function expandOrderLines(cartLines, productById) {
  return (cartLines || []).flatMap((line) => {
    const item = productById(line.id);
    if (!item) return [];

    const qty = Math.max(1, Number(line.qty) || 1);
    const parent = {
      id: item.id,
      qty,
      station: item.components?.length ? "COMBO" : item.station,
      nameVi: item.vi,
      nameEn: item.en,
      price: Number(item.price) || 0,
      billQty: qty,
      status: "QUEUED",
      isBillable: true,
      isComponent: false,
      parentComboId: "",
      ...normalizeOrderLineOperationalFields({ ...line, station: item.station })
    };

    const components = (item.components || []).map((part, index) => ({
      id: `${item.id}-component-${index}`,
      qty: qty * (Number(part.qty) || 1),
      station: part.station,
      nameVi: part.vi,
      nameEn: part.en,
      price: 0,
      billQty: 0,
      status: "QUEUED",
      isBillable: false,
      isComponent: true,
      parentComboId: item.id,
      ...normalizeOrderLineOperationalFields({ ...part, station: part.station })
    }));

    return [parent, ...components];
  });
}

export function stationStatusFor(items, status) {
  const initial = normalizeItemStatus(status === "PENDING_ACCEPTANCE" ? "QUEUED" : status);
  return Object.fromEntries([...new Set((items || []).filter(isRequiredStationLine).map((item) => item.station))].map((station) => [station, initial]));
}

export const DIRECT_ORDER_STATUS_TRANSITIONS = Object.freeze({
  PENDING_ACCEPTANCE: Object.freeze(["ACCEPTED", "REJECTED"]),
  ACCEPTED: Object.freeze(["IN_PREPARATION", "REJECTED"]),
  IN_PREPARATION: Object.freeze([]),
  READY: Object.freeze(["SERVED"]),
  SERVED: Object.freeze(["PAID"])
});

export function getAllowedOrderStatusTransitions(status) {
  return [...(DIRECT_ORDER_STATUS_TRANSITIONS[normalizeOrderStatus(status)] || [])];
}

export function canTransitionOrderStatus(currentStatus, nextStatus) {
  const next = normalizeOrderStatus(nextStatus);
  return getAllowedOrderStatusTransitions(currentStatus).includes(next);
}

export function applyOrderStatusTransition(order, nextStatus, options = {}) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };

  const from = normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE");
  const to = normalizeOrderStatus(nextStatus);
  if (!canTransitionOrderStatus(from, to)) {
    return { ok: false, order, from, to, reason: "INVALID_STATUS_TRANSITION" };
  }

  const now = options.now || new Date().toISOString();
  order.status = to;
  if (to === "ACCEPTED") {
    setOrderTimestamp(order, "acceptedAt", now);
    order.stationStatus = stationStatusFor(order.items, "QUEUED");
    nonComboItems(order).forEach((item) => {
      item.status = "QUEUED";
    });
  }
  if (to === "IN_PREPARATION") {
    setOrderTimestamp(order, "prepStartedAt", now);
    const stationStatus = order.stationStatus || stationStatusFor(order.items, "QUEUED");
    order.stationStatus = stationStatus;
    Object.keys(stationStatus).forEach((station) => {
      if (stationStatus[station] === "QUEUED") stationStatus[station] = "PREPARING";
    });
    nonComboItems(order).filter((item) => item.status === "QUEUED").forEach((item) => {
      item.status = "PREPARING";
    });
  }
  if (to === "REJECTED") order.stationStatus = {};
  if (to === "SERVED") {
    setOrderTimestamp(order, "servedAt", now);
    nonComboItems(order).forEach((item) => {
      item.status = "SERVED";
    });
  }

  return { ok: true, order, from, to };
}

export function applyStationStatusUpdate(order, targetStations, nextStatus, options = {}) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (isClosedOrderStatus(order.status)) return { ok: false, order, reason: "ORDER_CLOSED" };
  const previousStatus = normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE");
  if (!["ACCEPTED", "IN_PREPARATION", "READY"].includes(previousStatus)) {
    return { ok: false, order, reason: "ORDER_NOT_IN_STATION_WORKFLOW" };
  }

  const stations = new Set((targetStations || []).filter(Boolean));
  if (!stations.size) return { ok: false, order, reason: "NO_STATIONS" };

  const status = normalizeItemStatus(nextStatus);
  const now = options.now || new Date().toISOString();
  const stationStatus = order.stationStatus || stationStatusFor(order.items, "QUEUED");
  order.stationStatus = stationStatus;

  stations.forEach((station) => {
    if (stationStatus[station] || (order.items || []).some((item) => item.station === station)) {
      stationStatus[station] = status;
    }
  });
  requiredStationItems(order).filter((item) => stations.has(item.station)).forEach((item) => {
    item.status = status;
  });

  if (ACTIVE_STATION_STATUSES.includes(status)) setOrderTimestamp(order, "prepStartedAt", now);
  const derivedStatus = deriveOrderStatusFromStations(order);
  order.status = derivedStatus;
  if (derivedStatus === "READY") setOrderTimestamp(order, "readyAt", now);

  return { ok: true, order, from: previousStatus, to: derivedStatus, stationStatus: status };
}

export function deriveOrderStatusFromStations(order) {
  if (!order) return "PENDING_ACCEPTANCE";
  const current = normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE");
  if (["PENDING_ACCEPTANCE", "REJECTED", "PAID", "VOIDED", "REFUNDED", "SERVED"].includes(current)) return current;

  const requiredItems = requiredStationItems(order);
  if (!requiredItems.length) return current;

  const requiredStations = [...new Set(requiredItems.map((item) => item.station).filter(Boolean))];
  const everyStationReady = requiredStations.every((station) => stationReady(order, requiredItems, station));
  const everyLineReady = requiredItems.every((item) => READY_ITEM_STATUSES.includes(normalizeItemStatus(item.status)));
  if (everyStationReady && everyLineReady) return "READY";

  const anyStationTouched = Object.values(order.stationStatus || {}).some((status) => ACTIVE_STATION_STATUSES.includes(normalizeItemStatus(status)))
    || requiredItems.some((item) => ACTIVE_STATION_STATUSES.includes(normalizeItemStatus(item.status)));
  if (anyStationTouched || current === "READY" || current === "IN_PREPARATION") return "IN_PREPARATION";
  return current;
}

export function isRequiredStationLine(line) {
  return !!line
    && line.station
    && line.station !== "COMBO"
    && !line.isMeta
    && line.type !== "META"
    && line.type !== "COURSE_MARKER";
}

function nonComboItems(order) {
  return (order.items || []).filter(isRequiredStationLine);
}

export function countPrepItems(orders) {
  return orders.flatMap((order) => order.items).filter(isRequiredStationLine).reduce((sum, item) => sum + item.qty, 0);
}

export function countServedItems(orders) {
  return orders.flatMap((order) => order.items).filter((item) => isRequiredStationLine(item) && item.status === "SERVED").reduce((sum, item) => sum + item.qty, 0);
}

export function countStatusItems(orders, status) {
  return orders.flatMap((order) => order.items).filter((item) => isRequiredStationLine(item) && item.status === status).reduce((sum, item) => sum + item.qty, 0);
}

export function normalizeOrderStatus(status) {
  const aliases = {
    PENDING: "PENDING_ACCEPTANCE",
    PREPARING: "IN_PREPARATION",
    CANCELLED: "VOIDED"
  };
  return aliases[status] || status;
}

export function normalizeItemStatus(status) {
  const aliases = {
    PENDING: "QUEUED",
    PENDING_ACCEPTANCE: "QUEUED",
    ACCEPTED: "QUEUED",
    IN_PROGRESS: "PREPARING",
    COMPLETED: "READY"
  };
  return aliases[status] || status || "QUEUED";
}

function requiredStationItems(order) {
  return (order.items || []).filter(isRequiredStationLine);
}

function stationReady(order, requiredItems, station) {
  const stationState = normalizeItemStatus(order.stationStatus?.[station]);
  if (READY_ITEM_STATUSES.includes(stationState)) return true;
  return requiredItems.filter((item) => item.station === station).every((item) => READY_ITEM_STATUSES.includes(normalizeItemStatus(item.status)));
}

function setOrderTimestamp(order, field, now) {
  if (!order[field]) order[field] = normalizeIsoTimestamp(now) || now;
}

function enumAlias(value, aliases) {
  const key = String(value || "").trim().toUpperCase();
  return aliases[key] || "";
}

function normalizeIsoTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "";
}

function normalizeOptionalPositiveNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
