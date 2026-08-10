import test from "node:test";
import assert from "node:assert/strict";

import {
  ordersByStaffColumn,
  renderStaffOrderCard,
  STAFF_ORDER_COLUMNS,
  staffOrderActions,
  staffOrderMetrics
} from "../src/features/staff-orders/index.js";

test("staff order columns preserve the current operational board order", () => {
  assert.deepEqual(STAFF_ORDER_COLUMNS, ["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"]);
});

test("staff metrics preserve current board calculations", () => {
  const orders = [
    { status: "PENDING_ACCEPTANCE", table: "A01", total: 52000 },
    { status: "ACCEPTED", table: "A01", total: 120000 },
    { status: "PAID", table: "B01", total: 90000 },
    { status: "REJECTED", table: "C01", total: 10000 }
  ];
  const events = [{ done: false }, { done: true }];

  assert.deepEqual(staffOrderMetrics({ orders, events }), {
    newOrders: 1,
    openTables: 1,
    serviceRequests: 1,
    todayTotal: 262000
  });
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
    { status: "IN_PREPARATION", label: "Send to prep", tone: "primary" },
    { status: "REJECTED", label: "Reject", tone: "danger" }
  ]);
  assert.deepEqual(staffOrderActions({ status: "IN_PREPARATION" }), [
    { status: "READY", label: "Ready", tone: "primary" }
  ]);
  assert.deepEqual(staffOrderActions({ status: "READY" }), [
    { status: "SERVED", label: "Served", tone: "primary" }
  ]);
  assert.deepEqual(staffOrderActions({ status: "PAID" }), []);
});

test("staff order card renders escaped item content and valid action buttons", () => {
  const html = renderStaffOrderCard({
    id: "order-1",
    orderNo: "D01-0001",
    table: "A01",
    time: "09:00",
    status: "PENDING_ACCEPTANCE",
    total: 52000,
    note: "<script>",
    stationStatus: { BAR_TEA: "QUEUED" },
    items: [{ qty: 1, nameEn: "<Tea>", station: "BAR_TEA", status: "QUEUED", isComponent: false }]
  });

  assert.match(html, /D01-0001 - Table A01/);
  assert.match(html, /&lt;Tea&gt;/);
  assert.match(html, /Note: &lt;script&gt;/);
  assert.match(html, /data-status="ACCEPTED"/);
  assert.match(html, /data-status="REJECTED"/);
  assert.doesNotMatch(html, /data-status="SERVED"/);
});
