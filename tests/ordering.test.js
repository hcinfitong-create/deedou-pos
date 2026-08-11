import test from "node:test";
import assert from "node:assert/strict";

import {
  applyOrderStatusTransition,
  applyStationStatusUpdate,
  billableTotal,
  canTransitionOrderStatus,
  clampBillQty,
  deriveOrderStatusFromStations,
  expandOrderLines,
  FULFILLMENT_TYPES,
  getAllowedOrderStatusTransitions,
  isOpenPhysicalTableOrder,
  normalizeOrderServiceContext,
  normalizeOrderSource,
  normalizeOrderStatus,
  normalizeOrderTimestamps,
  ORDER_SOURCES,
  SERVICE_MODES,
  validateOrderServiceContext,
  stationStatusFor
} from "../src/features/ordering/index.js";

test("clampBillQty keeps bill quantity inside valid bounds", () => {
  assert.equal(clampBillQty(5, 3), 3);
  assert.equal(clampBillQty(-2, 3), 0);
  assert.equal(clampBillQty(undefined, 3), 3);
});

test("expandOrderLines expands combo components while billing only parent", () => {
  const products = new Map([
    ["combo", {
      id: "combo",
      vi: "Combo",
      en: "Combo",
      price: 300000,
      station: "KITCHEN_BBQ",
      components: [
        { vi: "Tôm", en: "Shrimp", qty: 2, station: "KITCHEN_BBQ" },
        { vi: "Trà", en: "Tea", qty: 1, station: "BAR_TEA" }
      ]
    }]
  ]);

  const lines = expandOrderLines([{ id: "combo", qty: 2 }], (id) => products.get(id) ?? null);

  assert.equal(lines.length, 3);
  assert.equal(lines[0].station, "COMBO");
  assert.equal(lines[0].isBillable, true);
  assert.equal(lines[1].qty, 4);
  assert.equal(lines[1].isBillable, false);
  assert.equal(lines[2].qty, 2);
  assert.equal(billableTotal(lines), 600000);
});

test("expandOrderLines drops missing product references instead of substituting another item", () => {
  const lines = expandOrderLines([{ id: "missing", qty: 1 }], () => null);
  assert.deepEqual(lines, []);
});

test("order status normalization preserves canonical status", () => {
  assert.equal(normalizeOrderStatus("PENDING"), "PENDING_ACCEPTANCE");
  assert.equal(normalizeOrderStatus("READY"), "READY");
});

test("station status derives only non-combo stations", () => {
  const statuses = stationStatusFor([
    { station: "COMBO" },
    { station: "BAR_TEA" },
    { station: "KITCHEN_HOT" }
  ], "PENDING_ACCEPTANCE");

  assert.deepEqual(statuses, {
    BAR_TEA: "QUEUED",
    KITCHEN_HOT: "QUEUED"
  });
});

test("direct order transition graph allows only deterministic staff and cashier moves", () => {
  assert.deepEqual(getAllowedOrderStatusTransitions("PENDING_ACCEPTANCE"), ["ACCEPTED", "REJECTED"]);
  assert.deepEqual(getAllowedOrderStatusTransitions("ACCEPTED"), ["IN_PREPARATION", "REJECTED"]);
  assert.deepEqual(getAllowedOrderStatusTransitions("IN_PREPARATION"), []);
  assert.equal(canTransitionOrderStatus("PENDING_ACCEPTANCE", "READY"), false);
  assert.equal(canTransitionOrderStatus("ACCEPTED", "REJECTED"), true);
  assert.equal(canTransitionOrderStatus("ACCEPTED", "IN_PREPARATION"), true);
  assert.equal(canTransitionOrderStatus("IN_PREPARATION", "READY"), false);
  assert.equal(canTransitionOrderStatus("READY", "SERVED"), true);
  assert.equal(canTransitionOrderStatus("SERVED", "PAID"), true);
});

test("invalid direct order status transition does not mutate order", () => {
  const order = {
    status: "PENDING_ACCEPTANCE",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ station: "BAR_TEA", status: "QUEUED" }]
  };

  const result = applyOrderStatusTransition(order, "READY");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_STATUS_TRANSITION");
  assert.deepEqual(order, {
    status: "PENDING_ACCEPTANCE",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ station: "BAR_TEA", status: "QUEUED" }]
  });
});

test("rejected orders reject further direct transitions without mutation", () => {
  const order = {
    status: "REJECTED",
    stationStatus: {},
    items: [{ station: "BAR_TEA", status: "QUEUED" }]
  };

  const result = applyOrderStatusTransition(order, "READY");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_STATUS_TRANSITION");
  assert.deepEqual(order, {
    status: "REJECTED",
    stationStatus: {},
    items: [{ station: "BAR_TEA", status: "QUEUED" }]
  });
});

test("valid direct order status transitions preserve station side effects", () => {
  const order = {
    status: "PENDING_ACCEPTANCE",
    stationStatus: {},
    items: [
      { station: "COMBO", status: "QUEUED" },
      { station: "BAR_TEA", status: "PENDING" },
      { station: "KITCHEN_HOT", status: "PENDING" }
    ]
  };

  assert.equal(applyOrderStatusTransition(order, "ACCEPTED").ok, true);
  assert.equal(order.status, "ACCEPTED");
  assert.deepEqual(order.stationStatus, { BAR_TEA: "QUEUED", KITCHEN_HOT: "QUEUED" });
  assert.deepEqual(order.items.map((item) => item.status), ["QUEUED", "QUEUED", "QUEUED"]);

  assert.equal(applyOrderStatusTransition(order, "IN_PREPARATION").ok, true);
  assert.equal(order.status, "IN_PREPARATION");
  assert.deepEqual(order.stationStatus, { BAR_TEA: "PREPARING", KITCHEN_HOT: "PREPARING" });
  assert.deepEqual(order.items.map((item) => item.status), ["QUEUED", "PREPARING", "PREPARING"]);
});

test("accepted orders can be rejected with existing rejection side effects", () => {
  const order = {
    status: "ACCEPTED",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ station: "BAR_TEA", status: "QUEUED" }]
  };

  const result = applyOrderStatusTransition(order, "REJECTED");

  assert.equal(result.ok, true);
  assert.equal(order.status, "REJECTED");
  assert.deepEqual(order.stationStatus, {});
  assert.deepEqual(order.items, [{ station: "BAR_TEA", status: "QUEUED" }]);
});

test("table-service dine-in validation requires a table", () => {
  const result = validateOrderServiceContext({
    serviceMode: SERVICE_MODES.TABLE_SERVICE,
    fulfillmentType: FULFILLMENT_TYPES.DINE_IN,
    orderSource: ORDER_SOURCES.STAFF
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["TABLE_REQUIRED"]);
});

test("counter service can exist without a table", () => {
  const result = validateOrderServiceContext({
    serviceMode: SERVICE_MODES.COUNTER_SERVICE,
    fulfillmentType: FULFILLMENT_TYPES.DINE_IN,
    orderSource: ORDER_SOURCES.COUNTER
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.context, {
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "COUNTER",
    zone: "",
    table: ""
  });
});

test("takeaway is not counted as an open physical table", () => {
  const order = normalizeOrderServiceContext({
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    orderSource: "COUNTER",
    table: "TAKEAWAY",
    status: "ACCEPTED"
  });

  assert.equal(order.table, "");
  assert.equal(isOpenPhysicalTableOrder({ ...order, status: "ACCEPTED" }), false);
});

test("QR, staff, and counter sources normalize deterministically", () => {
  assert.equal(normalizeOrderSource("QR"), "CUSTOMER_QR");
  assert.equal(normalizeOrderSource("WAITER"), "STAFF");
  assert.equal(normalizeOrderSource("CASHIER"), "COUNTER");
  assert.equal(normalizeOrderSource("TAKEAWAY"), "COUNTER");
});

test("station-derived readiness does not mark order ready while a required station remains non-ready", () => {
  const order = {
    status: "IN_PREPARATION",
    stationStatus: { BAR_TEA: "READY", KITCHEN_HOT: "PREPARING" },
    items: [
      { station: "BAR_TEA", status: "READY" },
      { station: "KITCHEN_HOT", status: "PREPARING" }
    ]
  };

  assert.equal(deriveOrderStatusFromStations(order), "IN_PREPARATION");
});

test("station updates derive READY only when every required station is ready", () => {
  const order = {
    status: "ACCEPTED",
    stationStatus: { BAR_TEA: "QUEUED", KITCHEN_HOT: "QUEUED" },
    items: [
      { station: "BAR_TEA", status: "QUEUED" },
      { station: "KITCHEN_HOT", status: "QUEUED" }
    ]
  };

  const first = applyStationStatusUpdate(order, ["BAR_TEA"], "READY", { now: "2026-08-11T00:00:00.000Z" });
  assert.equal(first.ok, true);
  assert.equal(order.status, "IN_PREPARATION");
  assert.equal(order.readyAt, undefined);

  const second = applyStationStatusUpdate(order, ["KITCHEN_HOT"], "READY", { now: "2026-08-11T00:01:00.000Z" });
  assert.equal(second.ok, true);
  assert.equal(order.status, "READY");
  assert.equal(order.readyAt, "2026-08-11T00:01:00.000Z");
});

test("combo and meta lines do not block station-derived readiness", () => {
  const order = {
    status: "IN_PREPARATION",
    stationStatus: { BAR_TEA: "READY" },
    items: [
      { station: "COMBO", status: "QUEUED" },
      { station: "KITCHEN_HOT", status: "QUEUED", type: "META" },
      { station: "BAR_TEA", status: "READY", isComponent: true }
    ]
  };

  assert.equal(deriveOrderStatusFromStations(order), "READY");
});

test("legacy orders without service context normalize safely", () => {
  assert.deepEqual(normalizeOrderServiceContext({
    channel: "QR",
    table: "A01",
    zone: "Beach"
  }), {
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "CUSTOMER_QR",
    zone: "Beach",
    table: "A01"
  });

  assert.deepEqual(normalizeOrderServiceContext({
    channel: "TAKEAWAY",
    table: "TAKEAWAY"
  }), {
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    orderSource: "COUNTER",
    zone: "",
    table: ""
  });

  assert.equal(normalizeOrderTimestamps({ time: "09:00" }).createdAt, "");
});
