import test from "node:test";
import assert from "node:assert/strict";

import { renderStaffOrderCard, staffOrderActions } from "../src/features/staff-orders/index.js";

test("staff cannot transition a served order to paid", () => {
  assert.deepEqual(staffOrderActions({ status: "SERVED" }), []);
});

test("staff served-order card never renders paid-and-close controls", () => {
  const html = renderStaffOrderCard({
    id: "served-order",
    orderNo: "D01-0099",
    serviceMode: "TABLE_SERVICE",
    fulfillmentType: "DINE_IN",
    orderSource: "CUSTOMER_QR",
    table: "A01",
    zone: "Beach",
    status: "SERVED",
    total: 120000,
    stationStatus: { KITCHEN_HOT: "READY" },
    items: [{
      lineId: "served-line",
      qty: 1,
      nameEn: "Seafood Fried Rice",
      station: "KITCHEN_HOT",
      prepStatus: "READY",
      status: "SERVED",
      servedQty: 1,
      isComponent: false
    }]
  });

  assert.doesNotMatch(html, /Paid and close/i);
  assert.doesNotMatch(html, /data-status="PAID"/);
});
