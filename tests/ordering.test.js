import test from "node:test";
import assert from "node:assert/strict";

import {
  billableTotal,
  clampBillQty,
  expandOrderLines,
  normalizeOrderStatus,
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
