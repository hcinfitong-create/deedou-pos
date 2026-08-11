import test from "node:test";
import assert from "node:assert/strict";

import { addCartItem, cartSubtotal, canSubmitCart, decrementCartItem, removeCartItem } from "../src/features/cart/index.js";

const products = new Map([
  ["coffee", { id: "coffee", price: 59000, available: true }],
  ["sold", { id: "sold", price: 45000, available: false }],
  ["tea", {
    id: "tea",
    price: 55000,
    available: true,
    variants: [
      { id: "regular", vi: "Ly vừa", en: "Regular", priceDelta: 0, available: true },
      { id: "large", vi: "Ly lớn", en: "Large", priceDelta: 10000, available: true }
    ],
    modifierGroups: [{
      id: "topping",
      vi: "Topping",
      en: "Topping",
      multiple: true,
      minSelect: 0,
      maxSelect: 2,
      options: [
        { id: "aloe", vi: "Nha đam", en: "Aloe", priceDelta: 6000, available: true },
        { id: "jelly", vi: "Thạch dừa", en: "Jelly", priceDelta: 8000, available: true }
      ]
    }]
  }]
]);
const productById = (id) => products.get(id) ?? null;

test("cart adds available product and caps quantity", () => {
  let cart = [];
  cart = addCartItem(cart, "coffee", productById, 2);
  cart = addCartItem(cart, "coffee", productById, 2);
  cart = addCartItem(cart, "coffee", productById, 2);
  assert.deepEqual(cart, [{ id: "coffee", qty: 2 }]);
});

test("cart refuses sold-out or missing products", () => {
  assert.deepEqual(addCartItem([], "sold", productById), []);
  assert.deepEqual(addCartItem([], "missing", productById), []);
});

test("subtotal ignores stale missing product references", () => {
  const cart = [{ id: "coffee", qty: 2 }, { id: "deleted-product", qty: 99 }];
  assert.equal(cartSubtotal(cart, productById), 118000);
  assert.equal(canSubmitCart(cart, productById), false);
});

test("decrement and remove keep cart consistent", () => {
  assert.deepEqual(decrementCartItem([{ id: "coffee", qty: 2 }], "coffee"), [{ id: "coffee", qty: 1 }]);
  assert.deepEqual(removeCartItem([{ id: "coffee", qty: 1 }], "coffee"), []);
});

test("cart merges identical configured items and separates different configurations", () => {
  let cart = [];
  const regularAloe = { variantId: "regular", modifierSelections: { topping: ["aloe"] } };
  const regularAloeReordered = { modifierSelections: { topping: ["aloe"] }, variantId: "regular" };
  const largeAloe = { variantId: "large", modifierSelections: { topping: ["aloe"] } };

  cart = addCartItem(cart, "tea", productById, 10, regularAloe);
  cart = addCartItem(cart, "tea", productById, 10, regularAloeReordered);
  cart = addCartItem(cart, "tea", productById, 10, largeAloe);

  assert.equal(cart.length, 2);
  assert.deepEqual(cart.map((line) => line.qty), [2, 1]);
  assert.equal(cart[0].key, "tea|v:regular|m:topping=aloe");
  assert.equal(cart[1].key, "tea|v:large|m:topping=aloe");
  assert.equal(cartSubtotal(cart, productById), 193000);
});

test("configured cart increment decrement and remove use configured line identity", () => {
  let cart = addCartItem([], "tea", productById, 10, {
    variantId: "large",
    modifierSelections: { topping: ["jelly"] }
  });

  cart = addCartItem(cart, "tea|v:large|m:topping=jelly", productById, 10);
  assert.equal(cart[0].qty, 2);

  cart = decrementCartItem(cart, "tea|v:large|m:topping=jelly", productById);
  assert.equal(cart[0].qty, 1);

  cart = removeCartItem(cart, "tea|v:large|m:topping=jelly", productById);
  assert.deepEqual(cart, []);
});

test("legacy cart lines remain readable with default configured selection", () => {
  const cart = [{ id: "tea", qty: 1 }];

  assert.equal(cartSubtotal(cart, productById), 55000);
  assert.equal(canSubmitCart(cart, productById), true);
});

test("configured cart rejects stale unavailable selections before submission", () => {
  const cart = [{
    id: "tea",
    key: "tea|v:large|m:topping=jelly",
    selection: { variantId: "large", modifierSelections: { topping: ["jelly"] } },
    qty: 1
  }];
  products.get("tea").modifierGroups[0].options[1].available = false;

  assert.equal(canSubmitCart(cart, productById), false);
  assert.equal(cartSubtotal(cart, productById), 0);

  products.get("tea").modifierGroups[0].options[1].available = true;
});
