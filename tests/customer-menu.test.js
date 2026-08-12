import test from "node:test";
import assert from "node:assert/strict";

import { defaultProducts, filterMenuItems, isProductAvailableInPeriod } from "../src/features/customer-menu/index.js";

test("evening-only products are excluded from morning menu", () => {
  const morning = filterMenuItems(defaultProducts, { period: "morning" });
  const ids = new Set(morning.map((item) => item.id));

  assert.equal(ids.has("bbq-couple"), false);
  assert.equal(ids.has("seafood-hotpot"), false);
  assert.equal(ids.has("xoi-cha"), true);
});

test("evening-only products are available in evening", () => {
  const bbq = defaultProducts.find((item) => item.id === "bbq-couple");
  assert.equal(isProductAvailableInPeriod(bbq, "evening"), true);
  assert.equal(isProductAvailableInPeriod(bbq, "morning"), false);
});

test("kind and category filters still apply together with service period", () => {
  const drinks = filterMenuItems(defaultProducts, {
    period: "afternoon",
    activeKind: "DRINK",
    activeCategory: "drink-signature"
  });

  assert.deepEqual(drinks.map((item) => item.id), ["sunset-soda"]);
});

test("demo catalog includes a configurable drink for DD-005 smoke flows", () => {
  const mangoTea = defaultProducts.find((item) => item.id === "mango-tea");

  assert.equal(mangoTea.variants.length, 2);
  assert.equal(mangoTea.modifierGroups.find((group) => group.id === "sugar").minSelect, 1);
  assert.equal(mangoTea.modifierGroups.find((group) => group.id === "topping").maxSelect, 2);
});
