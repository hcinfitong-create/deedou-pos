const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STATION_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function normalizeAdminComponent(component = {}) {
  return {
    id: lower(component.id),
    parentProductId: lower(component.parentProductId || component.parent_product_id),
    componentKey: lower(component.componentKey || component.component_key),
    nameVi: text(component.nameVi || component.name_vi),
    nameEn: text(component.nameEn || component.name_en),
    qty: integerOrValue(component.qty),
    stationCode: text(component.stationCode || component.station_code).toUpperCase(),
    displayOrder: integerOrValue(component.displayOrder ?? component.display_order ?? 0),
    updatedAt: component.updatedAt || component.updated_at || null
  };
}

export function validateComponentDraft(component = {}, { requireId = true, requireParent = true, requireUpdatedAt = false } = {}) {
  const normalized = normalizeAdminComponent(component);
  const errors = [];

  if (requireId && !ID_PATTERN.test(normalized.id)) errors.push("INVALID_COMPONENT_ID");
  if (requireParent && !ID_PATTERN.test(normalized.parentProductId)) errors.push("INVALID_PARENT_PRODUCT_ID");
  if (!KEY_PATTERN.test(normalized.componentKey)) errors.push("INVALID_COMPONENT_KEY");
  if (!normalized.nameVi || !normalized.nameEn) errors.push("COMPONENT_NAME_REQUIRED");
  if (!Number.isInteger(normalized.qty) || normalized.qty <= 0) errors.push("INVALID_COMPONENT_QTY");
  if (!STATION_PATTERN.test(normalized.stationCode)) errors.push("INVALID_COMPONENT_STATION");
  if (!Number.isInteger(normalized.displayOrder) || normalized.displayOrder < 0) errors.push("INVALID_COMPONENT_DISPLAY_ORDER");
  if (requireUpdatedAt && !normalized.updatedAt) errors.push("EXPECTED_UPDATED_AT_REQUIRED");

  return { ok: errors.length === 0, errors, component: normalized };
}

function integerOrValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return value;
}

function lower(value) {
  return text(value).toLowerCase();
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
