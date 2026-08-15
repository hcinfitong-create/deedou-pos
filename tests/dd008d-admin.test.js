import test from "node:test";
import assert from "node:assert/strict";

import { BACKEND_MODES, createAdminBackendApi } from "../src/shared/backend/index.js";

const config = {
  mode: BACKEND_MODES.SUPABASE,
  supabaseUrl: "https://deedou-test.supabase.co",
  supabasePublishableKey: "sb_publishable_test_key"
};

function harness() {
  const calls = [];
  const api = createAdminBackendApi({
    config,
    authApi: {
      async getClient() {
        return {
          async rpc(name, params) {
            calls.push({ name, params });
            if (name === "dd008d_get_admin_menu_snapshot") {
              return { data: [{ ok: true, category: "OK", payload: { products: [{ id: "fried-rice", available: true }] } }], error: null };
            }
            if (name === "dd008d_set_product_availability") {
              return { data: [{ ok: true, category: "OK", entity_type: "product", entity_id: params.p_product_id, payload: { product: { id: params.p_product_id, available: params.p_available } } }], error: null };
            }
            throw new Error(`unexpected rpc ${name}`);
          }
        };
      }
    },
    deviceStorage: {
      getItem(key) {
        return key === "deedou_device_credential" ? "admin-device" : null;
      }
    },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  return { api, calls };
}

test("DD-008D admin adapter carries authoritative device/location context", async () => {
  const { api, calls } = harness();
  const result = await api.fetchMenu();
  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "dd008d_get_admin_menu_snapshot");
  assert.equal(calls[0].params.p_location_id, "deedou-demo");
  assert.equal(calls[0].params.p_workstation_mode, "ADMIN");
  assert.equal(calls[0].params.p_device_credential, "admin-device");
});

test("DD-008D availability adapter sends optimistic token and idempotency key", async () => {
  const { api, calls } = harness();
  const result = await api.setProductAvailability({
    productId: "fried-rice",
    available: false,
    expectedUpdatedAt: "2026-08-16T00:00:00.000Z",
    idempotencyKey: "availability-1"
  });
  assert.equal(result.ok, true);
  const call = calls[0];
  assert.equal(call.name, "dd008d_set_product_availability");
  assert.equal(call.params.p_product_id, "fried-rice");
  assert.equal(call.params.p_available, false);
  assert.equal(call.params.p_expected_updated_at, "2026-08-16T00:00:00.000Z");
  assert.equal(call.params.p_idempotency_key, "availability-1");
});

test("DD-008D admin adapter fails closed without device credential", async () => {
  let rpcCalled = false;
  const api = createAdminBackendApi({
    config,
    authApi: { getClient: async () => ({ rpc: async () => { rpcCalled = true; return { data: [], error: null }; } }) },
    deviceStorage: { getItem: () => null },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  const result = await api.fetchMenu();
  assert.equal(result.ok, false);
  assert.equal(result.category, "FORBIDDEN");
  assert.equal(result.reason, "ADMIN_CONTEXT_INCOMPLETE");
  assert.equal(rpcCalled, false);
});
