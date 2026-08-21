export const PRODUCT_KINDS = Object.freeze(["FOOD", "DRINK"]);
export const PRODUCT_PERIODS = Object.freeze(["morning", "afternoon", "evening"]);
export const PRODUCT_CATEGORIES = Object.freeze({
  FOOD: Object.freeze(["food-combo", "food-single", "food-dessert"]),
  DRINK: Object.freeze(["drink-coffee", "drink-tea", "drink-signature"])
});

export function normalizeAdminProduct(value = {}) {
  return {
    id: text(value.id).toLowerCase(),
    kind: text(value.kind).toUpperCase(),
    category: text(value.category).toLowerCase(),
    nameVi: text(value.nameVi ?? value.name_vi),
    nameEn: text(value.nameEn ?? value.name_en),
    descVi: text(value.descVi ?? value.desc_vi),
    descEn: text(value.descEn ?? value.desc_en),
    priceVnd: number(value.priceVnd ?? value.price_vnd),
    stationCode: text(value.stationCode ?? value.station_code).toUpperCase(),
    periods: normalizePeriods(value.periods),
    imageUrl: text(value.imageUrl ?? value.image_url),
    color: text(value.color),
    art: text(value.art),
    available: value.available !== false,
    createdAt: text(value.createdAt ?? value.created_at),
    updatedAt: text(value.updatedAt ?? value.updated_at)
  };
}

export function validateProductDraft(value = {}, { requireId = true } = {}) {
  const product = normalizeAdminProduct(value);
  if (requireId && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(product.id)) return invalid("INVALID_PRODUCT_ID", product);
  if (!PRODUCT_KINDS.includes(product.kind)) return invalid("INVALID_PRODUCT_KIND", product);
  if (!PRODUCT_CATEGORIES[product.kind]?.includes(product.category)) return invalid("INVALID_PRODUCT_CATEGORY", product);
  if (!product.nameVi || !product.nameEn) return invalid("PRODUCT_NAME_REQUIRED", product);
  if (!Number.isInteger(product.priceVnd) || product.priceVnd < 0) return invalid("INVALID_PRODUCT_PRICE", product);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(product.stationCode)) return invalid("INVALID_STATION_CODE", product);
  if (!product.periods.length) return invalid("INVALID_PRODUCT_PERIODS", product);
  return { ok: true, reason: "", product };
}

function normalizePeriods(value) {
  const source = Array.isArray(value) ? value : text(value).split(",");
  return PRODUCT_PERIODS.filter((period) => source.map((item) => text(item).toLowerCase()).includes(period));
}

function invalid(reason, product) {
  return { ok: false, reason, product };
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
