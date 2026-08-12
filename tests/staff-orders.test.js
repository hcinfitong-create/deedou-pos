import test from "node:test";
import assert from "node:assert/strict";

import {
  formatOrderAge,
  ordersByStaffColumn,
  renderStaffOrderCard,
  selectCounterServiceOpenOrders,
  selectOpenTablesByPhysicalZone,
  selectReadyToServeLines,
  selectReadyToServeOrders,
  selectTableServiceOpenOrders,
  STAFF_ORDER_COLUMNS,
  staffOrderActions,
  staffOrderMetrics
} from "../src/features/staff-orders/index.js";

test("staff order columns preserve the current operational board order", () => {
  assert.deepEqual(STAFF_ORDER_COLUMNS, ["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"]);
});

test("staff metrics preserve current board calculations", () => {
  const orders = [
    { status: "PENDING_ACCEPTANCE", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", orderSource: "CUSTOMER_QR", table: "A01", zone: "Beach", total: 52000 },
    { status: "ACCEPTED", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", orderSource: "COUNTER", table: "A01", zone: "Beach", total: 120000 },
    { status: "ACCEPTED", serviceMode: "COUNTER_SERVICE", fulfillmentType: "TAKEAWAY", orderSource: "COUNTER", table: "", total: 90000 },
    { status: "READY", serviceMode: "COUNTER_SERVICE", fulfillmentType: "DINE_IN", orderSource: "COUNTER", table: "", total: 45000 },
    { status: "PAID", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", orderSource: "STAFF", table: "B01", zone: "Indoor", total: 90000 },
    { status: "REJECTED", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", orderSource: "STAFF", table: "C01", zone: "Camping", total: 10000 }
  ];
  const events = [{ done: false }, { done: true }];

  assert.deepEqual(staffOrderMetrics({ orders, events }), {
    newOrders: 1,
    tableServiceOpenOrders: 2,
    counterServiceOpenOrders: 2,
    readyToServeOrders: 1,
    openTables: 1,
    openTablesByZone: { Beach: ["A01"] },
    serviceRequests: 1,
    todayTotal: 397000
  });
});

test("staff selectors separate table-service and counter/cafe orders", () => {
  const orders = [
    { id: "table", status: "ACCEPTED", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", table: "A01", zone: "Beach" },
    { id: "counter", status: "ACCEPTED", serviceMode: "COUNTER_SERVICE", fulfillmentType: "DINE_IN", table: "" },
    { id: "takeaway", status: "ACCEPTED", serviceMode: "COUNTER_SERVICE", fulfillmentType: "TAKEAWAY", table: "" },
    { id: "paid", status: "PAID", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", table: "B01", zone: "Indoor" }
  ];

  assert.deepEqual(selectTableServiceOpenOrders(orders).map((order) => order.id), ["table"]);
  assert.deepEqual(selectCounterServiceOpenOrders(orders).map((order) => order.id), ["counter", "takeaway"]);
  assert.deepEqual(selectOpenTablesByPhysicalZone(orders), { Beach: ["A01"] });
});

test("staff open-table metrics use active table sessions when provided", () => {
  const orders = [
    { id: "legacy-open", status: "ACCEPTED", serviceMode: "TABLE_SERVICE", fulfillmentType: "DINE_IN", table: "C01", zone: "Camping", total: 90000 }
  ];
  const tableSessions = [
    { id: "TS-A01", tableCode: "A01", zone: "Beach", status: "OPEN", openedAt: "2026-08-11T08:00:00.000Z", openedSource: "STAFF" },
    { id: "TS-B01", tableCode: "B01", zone: "Indoor", status: "CLOSED", openedAt: "2026-08-11T07:00:00.000Z", closedAt: "2026-08-11T07:30:00.000Z", openedSource: "STAFF" }
  ];

  assert.deepEqual(selectOpenTablesByPhysicalZone(orders, tableSessions), { Beach: ["A01"] });
  assert.equal(staffOrderMetrics({ orders, events: [], tableSessions }).openTables, 1);
});

test("staff selector finds ready-to-serve orders", () => {
  const orders = [
    { id: "prep", status: "IN_PREPARATION" },
    { id: "ready", status: "READY" },
    { id: "served", status: "SERVED" }
  ];

  assert.deepEqual(selectReadyToServeOrders(orders).map((order) => order.id), ["ready"]);
});

test("staff selector finds ready lines while order remains in preparation", () => {
  const order = {
    id: "mixed",
    status: "IN_PREPARATION",
    items: [
      { lineId: "coffee", station: "BAR_COFFEE", qty: 2, prepStatus: "READY", status: "READY", servedQty: 1 },
      { lineId: "squid", station: "KITCHEN_HOT", qty: 1, prepStatus: "PREPARING", status: "PREPARING", servedQty: 0 }
    ]
  };

  assert.deepEqual(selectReadyToServeLines(order).map((line) => [line.lineId, line.remainingQty]), [["coffee", 1]]);
  assert.deepEqual(selectReadyToServeOrders([order]).map((item) => item.id), ["mixed"]);
});

test("staff selectors group orders by operational column", () => {
  const orders = [
    { id: "1", status: "PENDING_ACCEPTANCE" },
    { id: "2", status: "READY" },
    { id: "3", status: "PAID" }
  ];

  const columns = ordersByStaffColumn(orders);

  assert.deepEqual(columns.PENDING_ACCEPTANCE.map((order) => order.id), ["1"]);
  assert.deepEqual(columns.READY.map((order) => order.id), ["2"]);
  assert.deepEqual(columns.SERVED, []);
});

test("staff action presentation follows ordering transition rules", () => {
  assert.deepEqual(staffOrderActions({ status: "PENDING_ACCEPTANCE" }), [
    { status: "ACCEPTED", label: "Accept", tone: "primary" },
    { status: "REJECTED", label: "Reject", tone: "danger" }
  ]);
  assert.deepEqual(staffOrderActions({ status: "ACCEPTED" }), [
    { status: "REJECTED", label: "Reject", tone: "danger" }
  ]);
  assert.deepEqual(staffOrderActions({ status: "IN_PREPARATION" }), []);
  assert.deepEqual(staffOrderActions({ status: "READY" }), []);
  assert.deepEqual(staffOrderActions({ status: "PAID" }), []);
});

test("staff order card renders escaped item content and valid action buttons", () => {
  const html = renderStaffOrderCard({
    id: "order-1",
    orderNo: "D01-0001",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "CUSTOMER_QR",
    table: "A01",
    zone: "Beach",
    time: "09:00",
    status: "PENDING_ACCEPTANCE",
    total: 52000,
    note: "<script>",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{
      lineId: "tea-1",
      qty: 1,
      nameEn: "<Tea>",
      station: "BAR_TEA",
      status: "QUEUED",
      prepStatus: "QUEUED",
      servedQty: 0,
      isComponent: false,
      optionSnapshot: {
        variant: { id: "large", vi: "Ly lớn", en: "<Large>", priceDelta: 10000 },
        modifierGroups: [{
          id: "sugar",
          vi: "Đường",
          en: "Sugar",
          options: [{ id: "less", vi: "Ít đường", en: "<Less sugar>", priceDelta: 0 }]
        }]
      }
    }]
  });

  assert.match(html, /D01-0001 - Beach Table A01/);
  assert.match(html, /Table service/);
  assert.match(html, /Dine-in/);
  assert.match(html, /QR/);
  assert.match(html, /&lt;Tea&gt;/);
  assert.match(html, /Variant: &lt;Large&gt;/);
  assert.match(html, /Sugar: &lt;Less sugar&gt;/);
  assert.match(html, /Note: &lt;script&gt;/);
  assert.match(html, /data-status="ACCEPTED"/);
  assert.match(html, /data-status="REJECTED"/);
  assert.doesNotMatch(html, /data-status="SERVED"/);
});

test("staff order card renders item-level serving controls", () => {
  const html = renderStaffOrderCard({
    id: "order-2",
    orderNo: "D01-0002",
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    orderSource: "COUNTER",
    table: "",
    status: "READY",
    total: 104000,
    stationStatus: { BAR_COFFEE: "READY" },
    items: [{ lineId: "coffee-1", qty: 2, nameEn: "Coffee", station: "BAR_COFFEE", prepStatus: "READY", status: "READY", servedQty: 1, isComponent: false }]
  });

  assert.match(html, /Service/);
  assert.match(html, /1\/2/);
  assert.match(html, /data-serve-line="coffee-1"/);
  assert.match(html, /data-serve-all="order-2"/);
  assert.doesNotMatch(html, /data-status="SERVED"/);
});

test("staff order age formats only when machine-readable timestamp exists", () => {
  assert.equal(formatOrderAge({ createdAt: "2026-08-11T00:00:00.000Z" }, "2026-08-11T00:07:00.000Z"), "7m waiting");
  assert.equal(formatOrderAge({ time: "09:00" }, "2026-08-11T00:07:00.000Z"), "");
});
