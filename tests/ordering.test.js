import test from "node:test";
import assert from "node:assert/strict";

import {
  applyOrderStatusTransition,
  applyPrepStatusTransition,
  applyStationStatusUpdate,
  billableTotal,
  buildCounterOrderServiceContext,
  canServeLine,
  canTransitionPrepStatus,
  canTransitionOrderStatus,
  clampBillQty,
  deriveOrderStatusFromStations,
  deriveOrderOperationalStatus,
  expandOrderLines,
  FULFILLMENT_TYPES,
  getAllowedOrderStatusTransitions,
  getServiceProgress,
  isOpenPhysicalTableOrder,
  isLineFullyServed,
  normalizeOrderLineOperationalFields,
  normalizeOrderServiceContext,
  normalizeOrderSource,
  normalizeOrderStatus,
  normalizeOrderTimestamps,
  normalizePrepStatus,
  normalizeServiceProgress,
  ORDER_SOURCES,
  serveAllReady,
  serveLineQuantity,
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

test("expandOrderLines snapshots configured unit price from current catalog", () => {
  const product = {
    id: "mango-tea",
    vi: "Trà xoài",
    en: "Mango Tea",
    price: 55000,
    station: "BAR_TEA",
    variants: [
      { id: "regular", vi: "Ly vừa", en: "Regular", priceDelta: 0, available: true },
      { id: "large", vi: "Ly lớn", en: "Large", priceDelta: 10000, available: true }
    ],
    modifierGroups: [{
      id: "topping",
      vi: "Topping",
      en: "Topping",
      multiple: true,
      minSelect: 0,
      maxSelect: 2,
      options: [
        { id: "aloe", vi: "Nha đam", en: "Aloe", priceDelta: 6000, available: true },
        { id: "jelly", vi: "Thạch dừa", en: "Jelly", priceDelta: 8000, available: true }
      ]
    }]
  };
  const lines = expandOrderLines([{
    id: "mango-tea",
    qty: 2,
    selection: { variantId: "large", modifierSelections: { topping: ["jelly"] } }
  }], (id) => id === "mango-tea" ? product : null);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].basePrice, 55000);
  assert.equal(lines[0].price, 73000);
  assert.equal(lines[0].billQty, 2);
  assert.equal(lines[0].configuredKey, "mango-tea|v:large|m:topping=jelly");
  assert.deepEqual(lines[0].configuredOptions, { variantId: "large", modifierSelections: { topping: ["jelly"] } });
  assert.equal(lines[0].optionSnapshot.variant.en, "Large");
  assert.equal(lines[0].optionSnapshot.modifierGroups[0].options[0].priceDelta, 8000);
  assert.equal(billableTotal(lines), 146000);

  product.price = 99000;
  product.modifierGroups[0].options[1].priceDelta = 99000;
  lines[0].billQty = 1;

  assert.equal(lines[0].price, 73000);
  assert.equal(lines[0].optionSnapshot.modifierGroups[0].options[0].priceDelta, 8000);
  assert.equal(billableTotal(lines), 73000);
});

test("configured combo keeps one billable parent and component service quantities unchanged", () => {
  const products = new Map([
    ["combo", {
      id: "combo",
      vi: "Combo",
      en: "Combo",
      price: 300000,
      station: "KITCHEN_BBQ",
      variants: [{ id: "premium", vi: "Cao cấp", en: "Premium", priceDelta: 50000, available: true }],
      modifierGroups: [{
        id: "sauce",
        vi: "Sốt",
        en: "Sauce",
        required: true,
        minSelect: 1,
        maxSelect: 1,
        options: [{ id: "spicy", vi: "Cay", en: "Spicy", priceDelta: 0, available: true }]
      }],
      components: [
        { vi: "Tôm", en: "Shrimp", qty: 2, station: "KITCHEN_BBQ" },
        { vi: "Trà", en: "Tea", qty: 1, station: "BAR_TEA" }
      ]
    }]
  ]);

  const lines = expandOrderLines([{
    id: "combo",
    qty: 2,
    selection: { variantId: "premium", modifierSelections: { sauce: ["spicy"] } }
  }], (id) => products.get(id) ?? null);

  assert.equal(lines.length, 3);
  assert.equal(lines[0].isBillable, true);
  assert.equal(lines[0].price, 350000);
  assert.equal(lines[1].isBillable, false);
  assert.equal(lines[1].qty, 4);
  assert.equal(lines[2].qty, 2);
  assert.equal(getServiceProgress({ items: lines }).serviceableQty, 6);
  assert.equal(billableTotal(lines), 700000);
  assert.equal(lines[1].optionSnapshot, undefined);
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
    { station: "KITCHEN_HOT" },
    { station: "BAR_COFFEE", holdState: "HELD" }
  ], "PENDING_ACCEPTANCE");

  assert.deepEqual(statuses, {
    BAR_TEA: "QUEUED",
    KITCHEN_HOT: "QUEUED"
  });
});

test("course scheduling defaults legacy lines to fired immediate service", () => {
  const line = normalizeOrderLineOperationalFields({
    lineId: "coffee",
    station: "BAR_COFFEE",
    qty: 1,
    status: "QUEUED"
  });

  assert.equal(line.course, "");
  assert.equal(line.holdState, "FIRED");
  assert.equal(line.heldAt, "");
  assert.equal(line.firedAt, "");
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

test("valid direct order status transitions keep KDS prep mutations authoritative", () => {
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
  assert.deepEqual(order.stationStatus, { BAR_TEA: "QUEUED", KITCHEN_HOT: "QUEUED" });
  assert.deepEqual(order.items.map((item) => item.status), ["QUEUED", "QUEUED", "QUEUED"]);
  assert.deepEqual(order.items.map((item) => item.prepStatus), [undefined, "QUEUED", "QUEUED"]);
  assert.equal(order.prepStartedAt, undefined);
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

test("counter order service context matches runtime table selection rules", () => {
  const walkIn = buildCounterOrderServiceContext({ tableCode: "", physicalTable: null });
  assert.deepEqual(walkIn, {
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "COUNTER",
    zone: "",
    table: ""
  });
  assert.equal(validateOrderServiceContext(walkIn).ok, true);

  const tableOrder = buildCounterOrderServiceContext({
    tableCode: "A01",
    physicalTable: { code: "A01", zone: "Beach" }
  });
  assert.deepEqual(tableOrder, {
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "COUNTER",
    zone: "Beach",
    table: "A01"
  });
  assert.equal(validateOrderServiceContext(tableOrder).ok, true);

  const takeaway = buildCounterOrderServiceContext({ tableCode: "TAKEAWAY", physicalTable: null });
  assert.deepEqual(takeaway, {
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    orderSource: "COUNTER",
    zone: "",
    table: ""
  });
  assert.equal(validateOrderServiceContext(takeaway).ok, true);
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
      { lineId: "tea", station: "BAR_TEA", status: "QUEUED", prepStatus: "QUEUED", qty: 1 },
      { lineId: "hot", station: "KITCHEN_HOT", status: "QUEUED", prepStatus: "QUEUED", qty: 1 }
    ]
  };

  assert.equal(applyStationStatusUpdate(order, ["BAR_TEA"], "ACKNOWLEDGED", { now: "2026-08-11T00:00:00.000Z" }).ok, true);
  assert.equal(applyStationStatusUpdate(order, ["BAR_TEA"], "PREPARING", { now: "2026-08-11T00:00:30.000Z" }).ok, true);
  const first = applyStationStatusUpdate(order, ["BAR_TEA"], "READY", { now: "2026-08-11T00:01:00.000Z" });
  assert.equal(first.ok, true);
  assert.equal(order.status, "IN_PREPARATION");
  assert.equal(order.readyAt, undefined);

  assert.equal(applyStationStatusUpdate(order, ["KITCHEN_HOT"], "ACKNOWLEDGED", { now: "2026-08-11T00:01:30.000Z" }).ok, true);
  assert.equal(applyStationStatusUpdate(order, ["KITCHEN_HOT"], "PREPARING", { now: "2026-08-11T00:02:00.000Z" }).ok, true);
  const second = applyStationStatusUpdate(order, ["KITCHEN_HOT"], "READY", { now: "2026-08-11T00:03:00.000Z" });
  assert.equal(second.ok, true);
  assert.equal(order.status, "READY");
  assert.equal(order.readyAt, "2026-08-11T00:03:00.000Z");
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

test("prep status transitions are sequential and cannot set served", () => {
  assert.equal(canTransitionPrepStatus("QUEUED", "ACKNOWLEDGED"), true);
  assert.equal(canTransitionPrepStatus("ACKNOWLEDGED", "PREPARING"), true);
  assert.equal(canTransitionPrepStatus("PREPARING", "READY"), true);
  assert.equal(canTransitionPrepStatus("QUEUED", "READY"), false);
  assert.equal(canTransitionPrepStatus("QUEUED", "PREPARING"), false);
  assert.equal(canTransitionPrepStatus("READY", "SERVED"), false);
});

test("first KDS acknowledge moves accepted order to preparation without skipping prep states", () => {
  const order = {
    status: "ACCEPTED",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ lineId: "tea-1", id: "tea", station: "BAR_TEA", qty: 1, status: "QUEUED", prepStatus: "QUEUED", servedQty: 0 }]
  };

  const update = applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "ACKNOWLEDGED", { now: "2026-08-11T00:10:00.000Z" });

  assert.equal(update.ok, true);
  assert.equal(order.status, "IN_PREPARATION");
  assert.deepEqual(order.stationStatus, { BAR_TEA: "ACKNOWLEDGED" });
  assert.equal(order.items[0].prepStatus, "ACKNOWLEDGED");
  assert.equal(order.items[0].status, "ACKNOWLEDGED");
});

test("accepted held lines stay out of active prep queues until fired", () => {
  const order = {
    status: "PENDING_ACCEPTANCE",
    stationStatus: {},
    items: [{
      lineId: "tea-1",
      id: "tea",
      station: "BAR_TEA",
      qty: 1,
      status: "QUEUED",
      prepStatus: "QUEUED",
      holdState: "HELD",
      servedQty: 0
    }]
  };

  assert.equal(applyOrderStatusTransition(order, "ACCEPTED", { now: "2026-08-11T00:05:00.000Z" }).ok, true);
  assert.deepEqual(order.stationStatus, {});
  assert.equal(order.items[0].prepStatus, "QUEUED");
  assert.equal(order.items[0].queuedAt, undefined);

  const before = structuredClone(order);
  const update = applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "ACKNOWLEDGED", { now: "2026-08-11T00:10:00.000Z" });

  assert.equal(update.ok, false);
  assert.equal(update.reason, "NO_LINES");
  assert.deepEqual(order, before);
});

test("invalid prep skip does not mutate the order", () => {
  const order = {
    status: "ACCEPTED",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ lineId: "tea-1", id: "tea", station: "BAR_TEA", qty: 1, status: "QUEUED", prepStatus: "QUEUED", servedQty: 0 }]
  };
  const before = structuredClone(order);

  const result = applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "READY");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_PREP_STATUS_TRANSITION");
  assert.deepEqual(order, before);
});

test("station prep update never mutates served quantity", () => {
  const order = {
    status: "IN_PREPARATION",
    stationStatus: { BAR_TEA: "ACKNOWLEDGED" },
    items: [{ lineId: "tea-1", station: "BAR_TEA", qty: 2, status: "ACKNOWLEDGED", prepStatus: "ACKNOWLEDGED", servedQty: 1 }]
  };

  const result = applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "PREPARING", { now: "2026-08-11T01:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(order.items[0].servedQty, 1);
  assert.equal(order.items[0].prepStartedAt, "2026-08-11T01:00:00.000Z");
});

test("unready line cannot be served and ready line supports partial service", () => {
  const order = {
    status: "IN_PREPARATION",
    items: [
      { lineId: "coffee", station: "BAR_COFFEE", qty: 2, prepStatus: "READY", status: "READY", servedQty: 0, billQty: 2, isBillable: true },
      { lineId: "squid", station: "KITCHEN_HOT", qty: 1, prepStatus: "PREPARING", status: "PREPARING", servedQty: 0, billQty: 1, isBillable: true }
    ]
  };

  assert.equal(canServeLine(order.items[1]), false);
  assert.equal(serveLineQuantity(order, "squid", 1).ok, false);

  const served = serveLineQuantity(order, "coffee", 1, { now: "2026-08-11T02:00:00.000Z" });
  assert.equal(served.ok, true);
  assert.equal(order.items[0].servedQty, 1);
  assert.equal(order.items[0].billQty, 2);
  assert.equal(order.items[0].status, "READY");
  assert.equal(order.status, "IN_PREPARATION");
});

test("served quantity clamps to line quantity and targets exactly one line", () => {
  const order = {
    status: "READY",
    items: [
      { lineId: "same-product-a", id: "tea", station: "BAR_TEA", qty: 2, prepStatus: "READY", status: "READY", servedQty: 1, billQty: 2, isBillable: true },
      { lineId: "same-product-b", id: "tea", station: "BAR_TEA", qty: 2, prepStatus: "READY", status: "READY", servedQty: 0, billQty: 2, isBillable: true }
    ]
  };

  assert.equal(serveLineQuantity(order, "same-product-a", -1).ok, false);
  const result = serveLineQuantity(order, "same-product-a", 5, { now: "2026-08-11T02:05:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(order.items[0].servedQty, 2);
  assert.equal(order.items[0].status, "SERVED");
  assert.equal(order.items[1].servedQty, 0);
  assert.equal(order.items[0].billQty, 2);
});

test("aggregate status separates served progress from prep readiness", () => {
  const mixedPreparing = {
    status: "READY",
    items: [
      { lineId: "served", station: "BAR_TEA", qty: 1, prepStatus: "READY", status: "SERVED", servedQty: 1 },
      { lineId: "prep", station: "KITCHEN_HOT", qty: 1, prepStatus: "PREPARING", status: "PREPARING", servedQty: 0 },
      { lineId: "ready", station: "DESSERT", qty: 1, prepStatus: "READY", status: "READY", servedQty: 0 }
    ]
  };
  assert.equal(deriveOrderOperationalStatus(mixedPreparing), "IN_PREPARATION");

  const allRemainingReady = structuredClone(mixedPreparing);
  allRemainingReady.items[1].prepStatus = "READY";
  allRemainingReady.items[1].status = "READY";
  assert.equal(deriveOrderOperationalStatus(allRemainingReady), "READY");

  allRemainingReady.items[1].servedQty = 1;
  allRemainingReady.items[1].status = "SERVED";
  allRemainingReady.items[2].servedQty = 1;
  allRemainingReady.items[2].status = "SERVED";
  assert.equal(deriveOrderOperationalStatus(allRemainingReady), "SERVED");
});

test("legacy line statuses normalize without destructive migration", () => {
  const ready = normalizeOrderLineOperationalFields({ lineId: "ready", station: "BAR_TEA", qty: 2, status: "READY" });
  assert.equal(ready.prepStatus, "READY");
  assert.equal(ready.servedQty, 0);

  const served = normalizeOrderLineOperationalFields({ lineId: "served", station: "BAR_TEA", qty: 2, status: "SERVED" });
  assert.equal(served.prepStatus, "READY");
  assert.equal(served.servedQty, 2);
  assert.equal(normalizePrepStatus("SERVED"), "READY");
});

test("combo/meta lines do not affect service progress", () => {
  const order = {
    status: "READY",
    items: [
      { lineId: "combo", station: "COMBO", qty: 1, prepStatus: "QUEUED", status: "QUEUED", isBillable: true },
      { lineId: "meta", station: "KITCHEN_HOT", qty: 1, prepStatus: "QUEUED", status: "QUEUED", type: "META" },
      { lineId: "component", station: "BAR_TEA", qty: 1, prepStatus: "READY", status: "READY", servedQty: 0, isComponent: true }
    ]
  };

  assert.deepEqual(getServiceProgress(order), { serviceableQty: 1, servedQty: 0, remainingQty: 1 });
  assert.equal(isLineFullyServed(order.items[0]), true);
  assert.equal(deriveOrderOperationalStatus(order), "READY");
});

test("counter serveAllReady fast path works without a table", () => {
  const order = {
    status: "READY",
    serviceMode: SERVICE_MODES.COUNTER_SERVICE,
    fulfillmentType: FULFILLMENT_TYPES.TAKEAWAY,
    orderSource: ORDER_SOURCES.COUNTER,
    table: "",
    items: [
      { lineId: "coffee", station: "BAR_COFFEE", qty: 1, prepStatus: "READY", status: "READY", servedQty: 0 },
      { lineId: "cake", station: "DESSERT", qty: 1, prepStatus: "READY", status: "READY", servedQty: 0 }
    ]
  };

  const result = serveAllReady(order, { now: "2026-08-11T03:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(order.status, "SERVED");
  assert.equal(order.servedAt, "2026-08-11T03:00:00.000Z");
  assert.deepEqual(order.items.map((line) => line.servedQty), [1, 1]);
});

test("direct READY to SERVED no longer blanket-serves table-service orders", () => {
  const order = {
    status: "READY",
    serviceMode: SERVICE_MODES.TABLE_SERVICE,
    fulfillmentType: FULFILLMENT_TYPES.DINE_IN,
    orderSource: ORDER_SOURCES.CUSTOMER_QR,
    table: "A01",
    stationStatus: { BAR_TEA: "READY" },
    items: [{ lineId: "tea", station: "BAR_TEA", qty: 1, prepStatus: "READY", status: "READY", servedQty: 0 }]
  };
  const before = structuredClone(order);

  const result = applyOrderStatusTransition(order, "SERVED");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "LINE_SERVING_REQUIRED");
  assert.deepEqual(order, before);
});

test("line timestamps are deterministic with injected now", () => {
  const order = {
    status: "ACCEPTED",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ lineId: "tea", station: "BAR_TEA", qty: 1, prepStatus: "QUEUED", status: "QUEUED", servedQty: 0 }]
  };

  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "ACKNOWLEDGED", { now: "2026-08-11T04:00:00.000Z" }).ok, true);
  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "PREPARING", { now: "2026-08-11T04:01:00.000Z" }).ok, true);
  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "READY", { now: "2026-08-11T04:03:00.000Z" }).ok, true);
  assert.equal(serveLineQuantity(order, "tea", 1, { now: "2026-08-11T04:04:00.000Z" }).ok, true);

  assert.equal(order.items[0].queuedAt, "2026-08-11T04:00:00.000Z");
  assert.equal(order.items[0].acknowledgedAt, "2026-08-11T04:00:00.000Z");
  assert.equal(order.items[0].prepStartedAt, "2026-08-11T04:01:00.000Z");
  assert.equal(order.items[0].readyAt, "2026-08-11T04:03:00.000Z");
  assert.equal(order.items[0].servedAt, "2026-08-11T04:04:00.000Z");
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
