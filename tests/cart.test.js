import test from "node:test";
import assert from "node:assert/strict";

import { addCartItem, cartSubtotal, canSubmitCart, decrementCartItem, removeCartItem } from "../src/features/cart/index.js";

const products = new Map([
  ["coffee", { id: "coffee", price: 59000, available: true }],
  ["sold", { id: "sold", price: 45000, available: false }]
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
