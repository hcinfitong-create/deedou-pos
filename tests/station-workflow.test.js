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
import {
  billableTotal,
  expandOrderLines,
  getServiceProgress,
  stationStatusFor
} from "../src/features/ordering/index.js";
import {
  fireServiceFamily
} from "../src/features/course-workflow/index.js";

const stations = [
  { code: "BAR_COFFEE", group: "BAR", en: "Coffee Bar" },
  { code: "BAR_TEA", group: "BAR", en: "Tea Bar" },
  { code: "KITCHEN_HOT", group: "KITCHEN", en: "Hot Kitchen" },
  { code: "KITCHEN_BBQ", group: "KITCHEN", en: "BBQ Kitchen" }
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

test("partially refunded legacy orders never enter KDS", () => {
  const refundedOrder = {
    id: "partial-refund",
    orderNo: "D01-0010",
    status: "PARTIALLY_REFUNDED",
    table: "A01",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    items: [
      { lineId: "coffee", station: "BAR_COFFEE", qty: 1, nameVi: "Ca phe", nameEn: "Coffee", prepStatus: "QUEUED", status: "QUEUED" }
    ]
  };

  assert.deepEqual(selectStationTickets([refundedOrder], "BAR", stations), []);
});

test("held lines are excluded from KDS until fired and age starts at fire time", () => {
  const order = {
    id: "held-order",
    orderNo: "D01-0020",
    status: "ACCEPTED",
    table: "A01",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    items: [
      { lineId: "course-2", station: "KITCHEN_HOT", qty: 1, nameVi: "Mì xào", nameEn: "Noodles", course: "2", holdState: "HELD", prepStatus: "QUEUED", status: "QUEUED", servedQty: 0 }
    ]
  };

  assert.deepEqual(selectStationTickets([order], "KITCHEN", stations, { now: "2026-08-11T05:00:00.000Z" }), []);
  assert.equal(fireServiceFamily(order, "course-2", { now: "2026-08-11T05:03:00.000Z" }).ok, true);

  const tickets = selectStationTickets([order], "KITCHEN", stations, { now: "2026-08-11T05:08:00.000Z" });

  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].course, "2");
  assert.equal(tickets[0].courseLabel, "Course 2");
  assert.deepEqual(tickets[0].lineIds, ["course-2"]);
  assert.equal(getStationTicketAge(tickets[0], "2026-08-11T05:08:00.000Z"), 5);
  assert.equal(order.items[0].prepStatus, "QUEUED");
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

test("same station tickets are isolated by course line IDs", () => {
  const order = {
    id: "course-order",
    orderNo: "D01-0021",
    status: "ACCEPTED",
    table: "A01",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    items: [
      { lineId: "course-1-hot", station: "KITCHEN_HOT", qty: 1, nameVi: "Bò lúc lắc", nameEn: "Beef", course: "1", holdState: "FIRED", prepStatus: "QUEUED", status: "QUEUED" },
      { lineId: "course-2-hot", station: "KITCHEN_HOT", qty: 1, nameVi: "Cơm chiên", nameEn: "Fried rice", course: "2", holdState: "FIRED", prepStatus: "QUEUED", status: "QUEUED" }
    ]
  };
  const tickets = selectStationTickets([order], "KITCHEN", stations, { now: "2026-08-11T05:00:00.000Z" });

  assert.equal(tickets.length, 2);
  assert.deepEqual(tickets.map((ticket) => ticket.course), ["1", "2"]);
  assert.deepEqual(tickets.map((ticket) => ticket.lineIds), [["course-1-hot"], ["course-2-hot"]]);
  assert.equal(applyPrepStatusTransition(order, {
    stationCode: "KITCHEN_HOT",
    lineIds: tickets[0].lineIds
  }, "ACKNOWLEDGED").ok, true);

  assert.equal(order.items[0].prepStatus, "ACKNOWLEDGED");
  assert.equal(order.items[1].prepStatus, "QUEUED");
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
    items: [{
      lineId: "coffee",
      station: "BAR_COFFEE",
      qty: 1,
      nameVi: "Cà phê",
      nameEn: "Coffee",
      prepStatus: "QUEUED",
      status: "QUEUED",
      queuedAt: "2026-08-11T05:00:00.000Z",
      optionSnapshot: {
        variant: { id: "large", vi: "<Ly lớn>", en: "Large", priceDelta: 10000 },
        modifierGroups: [{
          id: "milk",
          vi: "Sữa",
          en: "Milk",
          options: [{ id: "oat", vi: "<Sữa yến mạch>", en: "Oat milk", priceDelta: 8000 }]
        }]
      }
    }]
  };
  const tickets = selectStationTickets([order], "BAR", stations, { now: "2026-08-11T05:07:00.000Z" });

  assert.equal(getStationTicketAge(tickets[0], "2026-08-11T05:07:00.000Z"), 7);
  const html = renderStationPage({ orders: [order], stationGroup: "BAR", stations, now: "2026-08-11T05:07:00.000Z" });
  assert.match(html, /data-station-code="BAR_COFFEE"/);
  assert.match(html, /data-station-line-ids="coffee"/);
  assert.match(html, /Immediate/);
  assert.match(html, /Phiên bản: &lt;Ly lớn&gt;/);
  assert.match(html, /Sữa: &lt;Sữa yến mạch&gt;/);
  assert.doesNotMatch(html, /data-station-group=/);
  assert.doesNotMatch(html, /SERVED/);
});

test("configured combo summary is visible on station tickets without changing billing or service", () => {
  const combo = {
    id: "combo-bbq",
    vi: "Set BBQ đôi",
    en: "BBQ Couple Set",
    price: 329000,
    station: "KITCHEN_BBQ",
    variants: [
      { id: "standard", vi: "Tiêu chuẩn", en: "Standard", priceDelta: 0 },
      { id: "premium", vi: "Cao cấp", en: "Premium", priceDelta: 40000 }
    ],
    modifierGroups: [{
      id: "sauce",
      vi: "Sốt",
      en: "Sauce",
      required: true,
      multiple: false,
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: "spicy", vi: "Cay", en: "Spicy", priceDelta: 0 },
        { id: "mild", vi: "Dịu", en: "Mild", priceDelta: 0 }
      ]
    }],
    components: [
      { vi: "Ba chỉ bò", en: "Beef belly", qty: 2, station: "KITCHEN_BBQ" },
      { vi: "Trà xoài", en: "Mango tea", qty: 1, station: "BAR_TEA" }
    ]
  };
  const lines = expandOrderLines([{
    id: "combo-bbq",
    qty: 1,
    selection: { variantId: "premium", modifierSelections: { sauce: ["spicy"] } }
  }], (id) => id === combo.id ? combo : null);
  const [parent, kitchenLine, barLine] = lines;

  assert.equal(lines.length, 3);
  assert.equal(lines.filter((line) => line.isBillable).length, 1);
  assert.equal(parent.price, 369000);
  assert.equal(parent.billQty, 1);
  [kitchenLine, barLine].forEach((line) => {
    assert.equal(line.isBillable, false);
    assert.equal(line.billQty, 0);
    assert.equal(line.price, 0);
    assert.equal(line.optionSnapshot, undefined);
  });
  assert.equal(billableTotal(lines), 369000);
  assert.equal(getServiceProgress({ items: lines }).serviceableQty, 3);
  assert.equal(getServiceProgress({ items: lines }).servedQty, 0);

  const order = {
    id: "order-combo",
    orderNo: "D01-0100",
    status: "ACCEPTED",
    table: "A01",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    items: lines,
    stationStatus: stationStatusFor(lines, "QUEUED")
  };
  const kitchenHtml = renderStationPage({ orders: [order], stationGroup: "KITCHEN", stations, now: "2026-08-11T05:07:00.000Z" });
  const barHtml = renderStationPage({ orders: [order], stationGroup: "BAR", stations, now: "2026-08-11T05:07:00.000Z" });

  assert.match(kitchenHtml, /Set BBQ đôi — Cao cấp/);
  assert.match(kitchenHtml, /Sốt: Cay/);
  assert.match(barHtml, /Set BBQ đôi — Cao cấp/);
  assert.match(barHtml, /Sốt: Cay/);

  assert.equal(kitchenLine.prepStatus, "QUEUED");
  assert.equal(applyPrepStatusTransition(order, { stationCode: "KITCHEN_BBQ" }, "ACKNOWLEDGED").ok, true);
  assert.equal(kitchenLine.prepStatus, "ACKNOWLEDGED");
  assert.equal(applyPrepStatusTransition(order, { stationCode: "KITCHEN_BBQ" }, "PREPARING").ok, true);
  assert.equal(kitchenLine.prepStatus, "PREPARING");
  assert.equal(applyPrepStatusTransition(order, { stationCode: "KITCHEN_BBQ" }, "READY").ok, true);
  assert.equal(kitchenLine.prepStatus, "READY");
  assert.equal(order.status, "IN_PREPARATION");

  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "ACKNOWLEDGED").ok, true);
  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "PREPARING").ok, true);
  assert.equal(applyPrepStatusTransition(order, { stationCode: "BAR_TEA" }, "READY").ok, true);
  assert.equal(barLine.prepStatus, "READY");
  assert.equal(order.status, "READY");
  assert.equal(getServiceProgress(order).serviceableQty, 3);
});
