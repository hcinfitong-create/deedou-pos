import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPrepStatusTransition,
  canTransitionPrepStatus,
  deriveStationTicketState,
  getStationTicketActions,
  getStationTicketAge,
  renderStationPage,
  selectStationTickets
} from "../src/features/station-workflow/index.js";

const stations = [
  { code: "BAR_COFFEE", group: "BAR", en: "Coffee Bar" },
  { code: "BAR_TEA", group: "BAR", en: "Tea Bar" },
  { code: "KITCHEN_HOT", group: "KITCHEN", en: "Hot Kitchen" }
];

test("station workflow exports prep transition guards without served action", () => {
  assert.equal(canTransitionPrepStatus("QUEUED", "ACKNOWLEDGED"), true);
  assert.equal(canTransitionPrepStatus("QUEUED", "READY"), false);
  assert.equal(canTransitionPrepStatus("PREPARING", "SERVED"), false);
});

test("station tickets exclude pending QR orders until staff accepts them", () => {
  const pendingOrder = {
    id: "pending-qr",
    orderNo: "D01-0009",
    status: "PENDING_ACCEPTANCE",
    table: "A01",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    items: [
      { lineId: "coffee", station: "BAR_COFFEE", qty: 1, nameVi: "Cà phê", nameEn: "Coffee", prepStatus: "QUEUED", status: "QUEUED" }
    ]
  };

  assert.deepEqual(selectStationTickets([pendingOrder], "BAR", stations), []);

  const acceptedOrder = { ...pendingOrder, status: "ACCEPTED" };
  assert.deepEqual(selectStationTickets([acceptedOrder], "BAR", stations).map((ticket) => ticket.orderId), ["pending-qr"]);
});

test("station tickets keep BAR_COFFEE and BAR_TEA independently accountable", () => {
  const orders = [{
    id: "order-1",
    orderNo: "D01-0001",
    status: "IN_PREPARATION",
    table: "A01",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    items: [
      { lineId: "coffee", station: "BAR_COFFEE", qty: 1, nameVi: "Cà phê", nameEn: "Coffee", prepStatus: "QUEUED", status: "QUEUED" },
      { lineId: "tea", station: "BAR_TEA", qty: 1, nameVi: "Trà", nameEn: "Tea", prepStatus: "ACKNOWLEDGED", status: "ACKNOWLEDGED" }
    ]
  }];

  const tickets = selectStationTickets(orders, "BAR", stations, { now: "2026-08-11T05:00:00.000Z" });

  assert.deepEqual(tickets.map((ticket) => ticket.stationCode), ["BAR_COFFEE", "BAR_TEA"]);
  assert.deepEqual(tickets.map((ticket) => ticket.status), ["QUEUED", "ACKNOWLEDGED"]);
  assert.deepEqual(tickets[0].actions.map((action) => action.status), ["ACKNOWLEDGED"]);
  assert.deepEqual(tickets[1].actions.map((action) => action.status), ["PREPARING"]);
});

test("station ticket state and actions stop at ready", () => {
  assert.equal(deriveStationTicketState([{ prepStatus: "PREPARING" }, { prepStatus: "READY" }]), "PREPARING");
  assert.deepEqual(getStationTicketActions({ lines: [{ prepStatus: "PREPARING" }] }), [{ status: "READY", label: "Ready" }]);
  assert.deepEqual(getStationTicketActions({ lines: [{ prepStatus: "READY" }] }), []);
});

test("station prep API cannot set served and does not regress served quantity", () => {
  const order = {
    status: "IN_PREPARATION",
    stationStatus: { BAR_TEA: "PREPARING" },
    items: [{ lineId: "tea", station: "BAR_TEA", qty: 2, nameVi: "Trà", nameEn: "Tea", prepStatus: "PREPARING", status: "PREPARING", servedQty: 1 }]
  };

  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "SERVED").ok, false);
  assert.equal(order.items[0].servedQty, 1);

  const ready = applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "READY", { now: "2026-08-11T05:10:00.000Z" });
  assert.equal(ready.ok, true);
  assert.equal(order.items[0].servedQty, 1);
  assert.equal(order.items[0].readyAt, "2026-08-11T05:10:00.000Z");
});

test("station ticket age is deterministic and render targets station code", () => {
  const order = {
    id: "order-1",
    orderNo: "D01-0001",
    status: "ACCEPTED",
    table: "",
    serviceMode: "COUNTER_SERVICE",
    fulfillmentType: "TAKEAWAY",
    items: [{ lineId: "coffee", station: "BAR_COFFEE", qty: 1, nameVi: "Cà phê", nameEn: "Coffee", prepStatus: "QUEUED", status: "QUEUED", queuedAt: "2026-08-11T05:00:00.000Z" }]
  };
  const tickets = selectStationTickets([order], "BAR", stations, { now: "2026-08-11T05:07:00.000Z" });

  assert.equal(getStationTicketAge(tickets[0], "2026-08-11T05:07:00.000Z"), 7);
  const html = renderStationPage({ orders: [order], stationGroup: "BAR", stations, now: "2026-08-11T05:07:00.000Z" });
  assert.match(html, /data-station-code="BAR_COFFEE"/);
  assert.doesNotMatch(html, /data-station-group=/);
  assert.doesNotMatch(html, /SERVED/);
});
