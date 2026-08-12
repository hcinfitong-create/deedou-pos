import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeConfiguredSelection,
  configuredCartLineKey,
  createOrderLineOptionSnapshot,
  defaultConfiguredSelection,
  optionSummaryLines,
  validateConfiguredSelection,
  validateProductOptionConfig
} from "../src/features/product-options/index.js";

function tea(overrides = {}) {
  return {
    id: "mango-tea",
    vi: "Trà xoài",
    en: "Mango Tea",
    price: 55000,
    variants: [
      { id: "regular", vi: "Ly vừa", en: "Regular", priceDelta: 0, available: true },
      { id: "large", vi: "Ly lớn", en: "Large", priceDelta: 10000, available: true },
      { id: "bottle", vi: "Chai", en: "Bottle", priceDelta: 20000, available: false }
    ],
    modifierGroups: [
      {
        id: "sugar",
        vi: "Đường",
        en: "Sugar",
        required: true,
        multiple: false,
        minSelect: 1,
        maxSelect: 1,
        options: [
          { id: "sugar-100", vi: "100% đường", en: "100% sugar", priceDelta: 0, available: true },
          { id: "sugar-50", vi: "50% đường", en: "50% sugar", priceDelta: 0, available: true }
        ]
      },
      {
        id: "topping",
        vi: "Topping",
        en: "Topping",
        required: false,
        multiple: true,
        minSelect: 0,
        maxSelect: 2,
        options: [
          { id: "aloe", vi: "Nha đam", en: "Aloe", priceDelta: 6000, available: true },
          { id: "jelly", vi: "Thạch dừa", en: "Coconut jelly", priceDelta: 8000, available: true },
          { id: "popping", vi: "Hạt xoài", en: "Mango popping", priceDelta: 10000, available: false }
        ]
      }
    ],
    ...overrides
  };
}

test("configured selection keys are canonical for equivalent modifier order", () => {
  const product = tea();
  const left = {
    variantId: "large",
    modifierSelections: { topping: ["jelly", "aloe"], sugar: ["sugar-50"] }
  };
  const right = {
    variantId: "large",
    modifierSelections: { sugar: ["sugar-50"], topping: ["aloe", "jelly"] }
  };

  assert.deepEqual(canonicalizeConfiguredSelection(product, left), canonicalizeConfiguredSelection(product, right));
  assert.equal(configuredCartLineKey(product, left), configuredCartLineKey(product, right));
});

test("configured selection validates required variants, min max, duplicates, and unavailable options", () => {
  const product = tea();

  assert.equal(validateConfiguredSelection(product, {
    modifierSelections: { sugar: ["sugar-50"] }
  }).errors.includes("VARIANT_REQUIRED"), true);

  assert.equal(validateConfiguredSelection(product, {
    variantId: "large",
    modifierSelections: { topping: ["aloe"] }
  }).errors.includes("MODIFIER_GROUP_MIN:sugar"), true);

  assert.equal(validateConfiguredSelection(product, {
    variantId: "large",
    modifierSelections: { sugar: ["sugar-50"], topping: ["aloe", "jelly", "popping"] }
  }).errors.includes("MODIFIER_GROUP_MAX:topping"), true);

  assert.equal(validateConfiguredSelection(product, {
    variantId: "large",
    modifierSelections: { sugar: ["sugar-50"], topping: ["aloe", "aloe"] }
  }).errors.includes("DUPLICATE_MODIFIER_SELECTION:topping"), true);

  assert.equal(validateConfiguredSelection(product, {
    variantId: "bottle",
    modifierSelections: { sugar: ["sugar-50"] }
  }).errors.includes("VARIANT_UNAVAILABLE:bottle"), true);

  assert.equal(validateConfiguredSelection(product, {
    variantId: "large",
    modifierSelections: { sugar: ["sugar-50"], topping: ["popping"] }
  }).errors.includes("MODIFIER_OPTION_UNAVAILABLE:topping:popping"), true);
});

test("invalid product option config rejects duplicate IDs and impossible bounds", () => {
  const result = validateProductOptionConfig(tea({
    variants: [
      { id: "large", vi: "Ly lớn", en: "Large" },
      { id: "large", vi: "Ly đại", en: "Large duplicate" }
    ],
    modifierGroups: [
      {
        id: "bad",
        vi: "Lỗi",
        en: "Bad",
        multiple: false,
        minSelect: 2,
        maxSelect: 1,
        options: [
          { id: "same", vi: "Một", en: "One" },
          { id: "same", vi: "Hai", en: "Two" }
        ]
      }
    ]
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errors.includes("DUPLICATE_VARIANT_ID:large"), true);
  assert.equal(result.errors.includes("MODIFIER_GROUP_INVALID_BOUNDS:bad"), true);
  assert.equal(result.errors.includes("DUPLICATE_MODIFIER_OPTION_ID:bad:same"), true);
});

test("required modifier groups keep effective min at least one when minSelect is zero", () => {
  const product = tea({
    modifierGroups: [{
      id: "sugar",
      vi: "Đường",
      en: "Sugar",
      required: true,
      multiple: false,
      minSelect: 0,
      maxSelect: 1,
      options: [
        { id: "sugar-100", vi: "100% đường", en: "100% sugar" },
        { id: "sugar-0", vi: "Không đường", en: "No sugar" }
      ]
    }]
  });
  const config = validateProductOptionConfig(product);
  const empty = validateConfiguredSelection(product, { variantId: "regular", modifierSelections: {} });

  assert.equal(config.ok, true);
  assert.equal(config.config.modifierGroups[0].minSelect, 1);
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.includes("MODIFIER_GROUP_MIN:sugar"), true);
});

test("product option config rejects malformed minSelect and maxSelect bounds", () => {
  const malformedMin = validateProductOptionConfig(tea({
    modifierGroups: [{
      id: "bad-min",
      vi: "Sai min",
      en: "Bad min",
      minSelect: "abc",
      maxSelect: 1,
      options: [{ id: "one", vi: "Một", en: "One" }]
    }]
  }));
  const malformedMax = validateProductOptionConfig(tea({
    modifierGroups: [{
      id: "bad-max",
      vi: "Sai max",
      en: "Bad max",
      minSelect: 0,
      maxSelect: "abc",
      options: [{ id: "one", vi: "Một", en: "One" }]
    }]
  }));

  assert.equal(malformedMin.ok, false);
  assert.equal(malformedMin.errors.includes("MODIFIER_GROUP_INVALID_MIN_SELECT:bad-min"), true);
  assert.equal(malformedMax.ok, false);
  assert.equal(malformedMax.errors.includes("MODIFIER_GROUP_INVALID_MAX_SELECT:bad-max"), true);
});

test("normal valid optional and required modifier groups still work", () => {
  const product = tea();
  const config = validateProductOptionConfig(product);
  const selection = validateConfiguredSelection(product, {
    variantId: "large",
    modifierSelections: {
      sugar: ["sugar-50"],
      topping: ["aloe", "jelly"]
    }
  });

  assert.equal(config.ok, true);
  assert.equal(selection.ok, true);
  assert.equal(selection.unitPrice, 79000);
});

test("product option config requires stable IDs and bilingual labels", () => {
  const result = validateProductOptionConfig({
    variants: [{ id: "", vi: "Ly", en: "" }],
    modifierGroups: [{
      id: "",
      vi: "Đường",
      en: "",
      options: [{ id: "", vi: "", en: "No sugar" }]
    }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.includes("VARIANT_ID_REQUIRED"), true);
  assert.equal(result.errors.includes("VARIANT_LABEL_REQUIRED:UNKNOWN"), true);
  assert.equal(result.errors.includes("MODIFIER_GROUP_ID_REQUIRED"), true);
  assert.equal(result.errors.includes("MODIFIER_GROUP_LABEL_REQUIRED:UNKNOWN"), true);
  assert.equal(result.errors.includes("MODIFIER_OPTION_ID_REQUIRED:UNKNOWN"), true);
  assert.equal(result.errors.includes("MODIFIER_OPTION_LABEL_REQUIRED:UNKNOWN:UNKNOWN"), true);
});

test("configured price is derived from catalog and rejects negative final unit", () => {
  const product = tea();
  const result = validateConfiguredSelection(product, {
    variantId: "large",
    modifierSelections: { sugar: ["sugar-50"], topping: ["jelly", "aloe"] }
  });

  assert.equal(result.ok, true);
  assert.equal(result.unitPrice, 79000);

  const negative = validateConfiguredSelection({
    id: "discounted",
    price: 1000,
    modifierGroups: [{
      id: "discount",
      vi: "Giảm",
      en: "Discount",
      required: true,
      minSelect: 1,
      maxSelect: 1,
      options: [{ id: "too-low", vi: "Âm", en: "Negative", priceDelta: -2000 }]
    }]
  }, { modifierSelections: { discount: ["too-low"] } });

  assert.equal(negative.ok, false);
  assert.equal(negative.errors.includes("NEGATIVE_UNIT_PRICE"), true);
});

test("order option snapshot is immutable from later catalog changes", () => {
  const product = tea();
  const configured = {
    variantId: "large",
    modifierSelections: { sugar: ["sugar-50"], topping: ["jelly"] }
  };
  const snapshot = createOrderLineOptionSnapshot(product, configured);

  assert.equal(snapshot.ok, true);
  product.price = 99000;
  product.variants[1].vi = "Ly đổi tên";
  product.modifierGroups[1].options[1].priceDelta = 99000;

  assert.equal(snapshot.basePrice, 55000);
  assert.equal(snapshot.unitPrice, 73000);
  assert.equal(snapshot.optionSnapshot.variant.vi, "Ly lớn");
  assert.equal(snapshot.optionSnapshot.modifierGroups[1].options[0].priceDelta, 8000);
  assert.deepEqual(optionSummaryLines(snapshot.optionSnapshot, "en"), [
    "Variant: Large",
    "Sugar: 50% sugar",
    "Topping: Coconut jelly"
  ]);
});

test("default configured selection chooses available required options for legacy cart lines", () => {
  assert.deepEqual(defaultConfiguredSelection(tea()), {
    variantId: "regular",
    modifierSelections: { sugar: ["sugar-100"] }
  });
});
