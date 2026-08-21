import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAdminModifierGroup,
  normalizeAdminModifierOption,
  normalizeAdminVariant,
  normalizeProductModifierGroupAssignment,
  validateModifierGroupDraft,
  validateModifierOptionDraft,
  validateProductModifierGroupAssignment,
  validateVariantDraft
} from "../src/features/admin-catalog/options.js";
import { BACKEND_MODES, createAdminOptionsBackendApi } from "../src/shared/backend/index.js";

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
          entity_type: name.includes("modifier_group_assignment") ? "product_modifier_group" : "catalog_option",
          entity_id: params.p_variant_id || params.p_modifier_group_id || params.p_modifier_option_id || `${params.p_product_id}:${params.p_modifier_group_id}`,
          payload: {}
        }],
        error: null
      };
    }
  };
  const api = createAdminOptionsBackendApi({
    config,
    authApi: { getClient: async () => client },
    deviceStorage: { getItem: (key) => key === "deedou_device_credential" ? "dd012b-device" : null },
    authStateRef: () => ({ locationId: "deedou-demo", authorization: { workstationMode: "ADMIN" } })
  });
  return { api, calls };
}

test("DD-012B variant normalization and validation preserve integer price deltas", () => {
  const variant = normalizeAdminVariant({
    id: " Tea-Large ",
    product_id: " Tea ",
    variant_key: " LARGE ",
    name_vi: " Lớn ",
    name_en: " Large ",
    price_delta_vnd: -5000,
    display_order: 2
  });
  assert.equal(variant.id, "tea-large");
  assert.equal(variant.productId, "tea");
  assert.equal(variant.variantKey, "large");
  assert.equal(variant.priceDeltaVnd, -5000);
  assert.equal(validateVariantDraft(variant).ok, true);
  assert.equal(validateVariantDraft({ ...variant, priceDeltaVnd: 12.5 }).reason, "INVALID_VARIANT_PRICE_DELTA");
});

test("DD-012B modifier group validation enforces selection bounds without requiring options before assignment", () => {
  const group = normalizeAdminModifierGroup({
    id: " Sugar ",
    group_key: " SUGAR_LEVEL ",
    name_vi: "Đường",
    name_en: "Sugar",
    min_select: 1,
    max_select: 2,
    multiple: true,
    display_order: 1
  });
  assert.equal(group.id, "sugar");
  assert.equal(group.groupKey, "sugar_level");
  assert.equal(group.required, true);
  assert.equal(validateModifierGroupDraft(group).ok, true);
  assert.equal(validateModifierGroupDraft({ ...group, multiple: false, maxSelect: 2 }).reason, "MODIFIER_GROUP_SINGLE_MAX");
  assert.equal(validateModifierGroupDraft({ ...group, minSelect: 3, maxSelect: 2 }).reason, "INVALID_MODIFIER_GROUP_MAX");
});

test("DD-012B modifier option and assignment validation normalize server identifiers", () => {
  const option = normalizeAdminModifierOption({
    id: " Sugar-Normal ",
    modifier_group_id: " Sugar ",
    option_key: " NORMAL ",
    name_vi: "Bình thường",
    name_en: "Normal",
    price_delta_vnd: 3000,
    display_order: 2
  });
  assert.equal(option.id, "sugar-normal");
  assert.equal(option.modifierGroupId, "sugar");
  assert.equal(option.optionKey, "normal");
  assert.equal(validateModifierOptionDraft(option).ok, true);

  const assignment = normalizeProductModifierGroupAssignment({
    product_id: " Tea ",
    modifier_group_id: " Sugar ",
    display_order: 4
  });
  assert.deepEqual(assignment, {
    productId: "tea",
    modifierGroupId: "sugar",
    displayOrder: 4,
    updatedAt: ""
  });
  assert.equal(validateProductModifierGroupAssignment(assignment).ok, true);
});

test("DD-012B variant adapter sends canonical identifiers and optimistic token", async () => {
  const { api, calls } = harness();
  await api.createVariant({
    productId: " Tea ",
    id: " Tea-Large ",
    variantKey: " LARGE ",
    nameVi: "Lớn",
    nameEn: "Large",
    priceDeltaVnd: 10000,
    displayOrder: 1,
    idempotencyKey: "dd012b-create-variant"
  });
  await api.updateVariant({
    id: " Tea-Large ",
    variantKey: " LARGE ",
    nameVi: "Đại",
    nameEn: "Extra Large",
    priceDeltaVnd: 15000,
    available: true,
    displayOrder: 1,
    expectedUpdatedAt: "2026-08-21T18:30:00Z",
    idempotencyKey: "dd012b-update-variant"
  });
  assert.equal(calls[0].name, "dd012_create_variant");
  assert.equal(calls[0].params.p_product_id, "tea");
  assert.equal(calls[0].params.p_variant_id, "tea-large");
  assert.equal(calls[0].params.p_variant_key, "large");
  assert.equal(calls[0].params.p_location_id, "deedou-demo");
  assert.equal(calls[0].params.p_workstation_mode, "ADMIN");
  assert.equal(calls[0].params.p_device_credential, "dd012b-device");
  assert.equal(calls[1].name, "dd012_update_variant");
  assert.equal(calls[1].params.p_expected_updated_at, "2026-08-21T18:30:00Z");
});

test("DD-012B modifier adapters preserve integer bounds and never truncate fractional deltas", async () => {
  const { api, calls } = harness();
  await api.createModifierGroup({
    id: " Sugar ",
    groupKey: " SUGAR ",
    nameVi: "Đường",
    nameEn: "Sugar",
    required: true,
    multiple: true,
    minSelect: 1,
    maxSelect: 2,
    displayOrder: 1,
    idempotencyKey: "dd012b-create-group"
  });
  await api.createModifierOption({
    modifierGroupId: " Sugar ",
    id: " Sugar-Normal ",
    optionKey: " NORMAL ",
    nameVi: "Bình thường",
    nameEn: "Normal",
    priceDeltaVnd: 12.5,
    displayOrder: 1,
    idempotencyKey: "dd012b-create-option"
  });
  assert.equal(calls[0].name, "dd012_create_modifier_group");
  assert.equal(calls[0].params.p_min_select, 1);
  assert.equal(calls[0].params.p_max_select, 2);
  assert.equal(calls[1].name, "dd012_create_modifier_option");
  assert.equal(calls[1].params.p_price_delta_vnd, null);
});

test("DD-012B assignment adapter canonicalizes IDs and carries assignment concurrency", async () => {
  const { api, calls } = harness();
  await api.setProductModifierGroupAssignment({
    productId: " Tea ",
    modifierGroupId: " Sugar ",
    assigned: false,
    displayOrder: 3,
    expectedUpdatedAt: "2026-08-21T18:31:00Z",
    idempotencyKey: "dd012b-unassign"
  });
  assert.equal(calls[0].name, "dd012_set_product_modifier_group_assignment");
  assert.equal(calls[0].params.p_product_id, "tea");
  assert.equal(calls[0].params.p_modifier_group_id, "sugar");
  assert.equal(calls[0].params.p_assigned, false);
  assert.equal(calls[0].params.p_display_order, 3);
  assert.equal(calls[0].params.p_expected_updated_at, "2026-08-21T18:31:00Z");
});
