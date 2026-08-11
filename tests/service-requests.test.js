import test from "node:test";
import assert from "node:assert/strict";

import { createServiceRequestEvent, renderCustomerServiceActions } from "../src/features/service-requests/index.js";

test("service request carries session ID when active session exists", () => {
  const expectedTime = new Date("2026-08-11T08:00:00.000Z").toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const event = createServiceRequestEvent({
    table: { code: "A01", zone: "Beach" },
    tableSessionId: "TS-A01",
    type: "CALL_STAFF",
    now: "2026-08-11T08:00:00.000Z",
    generateId: () => "E-1"
  });

  assert.deepEqual(event, {
    id: "E-1",
    type: "CALL_STAFF",
    table: "A01",
    zone: "Beach",
    tableSessionId: "TS-A01",
    done: false,
    time: expectedTime
  });
});

test("legacy service request without tableSessionId remains readable", () => {
  const event = createServiceRequestEvent({
    table: { code: "A01", zone: "Beach" },
    type: "REQUEST_BILL",
    now: "2026-08-11T08:05:00.000Z",
    generateId: () => "E-2"
  });

  assert.equal(event.table, "A01");
  assert.equal(event.tableSessionId, undefined);
  assert.match(renderCustomerServiceActions({ call: "Call staff", bill: "Bill" }), /data-service="REQUEST_BILL"/);
});
