import test from "node:test";
import assert from "node:assert/strict";

import {
  assignServiceFamilyCourse,
  fireCourse,
  fireServiceFamily,
  getServiceFamilies,
  holdServiceFamily,
  HOLD_STATES,
  isLineKdsReleased,
  normalizeCourse,
  normalizeHoldState,
  normalizeLineCourseScheduling
} from "../src/features/course-workflow/index.js";
import {
  applyPrepStatusTransition,
  billableTotal,
  expandOrderLines,
  getServiceProgress,
  stationStatusFor
} from "../src/features/ordering/index.js";

function orderWithLines(lines, overrides = {}) {
  return {
    id: "order-1",
    orderNo: "D01-0001",
    status: "ACCEPTED",
    stationStatus: stationStatusFor(lines),
    items: lines,
    ...overrides
  };
}

function queuedLine(overrides = {}) {
  return {
    id: overrides.id || "fried-rice",
    lineId: overrides.lineId || "line-1",
    qty: overrides.qty || 1,
    station: overrides.station || "KITCHEN_HOT",
    nameVi: overrides.nameVi || "Cơm chiên",
    nameEn: overrides.nameEn || "Fried Rice",
    prepStatus: "QUEUED",
    status: "QUEUED",
    servedQty: 0,
    isBillable: true,
    isComponent: false,
    billQty: overrides.qty || 1,
    price: 99000,
    ...overrides
  };
}

test("legacy scheduling defaults to immediate FIRED", () => {
  assert.equal(normalizeCourse(undefined), "");
  assert.equal(normalizeHoldState(undefined), HOLD_STATES.FIRED);
  assert.deepEqual(normalizeLineCourseScheduling({}), {
    course: "",
    holdState: "FIRED",
    heldAt: "",
    firedAt: "",
    parentLineId: ""
  });
  assert.equal(isLineKdsReleased({}), true);
});

test("malformed course assignment is rejected without mutation", () => {
  const line = queuedLine();
  const before = structuredClone(line);
  const order = orderWithLines([line]);

  const result = assignServiceFamilyCourse(order, "line-1", "abc");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_COURSE");
  assert.deepEqual(line, before);
});

test("hold and fire preserve queued prep semantics and reset queue age", () => {
  const line = queuedLine({ lineId: "steak", course: "2", queuedAt: "2026-08-11T05:00:00.000Z" });
  const order = orderWithLines([line]);

  const hold = holdServiceFamily(order, "steak", { now: "2026-08-11T05:05:00.000Z" });

  assert.equal(hold.ok, true);
  assert.equal(line.holdState, "HELD");
  assert.equal(line.heldAt, "2026-08-11T05:05:00.000Z");
  assert.equal(line.firedAt, "");
  assert.equal(line.queuedAt, "");
  assert.equal(line.prepStatus, "QUEUED");
  assert.equal(line.price, 99000);
  assert.equal(line.billQty, 1);

  const fire = fireServiceFamily(order, "steak", { now: "2026-08-11T05:10:00.000Z" });

  assert.equal(fire.ok, true);
  assert.equal(line.holdState, "FIRED");
  assert.equal(line.firedAt, "2026-08-11T05:10:00.000Z");
  assert.equal(line.queuedAt, "2026-08-11T05:10:00.000Z");
  assert.equal(line.prepStatus, "QUEUED");
  assert.equal(line.status, "QUEUED");
});

test("duplicate fire is a no-op for already fired queued family", () => {
  const line = queuedLine({
    lineId: "mint-juice",
    qty: 2,
    course: "1",
    holdState: "FIRED",
    firedAt: "2026-08-11T05:00:00.000Z",
    queuedAt: "2026-08-11T05:00:00.000Z",
    billQty: 2,
    price: 59000,
    optionSnapshot: { variant: "Large", modifiers: ["Less sugar"] }
  });
  const order = orderWithLines([line]);
  const before = structuredClone(order);

  const result = fireServiceFamily(order, "mint-juice", { now: "2026-08-11T05:20:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.noOp, true);
  assert.equal(result.reason, "ALREADY_FIRED");
  assert.equal(line.queuedAt, "2026-08-11T05:00:00.000Z");
  assert.equal(line.firedAt, "2026-08-11T05:00:00.000Z");
  assert.equal(line.prepStatus, "QUEUED");
  assert.deepEqual(order, before);
});

test("duplicate fire is a no-op after station work has started", () => {
  ["ACKNOWLEDGED", "PREPARING", "READY"].forEach((prepStatus) => {
    const line = queuedLine({
      lineId: `line-${prepStatus.toLowerCase()}`,
      course: "1",
      holdState: "FIRED",
      firedAt: "2026-08-11T05:00:00.000Z",
      queuedAt: "2026-08-11T05:00:00.000Z",
      prepStatus,
      status: prepStatus,
      acknowledgedAt: "2026-08-11T05:03:00.000Z",
      prepStartedAt: prepStatus === "ACKNOWLEDGED" ? "" : "2026-08-11T05:06:00.000Z",
      readyAt: prepStatus === "READY" ? "2026-08-11T05:10:00.000Z" : ""
    });
    const order = orderWithLines([line], { id: `order-${prepStatus}` });
    const before = structuredClone(order);

    const result = fireServiceFamily(order, line.lineId, { now: "2026-08-11T05:20:00.000Z" });

    assert.equal(result.ok, true);
    assert.equal(result.noOp, true);
    assert.equal(result.reason, "ALREADY_FIRED");
    assert.deepEqual(order, before);
  });
});

test("hold and course reassignment are blocked after prep starts", () => {
  const line = queuedLine({ lineId: "soup" });
  const order = orderWithLines([line]);

  assert.equal(applyPrepStatusTransition(order, { stationCode: "KITCHEN_HOT" }, "ACKNOWLEDGED").ok, true);
  assert.equal(holdServiceFamily(order, "soup").ok, false);
  assert.equal(assignServiceFamilyCourse(order, "soup", "2").ok, false);
  assert.equal(line.holdState || "FIRED", "FIRED");
  assert.equal(line.course || "", "");
});

test("whole-course fire is isolated and does not mutate already fired or other courses", () => {
  const course1Held = queuedLine({ lineId: "c1-held", course: "1", holdState: "HELD" });
  const course1Fired = queuedLine({
    lineId: "c1-fired",
    course: "1",
    holdState: "FIRED",
    firedAt: "2026-08-11T05:00:00.000Z",
    queuedAt: "2026-08-11T05:00:00.000Z"
  });
  const course2Held = queuedLine({ lineId: "c2-held", course: "2", holdState: "HELD" });
  const order = orderWithLines([course1Held, course1Fired, course2Held]);
  const firedBefore = structuredClone(course1Fired);

  const result = fireCourse(order, "1", { now: "2026-08-11T05:12:00.000Z" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.firedFamilies, ["c1-held"]);
  assert.equal(course1Held.holdState, "FIRED");
  assert.equal(course1Held.queuedAt, "2026-08-11T05:12:00.000Z");
  assert.equal(course1Fired.holdState, "FIRED");
  assert.equal(course1Fired.queuedAt, "2026-08-11T05:00:00.000Z");
  assert.equal(course1Fired.firedAt, "2026-08-11T05:00:00.000Z");
  assert.deepEqual(course1Fired, firedBefore);
  assert.equal(course2Held.holdState, "HELD");
  assert.equal(course2Held.queuedAt || "", "");
});

test("combo components inherit parent course scheduling without billing or snapshot mutation", () => {
  const combo = {
    id: "combo-bbq",
    vi: "Set BBQ đôi",
    en: "BBQ Couple Set",
    price: 329000,
    station: "KITCHEN_BBQ",
    variants: [{ id: "premium", vi: "Cao cấp", en: "Premium", priceDelta: 40000 }],
    modifierGroups: [{
      id: "sauce",
      vi: "Sốt",
      en: "Sauce",
      required: true,
      minSelect: 1,
      maxSelect: 1,
      options: [{ id: "spicy", vi: "Cay", en: "Spicy", priceDelta: 0 }]
    }],
    components: [
      { vi: "Ba chỉ bò", en: "Beef belly", qty: 2, station: "KITCHEN_BBQ" },
      { vi: "Trà xoài", en: "Mango tea", qty: 1, station: "BAR_TEA" }
    ]
  };
  const lines = expandOrderLines([{
    id: "combo-bbq",
    qty: 1,
    course: "2",
    holdState: "HELD",
    selection: { variantId: "premium", modifierSelections: { sauce: ["spicy"] } }
  }], (id) => id === combo.id ? combo : null);
  const [parent, kitchenLine, barLine] = lines;
  const order = orderWithLines(lines);

  assert.equal(parent.course, "2");
  assert.equal(parent.holdState, "HELD");
  assert.equal(kitchenLine.parentLineId, parent.lineId);
  assert.equal(barLine.parentLineId, parent.lineId);
  assert.equal(kitchenLine.course, "2");
  assert.equal(barLine.holdState, "HELD");
  assert.equal(billableTotal(lines), 369000);
  assert.equal(getServiceProgress(order).serviceableQty, 3);
  assert.equal(parent.configuredKey, "combo-bbq|v:premium|m:sauce=spicy");
  assert.equal(kitchenLine.optionSnapshot, undefined);

  assert.equal(holdServiceFamily(order, kitchenLine.lineId).ok, false);
  const fire = fireServiceFamily(order, parent.lineId, { now: "2026-08-11T06:00:00.000Z" });

  assert.equal(fire.ok, true);
  assert.equal(parent.holdState, "FIRED");
  assert.equal(kitchenLine.holdState, "FIRED");
  assert.equal(barLine.holdState, "FIRED");
  assert.equal(kitchenLine.queuedAt, "2026-08-11T06:00:00.000Z");
  assert.equal(parent.price, 369000);
  assert.equal(parent.billQty, 1);
  assert.equal(kitchenLine.isBillable, false);
  assert.equal(kitchenLine.billQty, 0);
  assert.equal(getServiceFamilies(order).length, 1);
});
