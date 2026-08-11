import test from "node:test";
import assert from "node:assert/strict";

import { copy } from "../src/shared/i18n/index.js";
import { renderCustomerOrderStatusStrip, selectCustomerSessionOrders } from "../src/features/customer-orders/index.js";

test("customer order history/session strip excludes previous closed-session orders from the same table", () => {
  const orders = [
    { id: "old", orderNo: "D01-0001", table: "A01", tableSessionId: "TS-old", status: "PAID", total: 52000 },
    { id: "current", orderNo: "D01-0002", table: "A01", tableSessionId: "TS-current", status: "PENDING_ACCEPTANCE", total: 104000 }
  ];

  assert.deepEqual(selectCustomerSessionOrders({ orders, tableSessionId: "TS-current" }).map((order) => order.id), ["current"]);

  const html = renderCustomerOrderStatusStrip({ orders, tableSessionId: "TS-current", lang: "vi", copy });
  assert.match(html, /D01-0002/);
  assert.doesNotMatch(html, /D01-0001/);
});

test("customer history does not fall back to table-code-only filtering without an active session", () => {
  const orders = [
    { id: "old", orderNo: "D01-0001", table: "A01", tableSessionId: "TS-old", status: "PAID", total: 52000 }
  ];

  assert.deepEqual(selectCustomerSessionOrders({ orders, tableSessionId: "" }), []);
  assert.doesNotMatch(renderCustomerOrderStatusStrip({ orders, tableSessionId: "", lang: "vi", copy }), /D01-0001/);
});
