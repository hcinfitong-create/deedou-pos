const DEFAULT_LANG = "vi";

export function normalizeProductOptions(product = {}) {
  return {
    variants: normalizeVariants(product.variants || []),
    modifierGroups: normalizeModifierGroups(product.modifierGroups || product.modifiers || [])
  };
}

export function validateProductOptionConfig(product = {}) {
  const config = normalizeProductOptions(product);
  const errors = [];

  appendDuplicateErrors(config.variants.map((variant) => variant.id), "DUPLICATE_VARIANT_ID", errors);
  config.variants.forEach((variant) => {
    if (!variant.id) errors.push("VARIANT_ID_REQUIRED");
    if (!variant.vi || !variant.en) errors.push(`VARIANT_LABEL_REQUIRED:${variant.id || "UNKNOWN"}`);
  });
  config.modifierGroups.forEach((group) => {
    if (!group.id) errors.push("MODIFIER_GROUP_ID_REQUIRED");
    if (!group.vi || !group.en) errors.push(`MODIFIER_GROUP_LABEL_REQUIRED:${group.id || "UNKNOWN"}`);
    if (group.minSelect > group.maxSelect) errors.push(`MODIFIER_GROUP_INVALID_BOUNDS:${group.id}`);
    if (!group.multiple && group.maxSelect > 1) errors.push(`MODIFIER_GROUP_SINGLE_MAX:${group.id}`);
    if (group.maxSelect > group.options.length) errors.push(`MODIFIER_GROUP_MAX_EXCEEDS_OPTIONS:${group.id}`);
    const availableCount = group.options.filter((option) => option.available).length;
    if (group.minSelect > availableCount) errors.push(`MODIFIER_GROUP_MIN_EXCEEDS_AVAILABLE:${group.id}`);
    group.options.forEach((option) => {
      if (!option.id) errors.push(`MODIFIER_OPTION_ID_REQUIRED:${group.id || "UNKNOWN"}`);
      if (!option.vi || !option.en) errors.push(`MODIFIER_OPTION_LABEL_REQUIRED:${group.id || "UNKNOWN"}:${option.id || "UNKNOWN"}`);
    });
    appendDuplicateErrors(group.options.map((option) => option.id), `DUPLICATE_MODIFIER_OPTION_ID:${group.id}`, errors);
  });
  appendDuplicateErrors(config.modifierGroups.map((group) => group.id), "DUPLICATE_MODIFIER_GROUP_ID", errors);

  return { ok: errors.length === 0, errors, config };
}

export function hasProductOptions(product = {}) {
  const config = normalizeProductOptions(product);
  return config.variants.length > 0 || config.modifierGroups.length > 0;
}

export function defaultConfiguredSelection(product = {}) {
  const config = normalizeProductOptions(product);
  const variant = config.variants.find((item) => item.available);
  const modifierSelections = {};

  config.modifierGroups.forEach((group) => {
    if (group.minSelect <= 0) return;
    const optionIds = group.options
      .filter((option) => option.available)
      .slice(0, group.minSelect)
      .map((option) => option.id);
    if (optionIds.length) modifierSelections[group.id] = optionIds;
  });

  return canonicalizeConfiguredSelection(product, {
    variantId: variant?.id || "",
    modifierSelections
  });
}

export function canonicalizeConfiguredSelection(product = {}, selection = {}) {
  const config = normalizeProductOptions(product);
  const rawModifiers = rawModifierSelectionMap(selection);
  const modifierSelections = {};

  config.modifierGroups.forEach((group) => {
    const optionIds = canonicalOptionIds(rawModifiers.get(group.id) || [], group);
    if (optionIds.length) modifierSelections[group.id] = optionIds;
  });

  [...rawModifiers.entries()]
    .filter(([groupId]) => !config.modifierGroups.some((group) => group.id === groupId))
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([groupId, optionIds]) => {
      const uniqueIds = [...new Set(optionIds.map(toId).filter(Boolean))].sort();
      if (uniqueIds.length) modifierSelections[groupId] = uniqueIds;
    });

  return {
    variantId: toId(selection?.variantId || selection?.variant || selection?.variant_id || ""),
    modifierSelections
  };
}

export function configuredCartLineKey(productOrId, selection = {}) {
  const product = typeof productOrId === "string" ? { id: productOrId } : productOrId || {};
  const productId = toId(product.id || productOrId);
  const canonical = canonicalizeConfiguredSelection(product, selection);
  const modifierParts = Object.keys(canonical.modifierSelections)
    .sort()
    .map((groupId) => `${groupId}=${canonical.modifierSelections[groupId].join(",")}`);

  if (!canonical.variantId && !modifierParts.length) return productId;
  return [
    productId,
    `v:${canonical.variantId || ""}`,
    ...modifierParts.map((part) => `m:${part}`)
  ].join("|");
}

export function validateConfiguredSelection(product = {}, selection = {}) {
  const productValidation = validateProductOptionConfig(product);
  const config = productValidation.config;
  const canonical = canonicalizeConfiguredSelection(product, selection);
  const rawModifiers = rawModifierSelectionMap(selection);
  const errors = [...productValidation.errors];
  let unitPrice = Number(product.price) || 0;
  let variant = null;
  const selectedModifierGroups = [];

  if (config.variants.length) {
    if (!canonical.variantId) {
      errors.push("VARIANT_REQUIRED");
    } else {
      variant = config.variants.find((item) => item.id === canonical.variantId) || null;
      if (!variant) errors.push(`VARIANT_NOT_FOUND:${canonical.variantId}`);
      else if (!variant.available) errors.push(`VARIANT_UNAVAILABLE:${canonical.variantId}`);
      if (variant) unitPrice += variant.priceDelta;
    }
  } else if (canonical.variantId) {
    errors.push(`VARIANT_NOT_ALLOWED:${canonical.variantId}`);
  }

  const knownGroupIds = new Set(config.modifierGroups.map((group) => group.id));
  [...rawModifiers.keys()].forEach((groupId) => {
    if (!knownGroupIds.has(groupId)) errors.push(`MODIFIER_GROUP_NOT_FOUND:${groupId}`);
  });

  config.modifierGroups.forEach((group) => {
    const selectedIds = canonical.modifierSelections[group.id] || [];
    const rawIds = (rawModifiers.get(group.id) || []).map(toId).filter(Boolean);
    if (rawIds.length !== new Set(rawIds).size) errors.push(`DUPLICATE_MODIFIER_SELECTION:${group.id}`);
    if (selectedIds.length < group.minSelect) errors.push(`MODIFIER_GROUP_MIN:${group.id}`);
    if (selectedIds.length > group.maxSelect) errors.push(`MODIFIER_GROUP_MAX:${group.id}`);
    if (!group.multiple && selectedIds.length > 1) errors.push(`MODIFIER_GROUP_SINGLE:${group.id}`);

    const selectedOptions = selectedIds.map((optionId) => {
      const option = group.options.find((item) => item.id === optionId) || null;
      if (!option) errors.push(`MODIFIER_OPTION_NOT_FOUND:${group.id}:${optionId}`);
      else {
        if (!option.available) errors.push(`MODIFIER_OPTION_UNAVAILABLE:${group.id}:${optionId}`);
        unitPrice += option.priceDelta;
      }
      return option;
    }).filter(Boolean);

    if (selectedOptions.length) {
      selectedModifierGroups.push({
        id: group.id,
        vi: group.vi,
        en: group.en,
        options: selectedOptions
      });
    }
  });

  if (unitPrice < 0) errors.push("NEGATIVE_UNIT_PRICE");

  return {
    ok: errors.length === 0,
    errors,
    selection: canonical,
    unitPrice,
    configuredKey: configuredCartLineKey(product, canonical),
    variant,
    modifierGroups: selectedModifierGroups
  };
}

export function configuredUnitPrice(product = {}, selection = {}) {
  return validateConfiguredSelection(product, selection).unitPrice;
}

export function createOrderLineOptionSnapshot(product = {}, selection = {}) {
  const validation = validateConfiguredSelection(product, selection);
  if (!validation.ok) return validation;

  const optionSnapshot = {
    variant: validation.variant ? snapshotOption(validation.variant) : null,
    modifierGroups: validation.modifierGroups.map((group) => ({
      id: group.id,
      vi: group.vi,
      en: group.en,
      options: group.options.map(snapshotOption)
    }))
  };

  return {
    ok: true,
    errors: [],
    selection: validation.selection,
    configuredKey: validation.configuredKey,
    basePrice: Number(product.price) || 0,
    unitPrice: validation.unitPrice,
    optionSnapshot
  };
}

export function optionSummaryLines(lineOrSnapshot = {}, lang = DEFAULT_LANG) {
  const snapshot = lineOrSnapshot.optionSnapshot || lineOrSnapshot;
  const labelKey = lang === "en" ? "en" : "vi";
  const lines = [];

  if (snapshot.variant?.id) {
    lines.push(`${lang === "en" ? "Variant" : "Phiên bản"}: ${snapshot.variant[labelKey] || snapshot.variant.id}`);
  }
  (snapshot.modifierGroups || []).forEach((group) => {
    const labels = (group.options || []).map((option) => option[labelKey] || option.id).filter(Boolean);
    if (labels.length) lines.push(`${group[labelKey] || group.id}: ${labels.join(", ")}`);
  });

  return lines;
}

function normalizeVariants(variants = []) {
  return asArray(variants).map((variant) => ({
    id: toId(variant.id),
    vi: toLabel(variant.vi, variant.labelVi || variant.label || variant.name),
    en: toLabel(variant.en, variant.labelEn || variant.label || variant.name),
    priceDelta: normalizePriceDelta(variant.priceDelta),
    available: variant.available !== false
  }));
}

function normalizeModifierGroups(groups = []) {
  return asArray(groups).map((group) => {
    const options = asArray(group.options).map((option) => ({
      id: toId(option.id),
      vi: toLabel(option.vi, option.labelVi || option.label || option.name),
      en: toLabel(option.en, option.labelEn || option.label || option.name),
      priceDelta: normalizePriceDelta(option.priceDelta),
      available: option.available !== false
    }));
    const explicitMin = normalizeSelectBound(group.minSelect);
    const explicitMax = normalizeSelectBound(group.maxSelect);
    const required = group.required === true || (explicitMin ?? 0) > 0;
    const minSelect = explicitMin ?? (required ? 1 : 0);
    const multiple = group.multiple ?? (explicitMax !== null ? explicitMax > 1 : false);
    const maxSelect = explicitMax ?? (multiple ? options.length : 1);
    return {
      id: toId(group.id),
      vi: toLabel(group.vi, group.labelVi || group.label || group.name),
      en: toLabel(group.en, group.labelEn || group.label || group.name),
      required,
      multiple: !!multiple,
      minSelect,
      maxSelect,
      options
    };
  });
}

function rawModifierSelectionMap(selection = {}) {
  const source = selection?.modifierSelections || selection?.modifiers || selection?.modifier_ids || {};
  const map = new Map();

  if (Array.isArray(source)) {
    source.forEach((entry) => {
      const groupId = toId(entry.groupId || entry.group || entry.id);
      const optionIds = asArray(entry.optionIds || entry.options || entry.optionId || entry.option).map(toId).filter(Boolean);
      if (!groupId) return;
      map.set(groupId, [...(map.get(groupId) || []), ...optionIds]);
    });
    return map;
  }

  Object.entries(source || {}).forEach(([groupId, optionIds]) => {
    const safeGroupId = toId(groupId);
    if (!safeGroupId) return;
    map.set(safeGroupId, asArray(optionIds).map(toId).filter(Boolean));
  });

  return map;
}

function canonicalOptionIds(optionIds, group) {
  const uniqueIds = [...new Set(asArray(optionIds).map(toId).filter(Boolean))];
  const optionOrder = new Map(group.options.map((option, index) => [option.id, index]));
  return uniqueIds.sort((left, right) => {
    const leftIndex = optionOrder.has(left) ? optionOrder.get(left) : Number.MAX_SAFE_INTEGER;
    const rightIndex = optionOrder.has(right) ? optionOrder.get(right) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.localeCompare(right);
  });
}

function snapshotOption(option) {
  return {
    id: option.id,
    vi: option.vi,
    en: option.en,
    priceDelta: option.priceDelta
  };
}

function appendDuplicateErrors(ids, code, errors) {
  const seen = new Set();
  ids.filter(Boolean).forEach((id) => {
    if (seen.has(id)) errors.push(`${code}:${id}`);
    seen.add(id);
  });
}

function normalizeSelectBound(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalizePriceDelta(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function toLabel(value, fallback = "") {
  return String(value || fallback || "").trim();
}

function toId(value) {
  return String(value || "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}
