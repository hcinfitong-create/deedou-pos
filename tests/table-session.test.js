import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPrepStatusTransition,
  buildCounterOrderServiceContext,
  FULFILLMENT_TYPES,
  serveLineQuantity,
  SERVICE_MODES
} from "../src/features/ordering/index.js";
import {
  attachOrderToTableSession,
  backfillLegacyTableSessions,
  canCloseTableSession,
  closeTableSession,
  deriveTableFloorModels,
  getActiveTableSession,
  normalizeTableSessions,
  openOrReuseTableSession,
  repairTableSessionGraph,
  reconcileTableSessions,
  selectOrdersForTableSession,
  transferTableSession
} from "../src/features/table-session/index.js";

const tables = [
  { code: "A01", zone: "Beach" },
  { code: "B01", zone: "Indoor" },
  { code: "C01", zone: "Camping" }
];

const now = "2026-08-11T08:00:00.000Z";

function tableOrder(overrides = {}) {
  return {
    id: "order-1",
    orderNo: "D01-0001",
    status: "ACCEPTED",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "CUSTOMER_QR",
    table: "A01",
    zone: "Beach",
    total: 100000,
    paidVnd: 0,
    payments: [],
    items: [{ lineId: "tea-1", station: "BAR_TEA", qty: 1, prepStatus: "QUEUED", status: "QUEUED", servedQty: 0, billQty: 1, isBillable: true }],
    ...overrides
  };
}

test("opening a session on a vacant physical table succeeds", () => {
  const result = openOrReuseTableSession([], {
    table: tables[0],
    source: "CUSTOMER_QR",
    now,
    generateId: () => "TS-001"
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.session.id, "TS-001");
  assert.equal(result.session.tableCode, "A01");
  assert.equal(result.session.zone, "Beach");
  assert.equal(result.session.status, "OPEN");
  assert.equal(result.tableSessions.length, 1);
});

test("opening the same table again reuses the existing open session", () => {
  const first = openOrReuseTableSession([], { table: tables[0], now, generateId: () => "TS-A01" });
  const second = openOrReuseTableSession(first.tableSessions, { table: tables[0], now, generateId: () => "TS-NEW" });

  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.session.id, "TS-A01");
  assert.equal(second.tableSessions.length, 1);
});

test("two physical tables may have separate open sessions", () => {
  const first = openOrReuseTableSession([], { table: tables[0], now, generateId: () => "TS-A01" });
  const second = openOrReuseTableSession(first.tableSessions, { table: tables[1], now, generateId: () => "TS-B01" });

  assert.deepEqual(second.tableSessions.map((session) => session.id), ["TS-A01", "TS-B01"]);
});

test("counter/takeaway order does not create or require a session", () => {
  const order = {
    id: "takeaway",
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    orderSource: "COUNTER",
    tableSessionId: "TS-stale"
  };
  const result = attachOrderToTableSession(order, null);

  assert.equal(result.ok, true);
  assert.equal(result.attached, false);
  assert.equal("tableSessionId" in result.order, false);
});

test("first QR order creates a table session and receives tableSessionId", () => {
  const opened = openOrReuseTableSession([], { table: tables[0], source: "CUSTOMER_QR", now, generateId: () => "TS-QR" });
  const attached = attachOrderToTableSession(tableOrder({ id: "qr-1", status: "PENDING_ACCEPTANCE" }), opened.session);

  assert.equal(attached.ok, true);
  assert.equal(attached.order.tableSessionId, "TS-QR");
  assert.equal(attached.order.table, "A01");
});

test("later QR order at the same open table reuses the same session", () => {
  const opened = openOrReuseTableSession([], { table: tables[0], source: "CUSTOMER_QR", now, generateId: () => "TS-QR" });
  const reused = openOrReuseTableSession(opened.tableSessions, { table: tables[0], source: "CUSTOMER_QR", now, generateId: () => "TS-OTHER" });

  assert.equal(reused.reused, true);
  assert.equal(reused.session.id, "TS-QR");
});

test("cashier/staff table order reuses the active session", () => {
  const opened = openOrReuseTableSession([], { table: tables[0], source: "CUSTOMER_QR", now, generateId: () => "TS-A01" });
  const reused = openOrReuseTableSession(opened.tableSessions, { table: tables[0], source: "COUNTER", now, generateId: () => "TS-COUNTER" });
  const attached = attachOrderToTableSession(tableOrder({ id: "cashier-1", orderSource: "COUNTER" }), reused.session);

  assert.equal(reused.session.id, "TS-A01");
  assert.equal(attached.order.tableSessionId, "TS-A01");
});

test("multiple order batches select correctly by session ID", () => {
  const orders = [
    tableOrder({ id: "one", tableSessionId: "TS-A01" }),
    tableOrder({ id: "two", tableSessionId: "TS-A01" }),
    tableOrder({ id: "other", tableSessionId: "TS-B01", table: "B01" })
  ];

  assert.deepEqual(selectOrdersForTableSession(orders, "TS-A01").map((order) => order.id), ["one", "two"]);
});

test("legacy open table orders are grouped into one deterministic legacy session per physical table", () => {
  const orders = [
    tableOrder({ id: "legacy-1", tableSessionId: "" }),
    tableOrder({ id: "legacy-2", orderNo: "D01-0002", tableSessionId: "" })
  ];

  const result = backfillLegacyTableSessions({ orders, tables, now });

  assert.equal(result.createdSessions.length, 1);
  assert.equal(result.createdSessions[0].id, "TS-LEGACY-A01");
  assert.deepEqual(result.orders.map((order) => order.tableSessionId), ["TS-LEGACY-A01", "TS-LEGACY-A01"]);
});

test("legacy counter/takeaway orders are not backfilled into a table session", () => {
  const orders = [
    {
      id: "takeaway",
      status: "ACCEPTED",
      serviceMode: "COUNTER_SERVICE",
      fulfillmentType: "TAKEAWAY",
      orderSource: "COUNTER",
      table: "",
      items: []
    }
  ];

  const result = backfillLegacyTableSessions({ orders, tables, now });

  assert.equal(result.tableSessions.length, 0);
  assert.equal(result.orders[0].tableSessionId, undefined);
});

test("only one open session may exist per physical table through open/reuse", () => {
  const opened = openOrReuseTableSession([], { table: tables[0], now, generateId: () => "TS-A01" });
  const reused = openOrReuseTableSession(opened.tableSessions, { table: tables[0], now, generateId: () => "TS-A01-2" });

  assert.equal(reused.tableSessions.filter((session) => session.status === "OPEN" && session.tableCode === "A01").length, 1);
});

test("normalization closes duplicate open sessions for one physical table", () => {
  const sessions = normalizeTableSessions([
    { id: "TS-old", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T08:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-new", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T09:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-B01", tableCode: "B01", zone: "Indoor", status: "OPEN", openedAt: "2026-08-11T08:30:00.000Z", openedSource: "STAFF" }
  ], { now: "2026-08-11T10:00:00.000Z" });

  assert.deepEqual(sessions.filter((session) => session.tableCode === "A01" && session.status === "OPEN").map((session) => session.id), ["TS-new"]);
  assert.equal(sessions.find((session) => session.id === "TS-old").status, "CLOSED");
  assert.equal(sessions.find((session) => session.id === "TS-old").closedAt, "2026-08-11T10:00:00.000Z");
  assert.deepEqual(sessions.filter((session) => session.status === "OPEN").map((session) => session.id), ["TS-new", "TS-B01"]);
});

test("duplicate open session repair preserves active order references in the canonical visit", () => {
  const sessions = [
    { id: "TS-old", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T08:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-new", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T09:00:00.000Z", openedSource: "STAFF" }
  ];
  const oldItems = [{ lineId: "tea-1", station: "BAR_TEA", qty: 2, prepStatus: "PREPARING", status: "PREPARING", servedQty: 1, billQty: 2, isBillable: true }];
  const newItems = [{ lineId: "coffee-1", station: "BAR_COFFEE", qty: 1, prepStatus: "QUEUED", status: "QUEUED", servedQty: 0, billQty: 1, isBillable: true }];
  const oldPayments = [{ id: "PAY-old", amountVnd: 20000, method: "CASH" }];
  const orders = [
    tableOrder({ id: "O1", orderNo: "D01-0001", tableSessionId: "TS-old", status: "IN_PREPARATION", total: 120000, paidVnd: 20000, payments: oldPayments, items: oldItems }),
    tableOrder({ id: "O2", orderNo: "D01-0002", tableSessionId: "TS-new", status: "ACCEPTED", total: 39000, paidVnd: 0, payments: [], items: newItems })
  ];

  const result = backfillLegacyTableSessions({ tableSessions: sessions, orders, tables, now: "2026-08-11T10:00:00.000Z" });
  const openA01Sessions = result.tableSessions.filter((session) => session.tableCode === "A01" && session.status === "OPEN");
  const closedSessionIds = new Set(result.tableSessions.filter((session) => session.status === "CLOSED").map((session) => session.id));
  const activeOrders = result.orders.filter((order) => ["O1", "O2"].includes(order.id));
  const model = deriveTableFloorModels({ tables, tableSessions: result.tableSessions, orders: result.orders, events: [] }).find((item) => item.tableCode === "A01");
  const directModel = deriveTableFloorModels({ tables, tableSessions: sessions, orders, events: [] }).find((item) => item.tableCode === "A01");

  assert.equal(result.ok, true);
  assert.deepEqual(openA01Sessions.map((session) => session.id), ["TS-new"]);
  assert.deepEqual(activeOrders.map((order) => order.tableSessionId), ["TS-new", "TS-new"]);
  assert.deepEqual(activeOrders.filter((order) => closedSessionIds.has(order.tableSessionId)), []);
  assert.deepEqual(selectOrdersForTableSession(result.orders, "TS-new").map((order) => order.id), ["O1", "O2"]);
  assert.deepEqual(model.orders.map((order) => order.id), ["O1", "O2"]);
  assert.deepEqual(directModel.orders.map((order) => order.id), ["O1", "O2"]);
  assert.equal(result.orders[0].total, 120000);
  assert.equal(result.orders[0].paidVnd, 20000);
  assert.deepEqual(result.orders[0].payments, oldPayments);
  assert.deepEqual(result.orders[0].items, oldItems);
  assert.deepEqual(result.orders[1].items, newItems);
});

test("duplicate open session repair reattaches unresolved modern service requests to the canonical visit", () => {
  const sessions = [
    { id: "TS-old", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T08:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-new", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T09:00:00.000Z", openedSource: "STAFF" }
  ];
  const events = [
    { id: "modern-old", type: "CALL_STAFF", table: "A01", zone: "Beach", tableSessionId: "TS-old", done: false },
    { id: "modern-done", type: "REQUEST_BILL", table: "A01", zone: "Beach", tableSessionId: "TS-old", done: true },
    { id: "modern-other", type: "CALL_STAFF", table: "A01", zone: "Beach", tableSessionId: "TS-other", done: false }
  ];

  const result = backfillLegacyTableSessions({ tableSessions: sessions, orders: [], events, tables, now: "2026-08-11T10:00:00.000Z" });
  const request = result.events.find((event) => event.id === "modern-old");
  const model = deriveTableFloorModels({ tables, tableSessions: result.tableSessions, orders: result.orders, events: result.events })
    .find((item) => item.tableCode === "A01");
  const directModel = deriveTableFloorModels({ tables, tableSessions: sessions, orders: [], events })
    .find((item) => item.tableCode === "A01");

  assert.equal(result.ok, true);
  assert.equal(request.tableSessionId, "TS-new");
  assert.equal(request.table, "A01");
  assert.equal(request.zone, "Beach");
  assert.equal(result.events.find((event) => event.id === "modern-done").tableSessionId, "TS-old");
  assert.equal(result.events.find((event) => event.id === "modern-other").tableSessionId, "TS-other");
  assert.deepEqual(model.unresolvedRequests.map((event) => event.id), ["modern-old"]);
  assert.deepEqual(directModel.unresolvedRequests.map((event) => event.id), ["modern-old"]);
});

test("unsafe duplicate open session repair fails without blind closing or reference mutation", () => {
  const sessions = [
    { id: "TS-old", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T08:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-new", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T09:00:00.000Z", openedSource: "STAFF" }
  ];
  const orders = [
    tableOrder({ id: "unsafe", orderNo: "D01-0001", table: "C01", zone: "Camping", tableSessionId: "TS-old" }),
    tableOrder({ id: "safe", orderNo: "D01-0002", tableSessionId: "TS-new" })
  ];
  const events = [
    { id: "request-old", type: "CALL_STAFF", table: "A01", zone: "Beach", tableSessionId: "TS-old", done: false }
  ];

  const result = backfillLegacyTableSessions({ tableSessions: sessions, orders, events, tables, now: "2026-08-11T10:00:00.000Z" });
  const model = deriveTableFloorModels({ tables, tableSessions: result.tableSessions, orders: result.orders, events: result.events })
    .find((item) => item.tableCode === "A01");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNSAFE_DUPLICATE_OPEN_SESSION_REPAIR");
  assert.deepEqual(result.tableSessions.filter((session) => session.tableCode === "A01" && session.status === "OPEN").map((session) => session.id), ["TS-old", "TS-new"]);
  assert.deepEqual(result.orders, orders);
  assert.deepEqual(result.events, events);
  assert.deepEqual(model.orders.map((order) => order.id), ["unsafe", "safe"]);
  assert.deepEqual(model.unresolvedRequests.map((event) => event.id), ["request-old"]);
});

test("unsafe duplicate graph blocks close reconcile and transfer without mutating active work", () => {
  const sessions = [
    { id: "TS-old", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T08:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-new", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T09:00:00.000Z", openedSource: "STAFF" }
  ];
  const orders = [
    tableOrder({ id: "unsafe", orderNo: "D01-0001", table: "C01", zone: "Camping", tableSessionId: "TS-old" }),
    tableOrder({ id: "safe", orderNo: "D01-0002", tableSessionId: "TS-new" })
  ];
  const events = [
    { id: "request-old", type: "CALL_STAFF", table: "A01", zone: "Beach", tableSessionId: "TS-old", done: false }
  ];
  const graph = repairTableSessionGraph({ tableSessions: sessions, orders, events, tables, now: "2026-08-11T10:00:00.000Z" });
  const closeResult = closeTableSession(sessions, "TS-new", { orders, events, tables, now: "2026-08-11T10:00:00.000Z" });
  const reconcileResult = reconcileTableSessions(sessions, orders, { events, tables, now: "2026-08-11T10:00:00.000Z" });
  const transferResult = transferTableSession({ tableSessions: sessions, orders, events, sessionId: "TS-new", toTable: tables[1], tables });

  [graph, closeResult, reconcileResult, transferResult].forEach((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, "UNSAFE_DUPLICATE_OPEN_SESSION_REPAIR");
    assert.deepEqual(result.tableSessions, sessions);
    assert.deepEqual(result.orders, orders);
    assert.deepEqual(result.events, events);
  });
  assert.deepEqual(closeResult.closedSessions, []);
  assert.deepEqual(reconcileResult.closedSessions, []);
});

test("floor-plan selector marks a table vacant when no open session exists", () => {
  const models = deriveTableFloorModels({ tables, tableSessions: [], orders: [], events: [] });

  assert.equal(models.find((model) => model.tableCode === "A01").status, "vacant");
});

test("floor-plan selector marks an open session occupied even with no order batches", () => {
  const opened = openOrReuseTableSession([], { table: tables[0], now, generateId: () => "TS-A01" });
  const model = deriveTableFloorModels({ tables, tableSessions: opened.tableSessions, orders: [], events: [] })
    .find((item) => item.tableCode === "A01");

  assert.equal(model.occupied, true);
  assert.equal(model.orderBatchCount, 0);
  assert.equal(model.sessionId, "TS-A01");
});

test("floor-plan metrics derive only from the current session's orders", () => {
  const sessions = [
    { id: "TS-old", tableCode: "A01", zone: "Beach", status: "CLOSED", openedAt: now, closedAt: "2026-08-11T09:00:00.000Z", openedSource: "CUSTOMER_QR" },
    { id: "TS-new", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T10:00:00.000Z", closedAt: "", openedSource: "CUSTOMER_QR" }
  ];
  const orders = [
    tableOrder({ id: "old", tableSessionId: "TS-old", total: 999000, paidVnd: 0 }),
    tableOrder({ id: "new", tableSessionId: "TS-new", status: "PENDING_ACCEPTANCE", total: 120000, paidVnd: 20000 })
  ];

  const model = deriveTableFloorModels({ tables, tableSessions: sessions, orders, events: [] }).find((item) => item.tableCode === "A01");

  assert.deepEqual(model.orders.map((order) => order.id), ["new"]);
  assert.equal(model.outstandingBalance, 100000);
  assert.equal(model.pendingQrCount, 1);
});

test("floor-plan prep metrics ignore fully served quantities and closed batches", () => {
  const sessions = [
    { id: "TS-current", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, closedAt: "", openedSource: "CUSTOMER_QR" }
  ];
  const orders = [
    tableOrder({
      id: "served-open",
      tableSessionId: "TS-current",
      status: "SERVED",
      items: [{ lineId: "served", station: "BAR_TEA", qty: 2, prepStatus: "READY", status: "SERVED", servedQty: 2, billQty: 2, isBillable: true }]
    }),
    tableOrder({
      id: "paid-queued",
      tableSessionId: "TS-current",
      status: "PAID",
      items: [{ lineId: "paid", station: "KITCHEN_HOT", qty: 3, prepStatus: "QUEUED", status: "QUEUED", servedQty: 0, billQty: 3, isBillable: true }]
    }),
    tableOrder({
      id: "voided-ready",
      tableSessionId: "TS-current",
      status: "VOIDED",
      items: [{ lineId: "voided", station: "DESSERT", qty: 1, prepStatus: "READY", status: "READY", servedQty: 0, billQty: 1, isBillable: true }]
    }),
    tableOrder({
      id: "active-mixed",
      tableSessionId: "TS-current",
      status: "IN_PREPARATION",
      items: [
        { lineId: "ready-remaining", station: "BAR_COFFEE", qty: 2, prepStatus: "READY", status: "READY", servedQty: 1, billQty: 2, isBillable: true },
        { lineId: "preparing-remaining", station: "KITCHEN_HOT", qty: 2, prepStatus: "PREPARING", status: "PREPARING", servedQty: 1, billQty: 2, isBillable: true },
        { lineId: "queued", station: "DESSERT", qty: 1, prepStatus: "QUEUED", status: "QUEUED", servedQty: 0, billQty: 1, isBillable: true },
        { lineId: "held-course", station: "KITCHEN_HOT", qty: 3, prepStatus: "QUEUED", status: "QUEUED", holdState: "HELD", servedQty: 0, billQty: 3, isBillable: true }
      ]
    })
  ];

  const model = deriveTableFloorModels({ tables, tableSessions: sessions, orders, events: [] }).find((item) => item.tableCode === "A01");

  assert.equal(model.readyCount, 1);
  assert.equal(model.preparingCount, 2);
});

test("manual close fails when session still has open orders", () => {
  const session = { id: "TS-A01", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const result = closeTableSession([session], "TS-A01", { orders: [tableOrder({ tableSessionId: "TS-A01" })], now });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "ACTIVE_ORDERS");
});

test("empty session can close and receives deterministic closedAt", () => {
  const session = { id: "TS-empty", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const result = closeTableSession([session], "TS-empty", { orders: [], now: "2026-08-11T11:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.session.status, "CLOSED");
  assert.equal(result.session.closedAt, "2026-08-11T11:00:00.000Z");
});

test("reconciliation closes a session after its last linked order becomes terminal", () => {
  const session = { id: "TS-paid", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "CUSTOMER_QR" };
  const result = reconcileTableSessions([session], [tableOrder({ tableSessionId: "TS-paid", status: "PAID" })], { now: "2026-08-11T12:00:00.000Z" });

  assert.equal(result.closedSessions.length, 1);
  assert.equal(result.tableSessions[0].status, "CLOSED");
});

test("closed session is never reused when the same physical table opens a new visit", () => {
  const closed = { id: "TS-old", tableCode: "A01", zone: "Beach", status: "CLOSED", openedAt: now, closedAt: "2026-08-11T12:00:00.000Z", openedSource: "CUSTOMER_QR" };
  const opened = openOrReuseTableSession([closed], { table: tables[0], now: "2026-08-11T13:00:00.000Z", generateId: () => "TS-new" });

  assert.equal(opened.created, true);
  assert.equal(opened.session.id, "TS-new");
  assert.equal(opened.tableSessions.length, 2);
});

test("transfer to a vacant destination succeeds and preserves session ID", () => {
  const session = { id: "TS-move", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const result = transferTableSession({ tableSessions: [session], orders: [], events: [], sessionId: "TS-move", toTable: tables[1], tables });

  assert.equal(result.ok, true);
  assert.equal(result.session.id, "TS-move");
  assert.equal(result.fromTableCode, "A01");
  assert.equal(result.toTableCode, "B01");
});

test("transfer to an occupied destination fails without mutation", () => {
  const sessions = [
    { id: "TS-A01", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" },
    { id: "TS-B01", tableCode: "B01", zone: "Indoor", status: "OPEN", openedAt: now, openedSource: "STAFF" }
  ];
  const orders = [tableOrder({ id: "order-a", tableSessionId: "TS-A01" })];
  const before = structuredClone({ sessions, orders });

  const result = transferTableSession({ tableSessions: sessions, orders, events: [], sessionId: "TS-A01", toTable: tables[1], tables });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "DESTINATION_OCCUPIED");
  assert.deepEqual({ sessions, orders }, before);
});

test("transfer updates session physical table and zone context", () => {
  const session = { id: "TS-move", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const result = transferTableSession({ tableSessions: [session], orders: [], events: [], sessionId: "TS-move", toTable: tables[1], tables });

  assert.equal(result.session.tableCode, "B01");
  assert.equal(result.session.zone, "Indoor");
  assert.equal(getActiveTableSession(result.tableSessions, "B01").id, "TS-move");
});

test("transfer updates linked order table/zone without mutating prep/service/billing/payment data", () => {
  const session = { id: "TS-move", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const order = tableOrder({
    tableSessionId: "TS-move",
    total: 220000,
    paidVnd: 50000,
    payments: [{ id: "PAY-1", amountVnd: 50000 }],
    items: [{ lineId: "tea-1", station: "BAR_TEA", qty: 2, prepStatus: "PREPARING", status: "PREPARING", servedQty: 1, billQty: 1, isBillable: true }]
  });

  const result = transferTableSession({ tableSessions: [session], orders: [order], events: [], sessionId: "TS-move", toTable: tables[1], tables });

  assert.equal(result.orders[0].table, "B01");
  assert.equal(result.orders[0].zone, "Indoor");
  assert.equal(result.orders[0].total, 220000);
  assert.equal(result.orders[0].paidVnd, 50000);
  assert.deepEqual(result.orders[0].payments, [{ id: "PAY-1", amountVnd: 50000 }]);
  assert.deepEqual(result.orders[0].items, order.items);
});

test("unresolved service request follows a transferred session", () => {
  const session = { id: "TS-move", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const events = [{ id: "E1", type: "CALL_STAFF", table: "A01", zone: "Beach", tableSessionId: "TS-move", done: false }];

  const result = transferTableSession({ tableSessions: [session], orders: [], events, sessionId: "TS-move", toTable: tables[1], tables });

  assert.equal(result.events[0].table, "B01");
  assert.equal(result.events[0].zone, "Indoor");
});

test("legacy unresolved service request follows a transferred active table session", () => {
  const session = { id: "TS-move", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const events = [
    { id: "legacy-open", type: "CALL_STAFF", table: "A01", zone: "Beach", done: false },
    { id: "legacy-done", type: "REQUEST_BILL", table: "A01", zone: "Beach", done: true },
    { id: "modern-other", type: "CALL_STAFF", table: "A01", zone: "Beach", tableSessionId: "TS-other", done: false },
    { id: "unrelated", type: "CALL_STAFF", table: "C01", zone: "Camping", done: false }
  ];

  const result = transferTableSession({ tableSessions: [session], orders: [], events, sessionId: "TS-move", toTable: tables[1], tables });

  assert.deepEqual(result.events.find((event) => event.id === "legacy-open"), { id: "legacy-open", type: "CALL_STAFF", table: "B01", zone: "Indoor", done: false });
  assert.equal(result.events.find((event) => event.id === "legacy-done").table, "A01");
  assert.equal(result.events.find((event) => event.id === "modern-other").table, "A01");
  assert.equal(result.events.find((event) => event.id === "unrelated").table, "C01");
});

test("source table becomes vacant and destination occupied after transfer", () => {
  const session = { id: "TS-move", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: now, openedSource: "STAFF" };
  const moved = transferTableSession({ tableSessions: [session], orders: [], events: [], sessionId: "TS-move", toTable: tables[1], tables });
  const models = deriveTableFloorModels({ tables, tableSessions: moved.tableSessions, orders: [], events: [] });

  assert.equal(models.find((model) => model.tableCode === "A01").occupied, false);
  assert.equal(models.find((model) => model.tableCode === "B01").occupied, true);
});

test("DD-003 station prep and item serving remain valid for orders attached to a table session", () => {
  const order = tableOrder({ tableSessionId: "TS-A01" });

  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "ACKNOWLEDGED", { now }).ok, true);
  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "PREPARING", { now: "2026-08-11T08:01:00.000Z" }).ok, true);
  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "READY", { now: "2026-08-11T08:02:00.000Z" }).ok, true);
  assert.equal(serveLineQuantity(order, "tea-1", 1, { now: "2026-08-11T08:03:00.000Z" }).ok, true);
  assert.equal(order.status, "SERVED");
  assert.equal(order.items[0].servedQty, 1);
});

test("DD-002.1 counter/table service-context behavior remains valid", () => {
  const tableContext = buildCounterOrderServiceContext({ tableCode: "A01", physicalTable: tables[0] });
  const takeawayContext = buildCounterOrderServiceContext({ tableCode: "TAKEAWAY", physicalTable: null });

  assert.equal(tableContext.serviceMode, SERVICE_MODES.TABLE_SERVICE);
  assert.equal(tableContext.fulfillmentType, FULFILLMENT_TYPES.DINE_IN);
  assert.equal(tableContext.table, "A01");
  assert.equal(takeawayContext.serviceMode, SERVICE_MODES.COUNTER_SERVICE);
  assert.equal(takeawayContext.fulfillmentType, FULFILLMENT_TYPES.TAKEAWAY);
  assert.equal(takeawayContext.table, "");
});
