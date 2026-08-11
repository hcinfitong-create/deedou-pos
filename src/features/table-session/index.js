import {
  FULFILLMENT_TYPES,
  getServiceProgress,
  isClosedOrderStatus,
  isOpenOrderStatus,
  isRequiredStationLine,
  normalizeOrderServiceContext,
  normalizePhysicalTableCode,
  normalizePrepStatus,
  normalizeServiceProgress,
  SERVICE_MODES
} from "../ordering/index.js";

export const TABLE_SESSION_STATUSES = Object.freeze({
  OPEN: "OPEN",
  CLOSED: "CLOSED"
});

export const TABLE_SESSION_SOURCES = Object.freeze({
  CUSTOMER_QR: "CUSTOMER_QR",
  STAFF: "STAFF",
  COUNTER: "COUNTER",
  LEGACY: "LEGACY"
});

const PREPARING_WORK_STATUSES = Object.freeze(["QUEUED", "ACKNOWLEDGED", "PREPARING"]);

export function normalizeTableSession(session = {}, options = {}) {
  const table = resolvePhysicalTable(session.tableCode || session.table, options.tables || []);
  const tableCode = table?.code || normalizePhysicalTableCode(session.tableCode || session.table);
  const status = normalizeTableSessionStatus(session.status || (session.closedAt ? TABLE_SESSION_STATUSES.CLOSED : TABLE_SESSION_STATUSES.OPEN));
  return {
    id: String(session.id || legacySessionId(tableCode || "UNKNOWN")).trim(),
    tableCode,
    zone: String(session.zone || table?.zone || "").trim(),
    status,
    openedAt: normalizeIsoTimestamp(session.openedAt),
    closedAt: status === TABLE_SESSION_STATUSES.CLOSED ? normalizeIsoTimestamp(session.closedAt) : "",
    openedSource: normalizeTableSessionSource(session.openedSource || session.source)
  };
}

export function normalizeTableSessions(tableSessions = [], options = {}) {
  const sessions = normalizeTableSessionList(tableSessions, options);
  return enforceOneOpenSessionPerTable(sessions, options);
}

export function getActiveTableSession(tableSessions = [], tableCode) {
  const code = normalizePhysicalTableCode(tableCode);
  if (!code) return null;
  return normalizeTableSessions(tableSessions)
    .filter((session) => session.status === TABLE_SESSION_STATUSES.OPEN && session.tableCode === code)
    .sort(compareSessionNewestFirst)[0] || null;
}

export function selectOpenTableSessions(tableSessions = []) {
  return normalizeTableSessions(tableSessions).filter((session) => session.status === TABLE_SESSION_STATUSES.OPEN);
}

export function openOrReuseTableSession(tableSessions = [], options = {}) {
  const sessions = normalizeTableSessions(tableSessions, options);
  const table = resolvePhysicalTable(options.table || options.tableCode, options.tables || []);
  if (!table?.code) return { ok: false, reason: "TABLE_NOT_FOUND", tableSessions: sessions };

  const activeSession = getActiveTableSession(sessions, table.code);
  if (activeSession) {
    return { ok: true, tableSessions: sessions, session: activeSession, created: false, reused: true };
  }

  const now = normalizeIsoTimestamp(options.now) || new Date().toISOString();
  const source = normalizeTableSessionSource(options.source);
  const generatedId = typeof options.generateId === "function"
    ? options.generateId({ table, tableCode: table.code, source, now })
    : defaultTableSessionId({ tableCode: table.code, now });
  const session = {
    id: uniqueSessionId(generatedId || defaultTableSessionId({ tableCode: table.code, now }), sessions),
    tableCode: table.code,
    zone: table.zone || "",
    status: TABLE_SESSION_STATUSES.OPEN,
    openedAt: now,
    closedAt: "",
    openedSource: source
  };

  return { ok: true, tableSessions: [...sessions, session], session, created: true, reused: false };
}

export function attachOrderToTableSession(order = {}, session = null) {
  const context = normalizeOrderServiceContext(order);
  if (!isTableServiceContext(context)) {
    const nextOrder = { ...order };
    delete nextOrder.tableSessionId;
    return { ok: true, order: nextOrder, attached: false };
  }
  if (!session?.id || session.status !== TABLE_SESSION_STATUSES.OPEN) {
    return { ok: false, reason: "OPEN_TABLE_SESSION_REQUIRED", order };
  }
  return {
    ok: true,
    order: {
      ...order,
      tableSessionId: session.id,
      table: session.tableCode,
      zone: session.zone || context.zone
    },
    attached: true,
    session
  };
}

export function selectOrdersForTableSession(orders = [], sessionOrId) {
  const sessionId = typeof sessionOrId === "string" ? sessionOrId : sessionOrId?.id;
  if (!sessionId) return [];
  return (orders || []).filter((order) => order.tableSessionId === sessionId);
}

export function deriveTableFloorModels({ tables = [], tableSessions = [], orders = [], events = [] } = {}) {
  const repaired = repairDuplicateOpenSessionReferences({
    sessions: normalizeTableSessionList(tableSessions, { tables }),
    orders,
    now: new Date().toISOString()
  });
  const sessions = repaired.ok ? repaired.tableSessions : normalizeTableSessions(tableSessions, { tables });
  const scopedOrders = repaired.ok ? repaired.orders : orders;
  return (tables || []).map((table) => {
    const session = getActiveTableSession(sessions, table.code);
    const sessionOrders = session ? selectOrdersForTableSession(scopedOrders, session) : [];
    const activeSessionOrders = sessionOrders.filter((order) => isOpenOrderStatus(order.status));
    const unresolvedRequests = session
      ? selectUnresolvedSessionRequests(events, session)
      : selectLegacyTableRequests(events, table.code);
    const serviceProgress = aggregateServiceProgress(sessionOrders);
    const outstandingBalance = sessionOrders.reduce((sum, order) => sum + orderBalance(order), 0);
    const prepMetrics = countRemainingPrepWork(activeSessionOrders);
    return {
      table,
      tableCode: table.code,
      zone: table.zone || "",
      status: session ? "occupied" : "vacant",
      occupied: !!session,
      session,
      sessionId: session?.id || "",
      orders: sessionOrders,
      orderBatchCount: sessionOrders.length,
      openOrderBatchCount: sessionOrders.filter((order) => isOpenOrderStatus(order.status)).length,
      servedQty: serviceProgress.servedQty,
      serviceableQty: serviceProgress.serviceableQty,
      readyCount: prepMetrics.readyCount,
      preparingCount: prepMetrics.preparingCount,
      outstandingBalance,
      pendingQrCount: sessionOrders.filter((order) => order.status === "PENDING_ACCEPTANCE").length,
      unresolvedRequests,
      unresolvedRequestCount: unresolvedRequests.length,
      billRequestCount: unresolvedRequests.filter((event) => event.type === "REQUEST_BILL").length,
      callStaffCount: unresolvedRequests.filter((event) => event.type === "CALL_STAFF").length
    };
  });
}

export function canCloseTableSession(sessionOrId, orders = [], tableSessions = []) {
  const session = resolveSession(sessionOrId, tableSessions);
  if (!session?.id) return { ok: false, reason: "SESSION_NOT_FOUND" };
  if (session.status !== TABLE_SESSION_STATUSES.OPEN) return { ok: false, reason: "SESSION_NOT_OPEN", session };

  const linkedOrders = selectOrdersForTableSession(orders, session);
  const activeOrders = linkedOrders.filter((order) => isOpenOrderStatus(order.status));
  if (activeOrders.length) {
    return { ok: false, reason: "ACTIVE_ORDERS", session, orders: linkedOrders, activeOrders };
  }
  return { ok: true, session, orders: linkedOrders, empty: linkedOrders.length === 0 };
}

export function closeTableSession(tableSessions = [], sessionId, options = {}) {
  const sessions = normalizeTableSessions(tableSessions, options);
  const session = sessions.find((item) => item.id === sessionId);
  const closeable = canCloseTableSession(session, options.orders || []);
  if (!closeable.ok) return { ...closeable, tableSessions };

  const closedAt = normalizeIsoTimestamp(options.now) || new Date().toISOString();
  const nextSessions = sessions.map((item) => {
    if (item.id !== sessionId) return item;
    return { ...item, status: TABLE_SESSION_STATUSES.CLOSED, closedAt };
  });
  return {
    ok: true,
    tableSessions: nextSessions,
    session: nextSessions.find((item) => item.id === sessionId),
    closedAt
  };
}

export function reconcileTableSessions(tableSessions = [], orders = [], options = {}) {
  const sessions = normalizeTableSessions(tableSessions, options);
  const closedAt = normalizeIsoTimestamp(options.now) || new Date().toISOString();
  const closedSessions = [];
  const nextSessions = sessions.map((session) => {
    if (session.status !== TABLE_SESSION_STATUSES.OPEN) return session;
    const linkedOrders = selectOrdersForTableSession(orders, session);
    if (!linkedOrders.length || !linkedOrders.every((order) => isClosedOrderStatus(order.status))) return session;
    const closedSession = { ...session, status: TABLE_SESSION_STATUSES.CLOSED, closedAt };
    closedSessions.push(closedSession);
    return closedSession;
  });
  return { ok: true, tableSessions: nextSessions, closedSessions };
}

export function canTransferTableSession({ tableSessions = [], sessionId, toTable, tables = [] } = {}) {
  const sessions = normalizeTableSessions(tableSessions, { tables });
  const session = sessions.find((item) => item.id === sessionId);
  if (!session || session.status !== TABLE_SESSION_STATUSES.OPEN) return { ok: false, reason: "SESSION_NOT_OPEN" };

  const destination = resolvePhysicalTable(toTable, tables);
  if (!destination?.code) return { ok: false, reason: "DESTINATION_TABLE_NOT_FOUND", session };
  if (destination.code === session.tableCode) return { ok: false, reason: "SAME_TABLE", session, destination };

  const destinationSession = getActiveTableSession(sessions, destination.code);
  if (destinationSession && destinationSession.id !== session.id) {
    return { ok: false, reason: "DESTINATION_OCCUPIED", session, destination, destinationSession };
  }
  return { ok: true, session, destination };
}

export function transferTableSession({ tableSessions = [], orders = [], events = [], sessionId, toTable, tables = [] } = {}) {
  const transfer = canTransferTableSession({ tableSessions, sessionId, toTable, tables });
  if (!transfer.ok) return { ...transfer, tableSessions, orders, events };

  const { session, destination } = transfer;
  const nextSessions = normalizeTableSessions(tableSessions, { tables }).map((item) => {
    if (item.id !== session.id) return item;
    return { ...item, tableCode: destination.code, zone: destination.zone || "" };
  });
  const nextOrders = (orders || []).map((order) => {
    if (order.tableSessionId !== session.id) return order;
    return { ...order, table: destination.code, zone: destination.zone || "" };
  });
  const nextEvents = (events || []).map((event) => {
    if (!shouldMoveEventWithTransferredSession(event, session)) return event;
    return { ...event, table: destination.code, zone: destination.zone || "" };
  });

  return {
    ok: true,
    tableSessions: nextSessions,
    orders: nextOrders,
    events: nextEvents,
    session: nextSessions.find((item) => item.id === session.id),
    fromTableCode: session.tableCode,
    toTableCode: destination.code
  };
}

export function backfillLegacyTableSessions({ tableSessions = [], orders = [], tables = [], now } = {}) {
  const repair = repairDuplicateOpenSessionReferences({
    sessions: normalizeTableSessionList(tableSessions, { tables }),
    orders,
    now
  });
  if (!repair.ok) {
    return { ok: false, reason: repair.reason, tableSessions: repair.tableSessions, orders: repair.orders, createdSessions: [] };
  }
  const sessions = repair.tableSessions;
  const nextSessions = [...sessions];
  const createdSessions = [];
  const nextOrders = (repair.orders || []).map((order) => {
    const context = normalizeOrderServiceContext(order);
    if (order.tableSessionId || !isTableServiceContext(context) || !isOpenOrderStatus(order.status)) return order;

    const activeSession = getActiveTableSession(nextSessions, context.table) || createLegacySession(context, nextSessions, tables, now);
    if (!nextSessions.some((session) => session.id === activeSession.id)) {
      nextSessions.push(activeSession);
      createdSessions.push(activeSession);
    }
    return {
      ...order,
      tableSessionId: activeSession.id,
      table: activeSession.tableCode,
      zone: activeSession.zone || context.zone
    };
  });

  return { ok: true, tableSessions: nextSessions, orders: nextOrders, createdSessions, repairedSessions: repair.repairedSessions };
}

function normalizeTableSessionList(tableSessions = [], options = {}) {
  return (tableSessions || [])
    .map((session) => normalizeTableSession(session, options))
    .filter((session) => session.id && session.tableCode);
}

function createLegacySession(context, sessions, tables, now) {
  const table = resolvePhysicalTable(context.table, tables) || { code: context.table, zone: context.zone || "" };
  return {
    id: uniqueSessionId(legacySessionId(table.code), sessions),
    tableCode: table.code,
    zone: table.zone || context.zone || "",
    status: TABLE_SESSION_STATUSES.OPEN,
    openedAt: normalizeIsoTimestamp(now) || new Date().toISOString(),
    closedAt: "",
    openedSource: TABLE_SESSION_SOURCES.LEGACY
  };
}

function repairDuplicateOpenSessionReferences({ sessions = [], orders = [], now } = {}) {
  const canonicalByDuplicateId = new Map();
  const openEntriesByTable = new Map();
  sessions.forEach((session, index) => {
    if (session.status !== TABLE_SESSION_STATUSES.OPEN || !session.tableCode) return;
    const entries = openEntriesByTable.get(session.tableCode) || [];
    entries.push({ session, index });
    openEntriesByTable.set(session.tableCode, entries);
  });

  openEntriesByTable.forEach((entries) => {
    if (entries.length <= 1) return;
    const [canonical, ...duplicates] = entries.sort((left, right) => compareSessionNewestFirst(left.session, right.session));
    duplicates.forEach((entry) => {
      canonicalByDuplicateId.set(entry.session.id, canonical.session);
    });
  });

  if (!canonicalByDuplicateId.size) return { ok: true, tableSessions: sessions, orders, repairedSessions: [] };

  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  let unsafeOrder = null;
  const nextOrders = (orders || []).map((order) => {
    const canonical = canonicalByDuplicateId.get(order.tableSessionId);
    if (!canonical || !isOpenOrderStatus(order.status)) return order;
    const duplicate = sessionsById.get(order.tableSessionId);
    if (!canReconcileOrderToSession(order, duplicate, canonical)) {
      unsafeOrder = order;
      return order;
    }
    return {
      ...order,
      tableSessionId: canonical.id,
      table: canonical.tableCode,
      zone: canonical.zone || order.zone || ""
    };
  });

  if (unsafeOrder) {
    return {
      ok: false,
      reason: "UNSAFE_DUPLICATE_OPEN_SESSION_REPAIR",
      tableSessions: sessions,
      orders,
      unsafeOrder
    };
  }

  const repairedSessions = [];
  const nextSessions = sessions.map((session) => {
    const canonical = canonicalByDuplicateId.get(session.id);
    if (!canonical) return session;
    const repaired = {
      ...session,
      status: TABLE_SESSION_STATUSES.CLOSED,
      closedAt: duplicateSessionClosedAt(session, canonical, { now })
    };
    repairedSessions.push(repaired);
    return repaired;
  });

  return { ok: true, tableSessions: nextSessions, orders: nextOrders, repairedSessions };
}

function canReconcileOrderToSession(order, duplicate, canonical) {
  if (!duplicate?.id || !canonical?.id) return false;
  const context = normalizeOrderServiceContext(order);
  if (!isTableServiceContext(context)) return false;
  const orderTable = normalizePhysicalTableCode(order.table || context.table);
  return !orderTable || orderTable === duplicate.tableCode || orderTable === canonical.tableCode;
}

function enforceOneOpenSessionPerTable(sessions = [], options = {}) {
  const openEntriesByTable = new Map();
  sessions.forEach((session, index) => {
    if (session.status !== TABLE_SESSION_STATUSES.OPEN || !session.tableCode) return;
    const entries = openEntriesByTable.get(session.tableCode) || [];
    entries.push({ session, index });
    openEntriesByTable.set(session.tableCode, entries);
  });

  const duplicateClosedAtByIndex = new Map();
  openEntriesByTable.forEach((entries) => {
    if (entries.length <= 1) return;
    const [keeper, ...duplicates] = entries.sort((left, right) => compareSessionNewestFirst(left.session, right.session));
    duplicates.forEach((entry) => {
      duplicateClosedAtByIndex.set(entry.index, duplicateSessionClosedAt(entry.session, keeper.session, options));
    });
  });

  if (!duplicateClosedAtByIndex.size) return sessions;
  return sessions.map((session, index) => {
    if (!duplicateClosedAtByIndex.has(index)) return session;
    return {
      ...session,
      status: TABLE_SESSION_STATUSES.CLOSED,
      closedAt: duplicateClosedAtByIndex.get(index)
    };
  });
}

function duplicateSessionClosedAt(session, keeper, options = {}) {
  return normalizeIsoTimestamp(session.closedAt)
    || normalizeIsoTimestamp(options.now)
    || normalizeIsoTimestamp(session.openedAt)
    || normalizeIsoTimestamp(keeper.openedAt)
    || new Date().toISOString();
}

function selectUnresolvedSessionRequests(events = [], session) {
  return (events || []).filter((event) => {
    if (event.done) return false;
    if (event.tableSessionId) return event.tableSessionId === session.id;
    return event.table === session.tableCode;
  });
}

function selectLegacyTableRequests(events = [], tableCode) {
  return (events || []).filter((event) => !event.done && !event.tableSessionId && event.table === tableCode);
}

function shouldMoveEventWithTransferredSession(event = {}, session = {}) {
  if (event.done) return false;
  if (event.tableSessionId) return event.tableSessionId === session.id;
  return normalizePhysicalTableCode(event.table) === session.tableCode;
}

function aggregateServiceProgress(orders = []) {
  return (orders || []).reduce((total, order) => {
    const progress = getServiceProgress(order);
    total.serviceableQty += progress.serviceableQty;
    total.servedQty += progress.servedQty;
    return total;
  }, { serviceableQty: 0, servedQty: 0 });
}

function countRemainingPrepWork(orders = []) {
  return (orders || []).reduce((metrics, order) => {
    (order.items || []).forEach((line) => {
      if (!isRequiredStationLine(line)) return;
      const remainingQty = normalizeServiceProgress(line).remainingQty;
      if (remainingQty <= 0) return;
      const prepStatus = normalizePrepStatus(line.prepStatus || line.status);
      if (prepStatus === "READY") metrics.readyCount += remainingQty;
      else if (PREPARING_WORK_STATUSES.includes(prepStatus)) metrics.preparingCount += remainingQty;
    });
    return metrics;
  }, { readyCount: 0, preparingCount: 0 });
}

function orderBalance(order = {}) {
  return Math.max(0, (Number(order.total) || 0) - (Number(order.paidVnd) || 0));
}

function isTableServiceContext(context = {}) {
  return context.serviceMode === SERVICE_MODES.TABLE_SERVICE
    && context.fulfillmentType === FULFILLMENT_TYPES.DINE_IN
    && !!context.table;
}

function resolvePhysicalTable(tableInput, tables = []) {
  const tableCode = typeof tableInput === "object"
    ? normalizePhysicalTableCode(tableInput?.code || tableInput?.tableCode)
    : normalizePhysicalTableCode(tableInput);
  if (!tableCode) return null;

  const table = (tables || []).find((item) => item.code === tableCode);
  if (table) return table;
  if ((tables || []).length && typeof tableInput !== "object") return null;
  return {
    code: tableCode,
    zone: typeof tableInput === "object" ? String(tableInput?.zone || "").trim() : ""
  };
}

function resolveSession(sessionOrId, tableSessions = []) {
  if (typeof sessionOrId === "string") {
    return normalizeTableSessions(tableSessions).find((session) => session.id === sessionOrId) || null;
  }
  return sessionOrId ? normalizeTableSession(sessionOrId) : null;
}

function normalizeTableSessionStatus(status) {
  return String(status || "").trim().toUpperCase() === TABLE_SESSION_STATUSES.CLOSED
    ? TABLE_SESSION_STATUSES.CLOSED
    : TABLE_SESSION_STATUSES.OPEN;
}

function normalizeTableSessionSource(source) {
  const key = String(source || "").trim().toUpperCase();
  if (key === "QR") return TABLE_SESSION_SOURCES.CUSTOMER_QR;
  if (Object.values(TABLE_SESSION_SOURCES).includes(key)) return key;
  return TABLE_SESSION_SOURCES.STAFF;
}

function defaultTableSessionId({ tableCode, now }) {
  const timestamp = normalizeIsoTimestamp(now).replace(/[-:.TZ]/g, "").slice(0, 14) || "00000000000000";
  return `TS-${safeIdPart(tableCode)}-${timestamp}`;
}

function legacySessionId(tableCode) {
  return `TS-LEGACY-${safeIdPart(tableCode)}`;
}

function uniqueSessionId(id, sessions) {
  const baseId = String(id || "TS").trim();
  const existing = new Set((sessions || []).map((session) => session.id));
  if (!existing.has(baseId)) return baseId;
  let index = 2;
  while (existing.has(`${baseId}-${index}`)) index += 1;
  return `${baseId}-${index}`;
}

function safeIdPart(value) {
  return String(value || "TABLE").replace(/[^a-zA-Z0-9_-]+/g, "-").toUpperCase();
}

function compareSessionNewestFirst(left, right) {
  const byOpenedAt = String(right.openedAt || "").localeCompare(String(left.openedAt || ""));
  if (byOpenedAt) return byOpenedAt;
  return String(right.id || "").localeCompare(String(left.id || ""));
}

function normalizeIsoTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "";
}
