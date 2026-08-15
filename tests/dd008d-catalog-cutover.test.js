import test from "node:test";
import assert from "node:assert/strict";

import { removeLegacyCatalogAuthorityFallback } from "../src/shared/backend/catalog-cutover.js";

test("DD-008D server catalog fallback cannot resurrect explicit empty periods/components", () => {
  const products = [{
    id: "combo-1",
    periods: ["evening"],
    components: [{ key: "legacy-component" }],
    vi: "Legacy"
  }];

  const result = removeLegacyCatalogAuthorityFallback(products);
  assert.equal(result, products);
  assert.deepEqual(products[0].periods, []);
  assert.deepEqual(products[0].components, []);
  assert.equal(products[0].vi, "Legacy");
});
