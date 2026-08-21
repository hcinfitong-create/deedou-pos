import test from "node:test";
import assert from "node:assert/strict";

import {
  PRODUCT_CATEGORIES,
  normalizeAdminProduct,
  validateProductDraft
} from "../src/features/admin-catalog/index.js";
import { BACKEND_MODES, createAdminBackendApi } from "../src/shared/backend/index.js";

const config = {
  mode: BACKEND_MODES.SUPABASE,
  supabaseUrl: "https://deedou-test.supabase.co",
  supabasePublishableKey: "sb_publishable_test_key"
};

function harness() {
  const calls = [];
  const client = {
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === "dd012_create_product" || name === "dd012_update_product") {
        return {
          data: [{
            ok: true,
            category: "OK",
            entity_type: "product",
            entity_id: params.p_product_id,
            payload: {
              product: {
                id: params.p_product_id,
                kind: params.p_kind,
                category: params.p_category,
                nameVi: params.p_name_vi,
                nameEn: params.p_name_en,
                priceVnd: params.p_price_vnd,
                stationCode: params.p_station_code,
                periods: params.p_periods,
                updatedAt: "2026-08-21T16:20:00Z"
              }
            }
          }],
          error: null
        };
      }
      throw new Error(`unexpected rpc ${name}`);
    }
  };
  const api = createAdminBackendApi({
    config,
    authApi: { getClient: async () => client },
    deviceStorage: { getItem: (key) => key === "deedou_device_credential" ? "dd012-device" : null },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  return { api, calls };
}

test("DD-012 Admin draft normalization preserves the current catalog taxonomy", () => {
  const product = normalizeAdminProduct({
    id: " Coconut-Coffee ",
    kind: "drink",
    category: " DRINK-COFFEE ",
    name_vi: " Cà phê dừa ",
    name_en: " Coconut Coffee ",
    price_vnd: 59000,
    station_code: " bar_coffee ",
    periods: ["evening", "morning", "morning", "unsupported"]
  });
  assert.equal(product.id, "coconut-coffee");
  assert.equal(product.kind, "DRINK");
  assert.equal(product.category, "drink-coffee");
  assert.equal(product.stationCode, "BAR_COFFEE");
  assert.deepEqual(product.periods, ["morning", "evening"]);
  assert.deepEqual(PRODUCT_CATEGORIES.DRINK, ["drink-coffee", "drink-tea", "drink-signature"]);
});

test("DD-012 Admin draft validation blocks mismatched category and invalid price", () => {
  const base = {
    id: "coconut-coffee",
    kind: "DRINK",
    category: "drink-coffee",
    nameVi: "Cà phê dừa",
    nameEn: "Coconut Coffee",
    priceVnd: 59000,
    stationCode: "BAR_COFFEE",
    periods: ["morning"]
  };
  assert.equal(validateProductDraft(base).ok, true);
  assert.equal(validateProductDraft({ ...base, category: "food-single" }).reason, "INVALID_PRODUCT_CATEGORY");
  assert.equal(validateProductDraft({ ...base, priceVnd: -1 }).reason, "INVALID_PRODUCT_PRICE");
  assert.equal(validateProductDraft({ ...base, priceVnd: 12.5 }).reason, "INVALID_PRODUCT_PRICE");
});

test("DD-012 create adapter sends typed product core through authoritative context", async () => {
  const { api, calls } = harness();
  const result = await api.createProduct({
    id: " coconut-coffee ",
    kind: "drink",
    category: "DRINK-COFFEE",
    nameVi: "Cà phê dừa",
    nameEn: "Coconut Coffee",
    descVi: "Mô tả",
    descEn: "Description",
    priceVnd: 59000,
    stationCode: "bar_coffee",
    periods: ["morning", "afternoon"],
    imageUrl: "/images/coconut.png",
    color: "#ffffff",
    art: "cup",
    available: true,
    idempotencyKey: "dd012-create-1"
  });
  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.name, "dd012_create_product");
  assert.equal(call.params.p_location_id, "deedou-demo");
  assert.equal(call.params.p_workstation_mode, "ADMIN");
  assert.equal(call.params.p_device_credential, "dd012-device");
  assert.equal(call.params.p_product_id, "coconut-coffee");
  assert.equal(call.params.p_kind, "DRINK");
  assert.equal(call.params.p_category, "drink-coffee");
  assert.equal(call.params.p_price_vnd, 59000);
  assert.equal(call.params.p_station_code, "BAR_COFFEE");
  assert.deepEqual(call.params.p_periods, ["morning", "afternoon"]);
  assert.equal(call.params.p_idempotency_key, "dd012-create-1");
});

test("DD-012 update adapter carries optimistic updatedAt and does not mutate availability", async () => {
  const { api, calls } = harness();
  const result = await api.updateProduct({
    id: "coconut-coffee",
    kind: "DRINK",
    category: "drink-signature",
    nameVi: "Cà phê dừa mới",
    nameEn: "New Coconut Coffee",
    priceVnd: 65000,
    stationCode: "BAR",
    periods: ["afternoon", "evening"],
    expectedUpdatedAt: "2026-08-21T16:00:00Z",
    idempotencyKey: "dd012-update-1"
  });
  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.name, "dd012_update_product");
  assert.equal(call.params.p_expected_updated_at, "2026-08-21T16:00:00Z");
  assert.equal(call.params.p_idempotency_key, "dd012-update-1");
  assert.equal(Object.hasOwn(call.params, "p_available"), false);
});
