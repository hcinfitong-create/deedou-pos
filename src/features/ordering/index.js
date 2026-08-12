import { createOrderLineOptionSnapshot, defaultConfiguredSelection, optionSummaryLines } from "../product-options/index.js";

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
export const PREP_STATUSES = Object.freeze(["QUEUED", "ACKNOWLEDGED", "PREPARING", "READY"]);
const READY_PREP_STATUSES = Object.freeze(["READY"]);
const ACTIVE_STATION_STATUSES = Object.freeze(["ACKNOWLEDGED", "PREPARING", "READY"]);
const PREP_STATUS_TRANSITIONS = Object.freeze({
  QUEUED: Object.freeze(["ACKNOWLEDGED"]),
  ACKNOWLEDGED: Object.freeze(["PREPARING"]),
  PREPARING: Object.freeze(["READY"]),
  READY: Object.freeze([])
});
const ORDER_TIMESTAMP_FIELDS = Object.freeze(["createdAt", "acceptedAt", "prepStartedAt", "readyAt", "servedAt"]);
const LINE_TIMESTAMP_FIELDS = Object.freeze(["queuedAt", "acknowledgedAt", "prepStartedAt", "readyAt", "servedAt"]);

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

export function normalizeOrderLineOperationalFields(line = {}, options = {}) {
  const qty = normalizeLineQty(line.qty);
  const prepStatus = normalizePrepStatus(line.prepStatus || line.status);
  return {
    lineId: normalizeLineId(line.lineId || options.fallbackLineId || ""),
    course: line.course || "",
    holdState: line.holdState || "",
    seat: line.seat || "",
    targetPrepStation: line.targetPrepStation || line.station || "",
    targetPrepMinutes: normalizeOptionalPositiveNumber(line.targetPrepMinutes),
    ticketAgeAlertMinutes: normalizeOptionalPositiveNumber(line.ticketAgeAlertMinutes),
    prepStatus,
    servedQty: normalizeServedQty(line, qty),
    ...normalizeLineTimestamps(line)
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

export function buildCounterOrderServiceContext({ tableCode = "", physicalTable = null } = {}) {
  const isTakeaway = String(tableCode || "").trim().toUpperCase() === FULFILLMENT_TYPES.TAKEAWAY;
  if (isTakeaway) {
    return normalizeOrderServiceContext({
      serviceMode: SERVICE_MODES.COUNTER_SERVICE,
      fulfillmentType: FULFILLMENT_TYPES.TAKEAWAY,
      orderSource: ORDER_SOURCES.COUNTER
    });
  }
  if (physicalTable?.code) {
    return normalizeOrderServiceContext({
      serviceMode: SERVICE_MODES.TABLE_SERVICE,
      fulfillmentType: FULFILLMENT_TYPES.DINE_IN,
      orderSource: ORDER_SOURCES.COUNTER,
      table: physicalTable.code,
      zone: physicalTable.zone || ""
    });
  }
  return normalizeOrderServiceContext({
    serviceMode: SERVICE_MODES.COUNTER_SERVICE,
    fulfillmentType: FULFILLMENT_TYPES.DINE_IN,
    orderSource: ORDER_SOURCES.COUNTER
  });
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
  return (cartLines || []).flatMap((line, cartIndex) => {
    const item = productById(line.id);
    if (!item) return [];

    const qty = Math.max(1, Number(line.qty) || 1);
    const parentLineId = line.lineId || createOperationalLineId(item.id, cartIndex, "item");
    const configured = createOrderLineOptionSnapshot(item, line.selection || defaultConfiguredSelection(item));
    if (!configured.ok) return [];
    const parentComboOptionSummaryVi = optionSummaryLines({ optionSnapshot: configured.optionSnapshot }, "vi");
    const parentComboOptionSummaryEn = optionSummaryLines({ optionSnapshot: configured.optionSnapshot }, "en");
    const parent = {
      id: item.id,
      lineId: parentLineId,
      qty,
      station: item.components?.length ? "COMBO" : item.station,
      nameVi: item.vi,
      nameEn: item.en,
      basePrice: configured.basePrice,
      price: configured.unitPrice,
      billQty: qty,
      status: "QUEUED",
      prepStatus: "QUEUED",
      servedQty: 0,
      isBillable: true,
      isComponent: false,
      parentComboId: "",
      configuredKey: configured.configuredKey,
      configuredOptions: configured.selection,
      optionSnapshot: configured.optionSnapshot,
      ...normalizeOrderLineOperationalFields({
        ...line,
        lineId: parentLineId,
        qty,
        station: item.station,
        status: "QUEUED",
        prepStatus: "QUEUED",
        servedQty: 0
      })
    };

    const components = (item.components || []).map((part, index) => ({
      id: `${item.id}-component-${index}`,
      lineId: `${parentLineId}:component-${index}`,
      qty: qty * (Number(part.qty) || 1),
      station: part.station,
      nameVi: part.vi,
      nameEn: part.en,
      price: 0,
      billQty: 0,
      status: "QUEUED",
      prepStatus: "QUEUED",
      servedQty: 0,
      isBillable: false,
      isComponent: true,
      parentComboId: item.id,
      parentComboNameVi: item.vi,
      parentComboNameEn: item.en,
      parentComboOptionSummaryVi,
      parentComboOptionSummaryEn,
      ...normalizeOrderLineOperationalFields({
        ...part,
        lineId: `${parentLineId}:component-${index}`,
        qty: qty * (Number(part.qty) || 1),
        station: part.station,
        status: "QUEUED",
        prepStatus: "QUEUED",
        servedQty: 0
      })
    }));

    return [parent, ...components];
  });
}

export function stationStatusFor(items, status) {
  const initial = normalizePrepStatus(status === "PENDING_ACCEPTANCE" ? "QUEUED" : status);
  const requiredItems = (items || []).filter(isRequiredStationLine);
  if (arguments.length > 1) {
    return Object.fromEntries([...new Set(requiredItems.map((item) => item.station))].map((station) => [station, initial]));
  }
  return stationStatusSummaryForItems(requiredItems, initial);
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
  if (to === "SERVED") {
    const serviceContext = normalizeOrderServiceContext(order);
    const progress = getServiceProgress(order);
    if (serviceContext.serviceMode === SERVICE_MODES.TABLE_SERVICE && progress.servedQty < progress.serviceableQty) {
      return { ok: false, order, from, to, reason: "LINE_SERVING_REQUIRED" };
    }
    if (progress.servedQty < progress.serviceableQty && !requiredStationItems(order).every(isLinePrepReady)) {
      return { ok: false, order, from, to, reason: "ORDER_NOT_READY" };
    }
    if (progress.servedQty < progress.serviceableQty) {
      const handoff = serveAllReady(order, { now });
      if (!handoff.ok) return { ok: false, order, from, to, reason: handoff.reason };
    }
    order.status = deriveOrderOperationalStatus(order);
    if (order.status !== "SERVED") return { ok: false, order, from, to, reason: "ORDER_NOT_FULLY_SERVED" };
    setOrderTimestamp(order, "servedAt", now);
    return { ok: true, order, from, to };
  }

  order.status = to;
  if (to === "ACCEPTED") {
    setOrderTimestamp(order, "acceptedAt", now);
    order.stationStatus = stationStatusFor(order.items, "QUEUED");
    nonComboItems(order).forEach((item) => {
      item.status = "QUEUED";
      item.prepStatus = "QUEUED";
      if (!item.queuedAt) item.queuedAt = normalizeIsoTimestamp(now) || now;
    });
  }
  if (to === "IN_PREPARATION") {
    order.stationStatus = stationStatusFor(order.items);
  }
  if (to === "REJECTED") order.stationStatus = {};

  return { ok: true, order, from, to };
}

export function canTransitionPrepStatus(currentStatus, nextStatus) {
  const current = normalizePrepStatus(currentStatus);
  const next = normalizePrepStatus(nextStatus);
  if (String(nextStatus || "").trim().toUpperCase() === "SERVED") return false;
  return (PREP_STATUS_TRANSITIONS[current] || []).includes(next);
}

export function applyPrepStatusTransition(order, target = {}, nextStatus, options = {}) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (isClosedOrderStatus(order.status)) return { ok: false, order, reason: "ORDER_CLOSED" };
  const previousStatus = normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE");
  if (!["ACCEPTED", "IN_PREPARATION", "READY"].includes(previousStatus)) {
    return { ok: false, order, reason: "ORDER_NOT_IN_STATION_WORKFLOW" };
  }

  const stations = new Set([
    target.stationCode,
    ...(target.stationCodes || []),
    ...(target.stations || [])
  ].filter(Boolean));
  if (!stations.size) return { ok: false, order, reason: "NO_STATIONS" };

  if (String(nextStatus || "").trim().toUpperCase() === "SERVED") {
    return { ok: false, order, reason: "INVALID_PREP_STATUS" };
  }
  const status = normalizePrepStatus(nextStatus);
  const now = options.now || new Date().toISOString();
  const targetLineId = normalizeLineId(target.lineId || "");
  const candidates = requiredStationItems(order).filter((item) => {
    return stations.has(item.station) && (!targetLineId || item.lineId === targetLineId);
  });
  if (!candidates.length) return { ok: false, order, reason: "NO_LINES" };

  const changedLines = [];
  candidates.forEach((item) => {
    const current = normalizePrepStatus(item.prepStatus || item.status);
    if (!canTransitionPrepStatus(current, status)) return;
    item.prepStatus = status;
    item.status = status;
    setLinePrepTimestamp(item, status, now);
    changedLines.push(item.lineId);
  });
  if (!changedLines.length) return { ok: false, order, reason: "INVALID_PREP_STATUS_TRANSITION" };

  if (ACTIVE_STATION_STATUSES.includes(status)) setOrderTimestamp(order, "prepStartedAt", now);
  order.stationStatus = stationStatusFor(order.items);
  const derivedStatus = deriveOrderOperationalStatus(order);
  order.status = derivedStatus;
  if (derivedStatus === "READY") setOrderTimestamp(order, "readyAt", now);

  return { ok: true, order, from: previousStatus, to: derivedStatus, stationStatus: status, changedLines };
}

export function applyStationStatusUpdate(order, targetStations, nextStatus, options = {}) {
  return applyPrepStatusTransition(order, { stations: targetStations }, nextStatus, options);
}

export function deriveOrderStatusFromStations(order) {
  return deriveOrderOperationalStatus(order);
}

export function deriveOrderOperationalStatus(order) {
  if (!order) return "PENDING_ACCEPTANCE";
  const current = normalizeOrderStatus(order.status || "PENDING_ACCEPTANCE");
  if (["REJECTED", "PAID", "VOIDED", "REFUNDED"].includes(current)) return current;

  const requiredItems = requiredStationItems(order);
  if (!requiredItems.length) return current;

  const progress = getServiceProgress(order);
  if (progress.serviceableQty > 0 && progress.servedQty >= progress.serviceableQty) return "SERVED";

  const remainingItems = requiredItems.filter((item) => !isLineFullyServed(item));
  if (remainingItems.length && remainingItems.every(isLinePrepReady)) return "READY";

  const anyStationTouched = Object.values(order.stationStatus || {}).some((status) => ACTIVE_STATION_STATUSES.includes(normalizePrepStatus(status)))
    || requiredItems.some((item) => ACTIVE_STATION_STATUSES.includes(normalizePrepStatus(item.prepStatus || item.status)));
  const anyServedProgress = progress.servedQty > 0;
  if (anyStationTouched || current === "READY" || current === "IN_PREPARATION") return "IN_PREPARATION";
  if (anyServedProgress) return "IN_PREPARATION";
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
  return orderLines(orders).filter(isRequiredStationLine).reduce((sum, item) => sum + normalizeLineQty(item.qty), 0);
}

export function countServedItems(orders) {
  return orderLines(orders).filter(isRequiredStationLine).reduce((sum, item) => sum + normalizeServiceProgress(item).servedQty, 0);
}

export function countStatusItems(orders, status) {
  const normalizedStatus = normalizeItemStatus(status);
  if (normalizedStatus === "SERVED") return countServedItems(orders);
  const prepStatus = normalizePrepStatus(status);
  return orderLines(orders).filter((item) => isRequiredStationLine(item) && normalizePrepStatus(item.prepStatus || item.status) === prepStatus).reduce((sum, item) => {
    const qty = normalizeLineQty(item.qty);
    if (prepStatus === "READY") return sum + Math.max(0, qty - normalizeServiceProgress(item).servedQty);
    return sum + qty;
  }, 0);
}

export function normalizeOrderStatus(status) {
  const aliases = {
    PENDING: "PENDING_ACCEPTANCE",
    PREPARING: "IN_PREPARATION",
    CANCELLED: "VOIDED"
  };
  const key = String(status || "").trim().toUpperCase();
  return aliases[key] || key;
}

export function normalizeItemStatus(status) {
  const aliases = {
    PENDING: "QUEUED",
    PENDING_ACCEPTANCE: "QUEUED",
    ACCEPTED: "QUEUED",
    IN_PROGRESS: "PREPARING",
    COMPLETED: "READY"
  };
  const key = String(status || "").trim().toUpperCase();
  return aliases[key] || key || "QUEUED";
}

export function normalizePrepStatus(status) {
  const normalized = normalizeItemStatus(status);
  if (normalized === "SERVED") return "READY";
  return PREP_STATUSES.includes(normalized) ? normalized : "QUEUED";
}

export function normalizeServiceProgress(line = {}) {
  const qty = normalizeLineQty(line.qty);
  const servedQty = isRequiredStationLine(line) ? normalizeServedQty(line, qty) : 0;
  return {
    serviceableQty: isRequiredStationLine(line) ? qty : 0,
    servedQty,
    remainingQty: Math.max(0, qty - servedQty),
    fullyServed: isRequiredStationLine(line) ? servedQty >= qty : true
  };
}

export function getServiceProgress(order = {}) {
  return requiredStationItems(order).reduce((progress, line) => {
    const lineProgress = normalizeServiceProgress(line);
    progress.serviceableQty += lineProgress.serviceableQty;
    progress.servedQty += lineProgress.servedQty;
    progress.remainingQty += lineProgress.remainingQty;
    return progress;
  }, { serviceableQty: 0, servedQty: 0, remainingQty: 0 });
}

export function isLineFullyServed(line = {}) {
  return normalizeServiceProgress(line).fullyServed;
}

export function canServeLine(line = {}, quantity = 1) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return false;
  return isRequiredStationLine(line)
    && isLinePrepReady(line)
    && normalizeServiceProgress(line).remainingQty > 0;
}

export function serveLineQuantity(order, lineId, quantity = 1, options = {}) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (isClosedOrderStatus(order.status)) return { ok: false, order, reason: "ORDER_CLOSED" };
  const normalizedLineId = normalizeLineId(lineId);
  if (!normalizedLineId) return { ok: false, order, reason: "LINE_ID_REQUIRED" };

  const line = requiredStationItems(order).find((item) => item.lineId === normalizedLineId);
  if (!line) return { ok: false, order, reason: "LINE_NOT_FOUND" };
  if (!canServeLine(line, quantity)) return { ok: false, order, reason: "LINE_NOT_READY" };

  const serviceQty = Number(quantity);
  const oldServedQty = normalizeServiceProgress(line).servedQty;
  const nextServedQty = clampServiceQty(oldServedQty + serviceQty, normalizeLineQty(line.qty));
  if (nextServedQty === oldServedQty) return { ok: false, order, reason: "NO_SERVICE_QUANTITY_CHANGE" };

  const now = options.now || new Date().toISOString();
  line.servedQty = nextServedQty;
  line.servedAt = normalizeIsoTimestamp(now) || now;
  if (isLineFullyServed(line)) line.status = "SERVED";
  order.status = deriveOrderOperationalStatus(order);
  if (order.status === "SERVED") setOrderTimestamp(order, "servedAt", now);
  return { ok: true, order, line, lineId: normalizedLineId, from: oldServedQty, to: nextServedQty };
}

export function serveAllReady(order, options = {}) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (isClosedOrderStatus(order.status)) return { ok: false, order, reason: "ORDER_CLOSED" };

  const now = options.now || new Date().toISOString();
  const readyLines = requiredStationItems(order).filter((line) => isLinePrepReady(line) && !isLineFullyServed(line));
  if (!readyLines.length) return { ok: false, order, reason: "NO_READY_LINES" };

  readyLines.forEach((line) => {
    line.servedQty = normalizeLineQty(line.qty);
    line.servedAt = normalizeIsoTimestamp(now) || now;
    line.status = "SERVED";
  });
  order.status = deriveOrderOperationalStatus(order);
  if (order.status === "SERVED") setOrderTimestamp(order, "servedAt", now);
  return { ok: true, order, servedLines: readyLines.map((line) => line.lineId) };
}

function requiredStationItems(order) {
  return (order.items || []).filter(isRequiredStationLine);
}

function isLinePrepReady(line = {}) {
  return READY_PREP_STATUSES.includes(normalizePrepStatus(line.prepStatus || line.status));
}

function stationStatusSummaryForItems(items, fallbackStatus = "QUEUED") {
  const byStation = (items || []).filter(isRequiredStationLine).reduce((groups, item) => {
    groups[item.station] = groups[item.station] || [];
    groups[item.station].push(item);
    return groups;
  }, {});
  return Object.fromEntries(Object.entries(byStation).map(([station, stationItems]) => [
    station,
    deriveStationPrepStatus(stationItems, fallbackStatus)
  ]));
}

function deriveStationPrepStatus(items, fallbackStatus = "QUEUED") {
  if (!items?.length) return normalizePrepStatus(fallbackStatus);
  const statuses = items.map((item) => normalizePrepStatus(item.prepStatus || item.status));
  if (statuses.every((status) => status === "READY")) return "READY";
  if (statuses.includes("PREPARING")) return "PREPARING";
  if (statuses.includes("ACKNOWLEDGED")) return "ACKNOWLEDGED";
  return "QUEUED";
}

function setLinePrepTimestamp(line, prepStatus, now) {
  const timestamp = normalizeIsoTimestamp(now) || now;
  if (!line.queuedAt) line.queuedAt = timestamp;
  if (prepStatus === "ACKNOWLEDGED" && !line.acknowledgedAt) line.acknowledgedAt = timestamp;
  if (prepStatus === "PREPARING") {
    if (!line.acknowledgedAt) line.acknowledgedAt = timestamp;
    if (!line.prepStartedAt) line.prepStartedAt = timestamp;
  }
  if (prepStatus === "READY") {
    if (!line.acknowledgedAt) line.acknowledgedAt = timestamp;
    if (!line.prepStartedAt) line.prepStartedAt = timestamp;
    if (!line.readyAt) line.readyAt = timestamp;
  }
}

function setOrderTimestamp(order, field, now) {
  if (!order[field]) order[field] = normalizeIsoTimestamp(now) || now;
}

function normalizeLineTimestamps(line = {}) {
  return Object.fromEntries(LINE_TIMESTAMP_FIELDS.map((field) => [field, normalizeIsoTimestamp(line[field])]));
}

function orderLines(orders = []) {
  return (orders || []).flatMap((order) => order.items || []);
}

function normalizeLineQty(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 1;
}

function normalizeServedQty(line, qty) {
  const legacyServed = line.servedQty === undefined
    && normalizeItemStatus(line.status) === "SERVED";
  return clampServiceQty(legacyServed ? qty : line.servedQty, qty);
}

function clampServiceQty(value, maxQty) {
  const max = Math.max(0, Number(maxQty) || 0);
  const rawValue = value === undefined || value === null || value === "" ? 0 : Number(value);
  const safeValue = Number.isFinite(rawValue) ? rawValue : 0;
  return Math.min(max, Math.max(0, Math.round(safeValue)));
}

function normalizeLineId(value) {
  return String(value || "").trim();
}

function createOperationalLineId(productId, index, suffix) {
  const safeProductId = String(productId || "line").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `${safeProductId}:${Number(index) + 1}:${suffix}`;
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
