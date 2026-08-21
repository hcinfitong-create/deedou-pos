const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeAdminVariant(value = {}) {
  return {
    id: text(value.id).toLowerCase(),
    productId: text(value.productId ?? value.product_id).toLowerCase(),
    variantKey: text(value.variantKey ?? value.variant_key).toLowerCase(),
    nameVi: text(value.nameVi ?? value.name_vi),
    nameEn: text(value.nameEn ?? value.name_en),
    priceDeltaVnd: integerOrNaN(value.priceDeltaVnd ?? value.price_delta_vnd),
    available: value.available !== false,
    displayOrder: integerOrNaN(value.displayOrder ?? value.display_order ?? 0),
    updatedAt: text(value.updatedAt ?? value.updated_at)
  };
}

export function validateVariantDraft(value = {}, { requireId = true, requireProductId = true } = {}) {
  const variant = normalizeAdminVariant(value);
  if (requireId && !ENTITY_ID_PATTERN.test(variant.id)) return invalid("INVALID_VARIANT_ID", variant);
  if (requireProductId && !ENTITY_ID_PATTERN.test(variant.productId)) return invalid("INVALID_PRODUCT_ID", variant);
  if (!KEY_PATTERN.test(variant.variantKey)) return invalid("INVALID_VARIANT_KEY", variant);
  if (!variant.nameVi || !variant.nameEn) return invalid("VARIANT_NAME_REQUIRED", variant);
  if (!Number.isInteger(variant.priceDeltaVnd)) return invalid("INVALID_VARIANT_PRICE_DELTA", variant);
  if (!Number.isInteger(variant.displayOrder) || variant.displayOrder < 0) return invalid("INVALID_DISPLAY_ORDER", variant);
  return { ok: true, reason: "", variant };
}

export function normalizeAdminModifierGroup(value = {}) {
  const minSelect = integerOrNaN(value.minSelect ?? value.min_select ?? 0);
  const maxSelect = integerOrNaN(value.maxSelect ?? value.max_select ?? 1);
  return {
    id: text(value.id).toLowerCase(),
    groupKey: text(value.groupKey ?? value.group_key).toLowerCase(),
    nameVi: text(value.nameVi ?? value.name_vi),
    nameEn: text(value.nameEn ?? value.name_en),
    required: value.required === true || (Number.isInteger(minSelect) && minSelect > 0),
    multiple: value.multiple === true,
    minSelect,
    maxSelect,
    displayOrder: integerOrNaN(value.displayOrder ?? value.display_order ?? 0),
    updatedAt: text(value.updatedAt ?? value.updated_at)
  };
}

export function validateModifierGroupDraft(value = {}, { requireId = true } = {}) {
  const modifierGroup = normalizeAdminModifierGroup(value);
  if (requireId && !ENTITY_ID_PATTERN.test(modifierGroup.id)) return invalidGroup("INVALID_MODIFIER_GROUP_ID", modifierGroup);
  if (!KEY_PATTERN.test(modifierGroup.groupKey)) return invalidGroup("INVALID_MODIFIER_GROUP_KEY", modifierGroup);
  if (!modifierGroup.nameVi || !modifierGroup.nameEn) return invalidGroup("MODIFIER_GROUP_NAME_REQUIRED", modifierGroup);
  if (!Number.isInteger(modifierGroup.minSelect) || modifierGroup.minSelect < 0) return invalidGroup("INVALID_MODIFIER_GROUP_MIN", modifierGroup);
  if (!Number.isInteger(modifierGroup.maxSelect) || modifierGroup.maxSelect < modifierGroup.minSelect) return invalidGroup("INVALID_MODIFIER_GROUP_MAX", modifierGroup);
  if (!modifierGroup.multiple && modifierGroup.maxSelect > 1) return invalidGroup("MODIFIER_GROUP_SINGLE_MAX", modifierGroup);
  if (modifierGroup.required && modifierGroup.minSelect < 1) return invalidGroup("MODIFIER_GROUP_REQUIRED_MIN", modifierGroup);
  if (!Number.isInteger(modifierGroup.displayOrder) || modifierGroup.displayOrder < 0) return invalidGroup("INVALID_DISPLAY_ORDER", modifierGroup);
  return { ok: true, reason: "", modifierGroup };
}

export function normalizeAdminModifierOption(value = {}) {
  return {
    id: text(value.id).toLowerCase(),
    modifierGroupId: text(value.modifierGroupId ?? value.modifier_group_id).toLowerCase(),
    optionKey: text(value.optionKey ?? value.option_key).toLowerCase(),
    nameVi: text(value.nameVi ?? value.name_vi),
    nameEn: text(value.nameEn ?? value.name_en),
    priceDeltaVnd: integerOrNaN(value.priceDeltaVnd ?? value.price_delta_vnd),
    available: value.available !== false,
    displayOrder: integerOrNaN(value.displayOrder ?? value.display_order ?? 0),
    updatedAt: text(value.updatedAt ?? value.updated_at)
  };
}

export function validateModifierOptionDraft(value = {}, { requireId = true, requireModifierGroupId = true } = {}) {
  const modifierOption = normalizeAdminModifierOption(value);
  if (requireId && !ENTITY_ID_PATTERN.test(modifierOption.id)) return invalidOption("INVALID_MODIFIER_OPTION_ID", modifierOption);
  if (requireModifierGroupId && !ENTITY_ID_PATTERN.test(modifierOption.modifierGroupId)) return invalidOption("INVALID_MODIFIER_GROUP_ID", modifierOption);
  if (!KEY_PATTERN.test(modifierOption.optionKey)) return invalidOption("INVALID_MODIFIER_OPTION_KEY", modifierOption);
  if (!modifierOption.nameVi || !modifierOption.nameEn) return invalidOption("MODIFIER_OPTION_NAME_REQUIRED", modifierOption);
  if (!Number.isInteger(modifierOption.priceDeltaVnd)) return invalidOption("INVALID_MODIFIER_OPTION_PRICE_DELTA", modifierOption);
  if (!Number.isInteger(modifierOption.displayOrder) || modifierOption.displayOrder < 0) return invalidOption("INVALID_DISPLAY_ORDER", modifierOption);
  return { ok: true, reason: "", modifierOption };
}

export function normalizeProductModifierGroupAssignment(value = {}) {
  return {
    productId: text(value.productId ?? value.product_id).toLowerCase(),
    modifierGroupId: text(value.modifierGroupId ?? value.modifier_group_id).toLowerCase(),
    displayOrder: integerOrNaN(value.displayOrder ?? value.display_order ?? 0),
    updatedAt: text(value.updatedAt ?? value.updated_at)
  };
}

export function validateProductModifierGroupAssignment(value = {}) {
  const assignment = normalizeProductModifierGroupAssignment(value);
  if (!ENTITY_ID_PATTERN.test(assignment.productId)) return invalidAssignment("INVALID_PRODUCT_ID", assignment);
  if (!ENTITY_ID_PATTERN.test(assignment.modifierGroupId)) return invalidAssignment("INVALID_MODIFIER_GROUP_ID", assignment);
  if (!Number.isInteger(assignment.displayOrder) || assignment.displayOrder < 0) return invalidAssignment("INVALID_DISPLAY_ORDER", assignment);
  return { ok: true, reason: "", assignment };
}

function invalid(reason, variant) {
  return { ok: false, reason, variant };
}

function invalidGroup(reason, modifierGroup) {
  return { ok: false, reason, modifierGroup };
}

function invalidOption(reason, modifierOption) {
  return { ok: false, reason, modifierOption };
}

function invalidAssignment(reason, assignment) {
  return { ok: false, reason, assignment };
}

function integerOrNaN(value) {
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  const number = Number(value);
  return Number.isInteger(number) ? number : Number.NaN;
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
