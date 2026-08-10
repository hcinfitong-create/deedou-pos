import test from "node:test";
import assert from "node:assert/strict";

import { STAFF_ORDER_COLUMNS } from "../src/features/staff-orders/index.js";

test("staff order columns preserve the current operational board order", () => {
  assert.deepEqual(STAFF_ORDER_COLUMNS, ["PENDING_ACCEPTANCE", "ACCEPTED", "IN_PREPARATION", "READY", "SERVED"]);
});
