import test from "node:test";
import assert from "node:assert/strict";

import { BACKEND_MODES, createAdminBackendApi } from "../src/shared/backend/index.js";
import {
  buildCustomerTableUrl,
  dropPositionFromPointer,
  groupAdminTablesByZone,
  normalizeAdminTable,
  validateTableDraft
} from "../src/features/admin-tables/index.js";

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
      if (name === "dd010a_get_admin_table_layout") {
        return { data: [{ ok: true, category: "OK", payload: { tables: [{ id: "tbl-a05", code: "A05", zone: "Beach", qrToken: "ddt_test_123456789", version: 1 }] } }], error: null };
      }
      return { data: [{ ok: true, category: "OK", entity_type: "physical_table", entity_id: params.p_table_id || "tbl-new", version: (params.p_expected_version || 0) + 1, payload: { table: { id: params.p_table_id || "tbl-new", code: params.p_code || "A05", zone: params.p_zone || "Beach", version: (params.p_expected_version || 0) + 1 } } }], error: null };
    }
  };
  const api = createAdminBackendApi({
    config,
    authApi: { getClient: async () => client },
    deviceStorage: { getItem: (key) => key === "deedou_device_credential" ? "admin-device" : null },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  return { api, calls };
}

test("DD-010A Admin table adapter carries authority context for snapshot", async () => {
  const { api, calls } = harness();
  const result = await api.fetchTableLayout();
  assert.equal(result.ok, true);
  assert.equal(calls[0].name, "dd010a_get_admin_table_layout");
  assert.equal(calls[0].params.p_location_id, "deedou-demo");
  assert.equal(calls[0].params.p_workstation_mode, "ADMIN");
  assert.equal(calls[0].params.p_device_credential, "admin-device");
});

test("DD-010A create/update/active/rotate adapters send exact RPC parameters", async () => {
  const { api, calls } = harness();
  await api.createPhysicalTable({ code: "a05", zone: "Beach", seatCount: 6, shape: "round", layoutX: 10, layoutY: 12, layoutWidth: 3, layoutHeight: 3, displayOrder: 5, idempotencyKey: "create-1" });
  await api.updatePhysicalTable({ tableId: "tbl-a05", code: "A05", zone: "Beach", seatCount: 6, shape: "ROUND", layoutX: 20, layoutY: 22, layoutWidth: 3, layoutHeight: 3, displayOrder: 5, expectedVersion: 4, idempotencyKey: "update-1" });
  await api.setPhysicalTableActive({ tableId: "tbl-a05", active: false, expectedVersion: 5, idempotencyKey: "active-1" });
  await api.rotatePhysicalTableQr({ tableId: "tbl-a05", expectedVersion: 6, idempotencyKey: "rotate-1" });

  assert.equal(calls[0].name, "dd010a_create_physical_table");
  assert.equal(calls[0].params.p_code, "a05");
  assert.equal(calls[0].params.p_shape, "ROUND");
  assert.equal(calls[0].params.p_seat_count, 6);
  assert.equal(calls[0].params.p_idempotency_key, "create-1");

  assert.equal(calls[1].name, "dd010a_update_physical_table");
  assert.equal(calls[1].params.p_table_id, "tbl-a05");
  assert.equal(calls[1].params.p_expected_version, 4);
  assert.equal(calls[1].params.p_layout_x, 20);

  assert.equal(calls[2].name, "dd010a_set_physical_table_active");
  assert.equal(calls[2].params.p_active, false);
  assert.equal(calls[2].params.p_expected_version, 5);

  assert.equal(calls[3].name, "dd010a_rotate_physical_table_qr");
  assert.equal(calls[3].params.p_expected_version, 6);
});

test("DD-010A Admin adapter fails closed outside SUPABASE", async () => {
  let called = false;
  const api = createAdminBackendApi({
    config: { mode: BACKEND_MODES.LOCAL_DEMO },
    authApi: { getClient: async () => ({ rpc: async () => { called = true; return { data: [], error: null }; } }) },
    deviceStorage: { getItem: () => "admin-device" },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  const result = await api.fetchTableLayout();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SUPABASE_REQUIRED");
  assert.equal(called, false);
});

test("DD-010A table helpers normalize, group and derive QR customer URL", () => {
  const table = normalizeAdminTable({ code: "a05", zone: "Beach", seat_count: 6, shape: "round", qr_token: "ddt_123456789012" });
  assert.equal(table.code, "A05");
  assert.equal(table.seatCount, 6);
  assert.equal(table.shape, "ROUND");
  const grouped = groupAdminTablesByZone([{ code: "B01", zone: "Indoor" }, table]);
  assert.deepEqual(grouped.map((entry) => entry.zone), ["Beach", "Indoor"]);
  assert.equal(buildCustomerTableUrl("ddt_123456789012", "https://deedou-pos.vercel.app/admin?x=1#admin"), "https://deedou-pos.vercel.app/#/t/ddt_123456789012");
  assert.equal(validateTableDraft(table).ok, true);
});

test("DD-010A drop helper stores responsive percentage-like coordinates", () => {
  const next = dropPositionFromPointer({
    clientX: 600,
    clientY: 300,
    rect: { left: 100, top: 100, width: 1000, height: 400 },
    table: { layoutWidth: 2, layoutHeight: 2 }
  });
  assert.ok(next.layoutX >= 0 && next.layoutX <= 92);
  assert.ok(next.layoutY >= 0 && next.layoutY <= 90);
});
