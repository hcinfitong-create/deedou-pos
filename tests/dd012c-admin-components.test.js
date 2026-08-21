import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAdminComponent,
  validateComponentDraft
} from "../src/features/admin-catalog/components.js";
import { BACKEND_MODES, createAdminComponentsBackendApi } from "../src/shared/backend/index.js";

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
      return {
        data: [{
          ok: true,
          category: "OK",
          entity_type: "product_component",
          entity_id: params.p_component_id || "component",
          payload: {}
        }],
        error: null
      };
    }
  };
  const api = createAdminComponentsBackendApi({
    config,
    authApi: { getClient: async () => client },
    deviceStorage: { getItem: (key) => key === "deedou_device_credential" ? "dd012c-device" : null },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  return { api, calls };
}

test("DD-012C component normalization preserves routing fields", () => {
  const component = normalizeAdminComponent({
    id: " Combo-Main ",
    parent_product_id: " Breakfast-Combo ",
    component_key: " MAIN_PLATE ",
    name_vi: " Phần chính ",
    name_en: " Main plate ",
    qty: "2",
    station_code: " kitchen_hot ",
    display_order: "3",
    updated_at: "2026-08-21T20:30:00Z"
  });
  assert.deepEqual(component, {
    id: "combo-main",
    parentProductId: "breakfast-combo",
    componentKey: "main_plate",
    nameVi: "Phần chính",
    nameEn: "Main plate",
    qty: 2,
    stationCode: "KITCHEN_HOT",
    displayOrder: 3,
    updatedAt: "2026-08-21T20:30:00Z"
  });
  assert.equal(validateComponentDraft(component, { requireUpdatedAt: true }).ok, true);
});

test("DD-012C component validation rejects unsafe routing and fractional quantity", () => {
  const base = {
    id: "combo-main",
    parentProductId: "breakfast-combo",
    componentKey: "main_plate",
    nameVi: "Phần chính",
    nameEn: "Main plate",
    qty: 1,
    stationCode: "KITCHEN_HOT",
    displayOrder: 0
  };
  assert.equal(validateComponentDraft({ ...base, qty: 1.5 }).ok, false);
  assert.ok(validateComponentDraft({ ...base, qty: 1.5 }).errors.includes("INVALID_COMPONENT_QTY"));
  assert.ok(validateComponentDraft({ ...base, stationCode: "bad station" }).errors.includes("INVALID_COMPONENT_STATION"));
  assert.ok(validateComponentDraft({ ...base, componentKey: "bad key!" }).errors.includes("INVALID_COMPONENT_KEY"));
});

test("DD-012C create adapter canonicalizes IDs/station and preserves integer quantity", async () => {
  const { api, calls } = harness();
  await api.createComponent({
    parentProductId: " Breakfast-Combo ",
    id: " Combo-Main ",
    componentKey: " MAIN_PLATE ",
    nameVi: "Phần chính",
    nameEn: "Main plate",
    qty: 2,
    stationCode: " kitchen_hot ",
    displayOrder: 1,
    idempotencyKey: "dd012c-create"
  });
  assert.equal(calls[0].name, "dd012_create_product_component");
  assert.equal(calls[0].params.p_location_id, "deedou-demo");
  assert.equal(calls[0].params.p_workstation_mode, "ADMIN");
  assert.equal(calls[0].params.p_device_credential, "dd012c-device");
  assert.equal(calls[0].params.p_parent_product_id, "breakfast-combo");
  assert.equal(calls[0].params.p_component_id, "combo-main");
  assert.equal(calls[0].params.p_component_key, "main_plate");
  assert.equal(calls[0].params.p_qty, 2);
  assert.equal(calls[0].params.p_station_code, "KITCHEN_HOT");
});

test("DD-012C adapter never truncates fractional quantity or display order", async () => {
  const { api, calls } = harness();
  await api.createComponent({
    parentProductId: "combo",
    id: "combo-main",
    componentKey: "main",
    nameVi: "Main",
    nameEn: "Main",
    qty: 1.5,
    stationCode: "KITCHEN",
    displayOrder: 2.5,
    idempotencyKey: "dd012c-fractional"
  });
  assert.equal(calls[0].params.p_qty, null);
  assert.equal(calls[0].params.p_display_order, null);
});

test("DD-012C update/delete adapters carry optimistic updatedAt", async () => {
  const { api, calls } = harness();
  await api.updateComponent({
    id: "combo-main",
    componentKey: "main",
    nameVi: "Mới",
    nameEn: "Updated",
    qty: 3,
    stationCode: "KITCHEN_FINISH",
    displayOrder: 2,
    expectedUpdatedAt: "2026-08-21T20:31:00Z",
    idempotencyKey: "dd012c-update"
  });
  await api.deleteComponent({
    id: "combo-main",
    expectedUpdatedAt: "2026-08-21T20:32:00Z",
    idempotencyKey: "dd012c-delete"
  });
  assert.equal(calls[0].name, "dd012_update_product_component");
  assert.equal(calls[0].params.p_expected_updated_at, "2026-08-21T20:31:00Z");
  assert.equal(calls[1].name, "dd012_delete_product_component");
  assert.equal(calls[1].params.p_expected_updated_at, "2026-08-21T20:32:00Z");
});
