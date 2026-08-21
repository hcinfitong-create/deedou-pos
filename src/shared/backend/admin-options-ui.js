import { BACKEND_MODES, createAdminBackendApi, createAdminOptionsBackendApi, getBackendConfig } from "./index.js";
import { normalizeAdminProduct } from "../../features/admin-catalog/index.js";
import {
  normalizeAdminModifierGroup,
  normalizeAdminModifierOption,
  normalizeAdminVariant,
  normalizeProductModifierGroupAssignment,
  validateModifierGroupDraft,
  validateModifierOptionDraft,
  validateProductModifierGroupAssignment,
  validateVariantDraft
} from "../../features/admin-catalog/options.js";
import {
  DEFAULT_LOCATION_ID,
  STAFF_LOCATION_KEY,
  WORKSTATION_MODE_KEY,
  createSupabasePasswordAuthApi
} from "../auth/index.js";

const config = getBackendConfig();
const authApi = createSupabasePasswordAuthApi({ config, storage: localStorage, deviceStorage: localStorage });
const authStateRef = () => ({
  locationId: localStorage.getItem(STAFF_LOCATION_KEY) || DEFAULT_LOCATION_ID,
  workstationMode: localStorage.getItem(WORKSTATION_MODE_KEY) || "ADMIN",
  authorization: { workstationMode: "ADMIN" }
});
const adminApi = createAdminBackendApi({ config, authApi, deviceStorage: localStorage, authStateRef });
const optionsApi = createAdminOptionsBackendApi({ config, authApi, deviceStorage: localStorage, authStateRef });

let state = {
  loading: false,
  loaded: false,
  saving: false,
  products: [],
  variants: [],
  modifierGroups: [],
  modifierOptions: [],
  assignments: [],
  selectedProductId: "",
  message: ""
};

window.addEventListener("hashchange", () => queueMicrotask(render));
document.addEventListener("click", handleClick);
document.addEventListener("change", handleChange);

const appRoot = document.getElementById("app");
if (appRoot && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(render)).observe(appRoot, { childList: true });
}
queueMicrotask(render);

function isAdminRoute() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] === "admin";
}

function render() {
  const existing = document.querySelector("[data-dd012b-admin-options]");
  if (!isAdminRoute()) {
    existing?.remove();
    return;
  }
  const adminPage = document.querySelector("#app .admin-page") || document.querySelector("#app .page");
  if (!adminPage || adminPage.querySelector("[data-auth-login]")) {
    existing?.remove();
    return;
  }

  const panel = existing || document.createElement("section");
  panel.dataset.dd012bAdminOptions = "";
  panel.className = "panel section-pad dd008d-admin-menu dd012b-admin-options";
  if (!existing) adminPage.appendChild(panel);

  panel.innerHTML = `
    <div class="order-head">
      <div>
        <div class="kicker">SERVER OPTION AUTHORITY · DD-012B</div>
        <h2>Variants & modifiers</h2>
        <p class="muted">Variants, modifier groups/options và product assignment được ghi qua PostgreSQL menu.manage; order đã gửi giữ nguyên price/option snapshot lịch sử.</p>
      </div>
      <button class="ghost" data-dd012b-refresh ${canMutate() ? "" : "disabled"}>Refresh</button>
    </div>
    ${state.message ? `<p class="notice" data-dd012b-message>${escapeHtml(state.message)}</p>` : ""}
    ${config.mode !== BACKEND_MODES.SUPABASE ? `<p class="muted">Option authority chỉ bật ở SUPABASE.</p>` : renderBody()}
  `;

  if (config.mode === BACKEND_MODES.SUPABASE && !state.loaded && !state.loading) queueMicrotask(() => loadMenu());
}

function renderBody() {
  if (state.loading && !state.loaded) return `<p class="muted">Đang tải option authority…</p>`;
  if (!state.products.length) return `<p class="muted">Tạo product core trước khi cấu hình variants/modifiers.</p>`;
  ensureSelectedProduct();
  return `
    <div class="dd012b-product-picker">
      <label><span>Product</span><select data-dd012b-product-select ${state.saving ? "disabled" : ""}>${productOptions()}</select></label>
    </div>
    ${renderVariants()}
    ${renderModifierLibrary()}
  `;
}

function renderVariants() {
  const productId = state.selectedProductId;
  const variants = state.variants.filter((variant) => variant.productId === productId);
  return `
    <div class="dd012b-section" data-dd012b-variants>
      <div class="dd012-form-heading"><strong>Variants · ${escapeHtml(productId)}</strong><p class="muted">Nếu product có variant rows, server bắt buộc còn ít nhất một variant available.</p></div>
      <div class="dd012-product-form dd012b-create-row" data-dd012b-create-variant-form>
        <label><span>ID</span><input data-dd012b-variant-create="id" placeholder="${escapeAttr(productId)}-large" /></label>
        <label><span>Key</span><input data-dd012b-variant-create="variantKey" placeholder="large" /></label>
        <label><span>Name VI</span><input data-dd012b-variant-create="nameVi" /></label>
        <label><span>Name EN</span><input data-dd012b-variant-create="nameEn" /></label>
        <label><span>Price delta</span><input type="number" step="1000" value="0" data-dd012b-variant-create="priceDeltaVnd" /></label>
        <label><span>Order</span><input type="number" min="0" value="${variants.length}" data-dd012b-variant-create="displayOrder" /></label>
        <label><span>Available</span><input type="checkbox" checked data-dd012b-variant-create-available /></label>
        <button class="primary" data-dd012b-create-variant ${state.saving ? "disabled" : ""}>Add variant</button>
      </div>
      ${variants.length ? variants.map(renderVariantRow).join("") : `<p class="muted">Không có variant: product dùng base configuration.</p>`}
    </div>
  `;
}

function renderVariantRow(variant) {
  return `
    <div class="dd012-product-editor dd012b-row" data-dd012b-variant-row="${escapeAttr(variant.id)}">
      <label><span>ID</span><input value="${escapeAttr(variant.id)}" disabled /></label>
      <label><span>Key</span><input data-dd012b-variant-field="variantKey" value="${escapeAttr(variant.variantKey)}" /></label>
      <label><span>Name VI</span><input data-dd012b-variant-field="nameVi" value="${escapeAttr(variant.nameVi)}" /></label>
      <label><span>Name EN</span><input data-dd012b-variant-field="nameEn" value="${escapeAttr(variant.nameEn)}" /></label>
      <label><span>Price delta</span><input type="number" step="1000" data-dd012b-variant-field="priceDeltaVnd" value="${variant.priceDeltaVnd}" /></label>
      <label><span>Order</span><input type="number" min="0" data-dd012b-variant-field="displayOrder" value="${variant.displayOrder}" /></label>
      <label><span>Available</span><input type="checkbox" data-dd012b-variant-available ${variant.available ? "checked" : ""} /></label>
      <div class="split-actions">
        <button class="primary compact" data-dd012b-save-variant="${escapeAttr(variant.id)}" ${state.saving ? "disabled" : ""}>Save</button>
        <button class="ghost compact" data-dd012b-delete-variant="${escapeAttr(variant.id)}" ${state.saving ? "disabled" : ""}>Delete</button>
      </div>
    </div>
  `;
}

function renderModifierLibrary() {
  return `
    <div class="dd012b-section" data-dd012b-modifiers>
      <div class="dd012-form-heading"><strong>Modifier library</strong><p class="muted">Group được tạo độc lập; server chỉ cho assign vào product khi selection bounds khả thi.</p></div>
      <div class="dd012-product-form dd012b-create-row" data-dd012b-create-group-form>
        <label><span>ID</span><input data-dd012b-group-create="id" placeholder="sugar" /></label>
        <label><span>Key</span><input data-dd012b-group-create="groupKey" placeholder="sugar" /></label>
        <label><span>Name VI</span><input data-dd012b-group-create="nameVi" /></label>
        <label><span>Name EN</span><input data-dd012b-group-create="nameEn" /></label>
        <label><span>Min</span><input type="number" min="0" value="0" data-dd012b-group-create="minSelect" /></label>
        <label><span>Max</span><input type="number" min="0" value="1" data-dd012b-group-create="maxSelect" /></label>
        <label><span>Multiple</span><input type="checkbox" data-dd012b-group-create-multiple /></label>
        <label><span>Order</span><input type="number" min="0" value="${state.modifierGroups.length}" data-dd012b-group-create="displayOrder" /></label>
        <button class="primary" data-dd012b-create-group ${state.saving ? "disabled" : ""}>Add group</button>
      </div>
      ${state.modifierGroups.length ? state.modifierGroups.map(renderModifierGroup).join("") : `<p class="muted">Chưa có modifier group.</p>`}
    </div>
  `;
}

function renderModifierGroup(group) {
  const options = state.modifierOptions.filter((option) => option.modifierGroupId === group.id);
  const assignment = findAssignment(state.selectedProductId, group.id);
  return `
    <article class="dd008d-admin-product dd012b-group" data-dd012b-group="${escapeAttr(group.id)}">
      <div class="dd012-product-editor">
        <label><span>ID</span><input value="${escapeAttr(group.id)}" disabled /></label>
        <label><span>Key</span><input data-dd012b-group-field="groupKey" value="${escapeAttr(group.groupKey)}" /></label>
        <label><span>Name VI</span><input data-dd012b-group-field="nameVi" value="${escapeAttr(group.nameVi)}" /></label>
        <label><span>Name EN</span><input data-dd012b-group-field="nameEn" value="${escapeAttr(group.nameEn)}" /></label>
        <label><span>Min</span><input type="number" min="0" data-dd012b-group-field="minSelect" value="${group.minSelect}" /></label>
        <label><span>Max</span><input type="number" min="0" data-dd012b-group-field="maxSelect" value="${group.maxSelect}" /></label>
        <label><span>Multiple</span><input type="checkbox" data-dd012b-group-multiple ${group.multiple ? "checked" : ""} /></label>
        <label><span>Order</span><input type="number" min="0" data-dd012b-group-field="displayOrder" value="${group.displayOrder}" /></label>
        <div class="split-actions">
          <button class="primary compact" data-dd012b-save-group="${escapeAttr(group.id)}" ${state.saving ? "disabled" : ""}>Save group</button>
          <button class="ghost compact" data-dd012b-delete-group="${escapeAttr(group.id)}" ${state.saving ? "disabled" : ""}>Delete group</button>
        </div>
      </div>
      <div class="dd012b-assignment" data-dd012b-assignment="${escapeAttr(group.id)}">
        <strong>${assignment ? "Assigned" : "Not assigned"} · ${escapeHtml(state.selectedProductId)}</strong>
        <label><span>Assignment order</span><input type="number" min="0" value="${assignment?.displayOrder ?? group.displayOrder}" data-dd012b-assignment-order /></label>
        <button class="${assignment ? "ghost" : "primary"} compact" data-dd012b-toggle-assignment="${escapeAttr(group.id)}" ${state.saving ? "disabled" : ""}>${assignment ? "Unassign" : "Assign"}</button>
      </div>
      <div class="dd012b-options">
        <div class="dd012-form-heading"><strong>Options</strong><p class="muted">${options.length} option(s)</p></div>
        <div class="dd012-product-form dd012b-create-row" data-dd012b-create-option-form="${escapeAttr(group.id)}">
          <label><span>ID</span><input data-dd012b-option-create="id" placeholder="${escapeAttr(group.id)}-normal" /></label>
          <label><span>Key</span><input data-dd012b-option-create="optionKey" placeholder="normal" /></label>
          <label><span>Name VI</span><input data-dd012b-option-create="nameVi" /></label>
          <label><span>Name EN</span><input data-dd012b-option-create="nameEn" /></label>
          <label><span>Price delta</span><input type="number" step="1000" value="0" data-dd012b-option-create="priceDeltaVnd" /></label>
          <label><span>Order</span><input type="number" min="0" value="${options.length}" data-dd012b-option-create="displayOrder" /></label>
          <label><span>Available</span><input type="checkbox" checked data-dd012b-option-create-available /></label>
          <button class="primary compact" data-dd012b-create-option="${escapeAttr(group.id)}" ${state.saving ? "disabled" : ""}>Add option</button>
        </div>
        ${options.map(renderModifierOption).join("")}
      </div>
    </article>
  `;
}

function renderModifierOption(option) {
  return `
    <div class="dd012-product-editor dd012b-row" data-dd012b-option-row="${escapeAttr(option.id)}">
      <label><span>ID</span><input value="${escapeAttr(option.id)}" disabled /></label>
      <label><span>Key</span><input data-dd012b-option-field="optionKey" value="${escapeAttr(option.optionKey)}" /></label>
      <label><span>Name VI</span><input data-dd012b-option-field="nameVi" value="${escapeAttr(option.nameVi)}" /></label>
      <label><span>Name EN</span><input data-dd012b-option-field="nameEn" value="${escapeAttr(option.nameEn)}" /></label>
      <label><span>Price delta</span><input type="number" step="1000" data-dd012b-option-field="priceDeltaVnd" value="${option.priceDeltaVnd}" /></label>
      <label><span>Order</span><input type="number" min="0" data-dd012b-option-field="displayOrder" value="${option.displayOrder}" /></label>
      <label><span>Available</span><input type="checkbox" data-dd012b-option-available ${option.available ? "checked" : ""} /></label>
      <div class="split-actions">
        <button class="primary compact" data-dd012b-save-option="${escapeAttr(option.id)}" ${state.saving ? "disabled" : ""}>Save</button>
        <button class="ghost compact" data-dd012b-delete-option="${escapeAttr(option.id)}" ${state.saving ? "disabled" : ""}>Delete</button>
      </div>
    </div>
  `;
}

async function handleClick(event) {
  if (event.target.closest("[data-dd012b-refresh]")) return loadMenu({ force: true });
  if (event.target.closest("[data-dd012b-create-variant]")) return createVariant();
  if (event.target.closest("[data-dd012b-create-group]")) return createModifierGroup();

  const createOption = event.target.closest("[data-dd012b-create-option]");
  if (createOption) return createModifierOption(createOption.dataset.dd012bCreateOption || "");

  const saveVariant = event.target.closest("[data-dd012b-save-variant]");
  if (saveVariant) return saveVariantRow(saveVariant.dataset.dd012bSaveVariant || "");
  const deleteVariant = event.target.closest("[data-dd012b-delete-variant]");
  if (deleteVariant) return deleteVariantRow(deleteVariant.dataset.dd012bDeleteVariant || "");

  const saveGroup = event.target.closest("[data-dd012b-save-group]");
  if (saveGroup) return saveModifierGroup(saveGroup.dataset.dd012bSaveGroup || "");
  const deleteGroup = event.target.closest("[data-dd012b-delete-group]");
  if (deleteGroup) return deleteModifierGroup(deleteGroup.dataset.dd012bDeleteGroup || "");

  const saveOption = event.target.closest("[data-dd012b-save-option]");
  if (saveOption) return saveModifierOption(saveOption.dataset.dd012bSaveOption || "");
  const deleteOption = event.target.closest("[data-dd012b-delete-option]");
  if (deleteOption) return deleteModifierOption(deleteOption.dataset.dd012bDeleteOption || "");

  const assignment = event.target.closest("[data-dd012b-toggle-assignment]");
  if (assignment) return toggleAssignment(assignment.dataset.dd012bToggleAssignment || "");
}

function handleChange(event) {
  const productSelect = event.target.closest("[data-dd012b-product-select]");
  if (!productSelect) return;
  state.selectedProductId = productSelect.value || "";
  render();
}

async function createVariant() {
  const root = document.querySelector("[data-dd012b-create-variant-form]");
  if (!root || state.saving) return;
  const validation = validateVariantDraft({
    productId: state.selectedProductId,
    id: fieldValue(root, '[data-dd012b-variant-create="id"]'),
    variantKey: fieldValue(root, '[data-dd012b-variant-create="variantKey"]'),
    nameVi: fieldValue(root, '[data-dd012b-variant-create="nameVi"]'),
    nameEn: fieldValue(root, '[data-dd012b-variant-create="nameEn"]'),
    priceDeltaVnd: fieldValue(root, '[data-dd012b-variant-create="priceDeltaVnd"]'),
    displayOrder: fieldValue(root, '[data-dd012b-variant-create="displayOrder"]'),
    available: root.querySelector("[data-dd012b-variant-create-available]")?.checked === true
  });
  if (!validation.ok) return showBlocked("Create variant", validation.reason);
  await mutate("Create variant", () => optionsApi.createVariant({
    ...validation.variant,
    idempotencyKey: commandKey("create-variant", validation.variant.id)
  }));
}

async function saveVariantRow(id) {
  const current = state.variants.find((item) => item.id === id);
  const root = document.querySelector(`[data-dd012b-variant-row="${cssEscape(id)}"]`);
  if (!current || !root || state.saving) return;
  const validation = validateVariantDraft({
    ...current,
    variantKey: fieldValue(root, '[data-dd012b-variant-field="variantKey"]'),
    nameVi: fieldValue(root, '[data-dd012b-variant-field="nameVi"]'),
    nameEn: fieldValue(root, '[data-dd012b-variant-field="nameEn"]'),
    priceDeltaVnd: fieldValue(root, '[data-dd012b-variant-field="priceDeltaVnd"]'),
    displayOrder: fieldValue(root, '[data-dd012b-variant-field="displayOrder"]'),
    available: root.querySelector("[data-dd012b-variant-available]")?.checked === true
  });
  if (!validation.ok) return showBlocked("Update variant", validation.reason);
  await mutate("Update variant", () => optionsApi.updateVariant({
    ...validation.variant,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("update-variant", id)
  }));
}

async function deleteVariantRow(id) {
  const current = state.variants.find((item) => item.id === id);
  if (!current || state.saving) return;
  await mutate("Delete variant", () => optionsApi.deleteVariant({
    id,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("delete-variant", id)
  }));
}

async function createModifierGroup() {
  const root = document.querySelector("[data-dd012b-create-group-form]");
  if (!root || state.saving) return;
  const validation = validateModifierGroupDraft({
    id: fieldValue(root, '[data-dd012b-group-create="id"]'),
    groupKey: fieldValue(root, '[data-dd012b-group-create="groupKey"]'),
    nameVi: fieldValue(root, '[data-dd012b-group-create="nameVi"]'),
    nameEn: fieldValue(root, '[data-dd012b-group-create="nameEn"]'),
    minSelect: fieldValue(root, '[data-dd012b-group-create="minSelect"]'),
    maxSelect: fieldValue(root, '[data-dd012b-group-create="maxSelect"]'),
    multiple: root.querySelector("[data-dd012b-group-create-multiple]")?.checked === true,
    displayOrder: fieldValue(root, '[data-dd012b-group-create="displayOrder"]')
  });
  if (!validation.ok) return showBlocked("Create modifier group", validation.reason);
  await mutate("Create modifier group", () => optionsApi.createModifierGroup({
    ...validation.modifierGroup,
    idempotencyKey: commandKey("create-group", validation.modifierGroup.id)
  }));
}

async function saveModifierGroup(id) {
  const current = state.modifierGroups.find((item) => item.id === id);
  const root = document.querySelector(`[data-dd012b-group="${cssEscape(id)}"]`);
  if (!current || !root || state.saving) return;
  const validation = validateModifierGroupDraft({
    ...current,
    groupKey: fieldValue(root, '[data-dd012b-group-field="groupKey"]'),
    nameVi: fieldValue(root, '[data-dd012b-group-field="nameVi"]'),
    nameEn: fieldValue(root, '[data-dd012b-group-field="nameEn"]'),
    minSelect: fieldValue(root, '[data-dd012b-group-field="minSelect"]'),
    maxSelect: fieldValue(root, '[data-dd012b-group-field="maxSelect"]'),
    multiple: root.querySelector("[data-dd012b-group-multiple]")?.checked === true,
    displayOrder: fieldValue(root, '[data-dd012b-group-field="displayOrder"]')
  });
  if (!validation.ok) return showBlocked("Update modifier group", validation.reason);
  await mutate("Update modifier group", () => optionsApi.updateModifierGroup({
    ...validation.modifierGroup,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("update-group", id)
  }));
}

async function deleteModifierGroup(id) {
  const current = state.modifierGroups.find((item) => item.id === id);
  if (!current || state.saving) return;
  await mutate("Delete modifier group", () => optionsApi.deleteModifierGroup({
    id,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("delete-group", id)
  }));
}

async function createModifierOption(groupId) {
  const root = document.querySelector(`[data-dd012b-create-option-form="${cssEscape(groupId)}"]`);
  if (!root || state.saving) return;
  const validation = validateModifierOptionDraft({
    modifierGroupId: groupId,
    id: fieldValue(root, '[data-dd012b-option-create="id"]'),
    optionKey: fieldValue(root, '[data-dd012b-option-create="optionKey"]'),
    nameVi: fieldValue(root, '[data-dd012b-option-create="nameVi"]'),
    nameEn: fieldValue(root, '[data-dd012b-option-create="nameEn"]'),
    priceDeltaVnd: fieldValue(root, '[data-dd012b-option-create="priceDeltaVnd"]'),
    displayOrder: fieldValue(root, '[data-dd012b-option-create="displayOrder"]'),
    available: root.querySelector("[data-dd012b-option-create-available]")?.checked === true
  });
  if (!validation.ok) return showBlocked("Create modifier option", validation.reason);
  await mutate("Create modifier option", () => optionsApi.createModifierOption({
    ...validation.modifierOption,
    idempotencyKey: commandKey("create-option", validation.modifierOption.id)
  }));
}

async function saveModifierOption(id) {
  const current = state.modifierOptions.find((item) => item.id === id);
  const root = document.querySelector(`[data-dd012b-option-row="${cssEscape(id)}"]`);
  if (!current || !root || state.saving) return;
  const validation = validateModifierOptionDraft({
    ...current,
    optionKey: fieldValue(root, '[data-dd012b-option-field="optionKey"]'),
    nameVi: fieldValue(root, '[data-dd012b-option-field="nameVi"]'),
    nameEn: fieldValue(root, '[data-dd012b-option-field="nameEn"]'),
    priceDeltaVnd: fieldValue(root, '[data-dd012b-option-field="priceDeltaVnd"]'),
    displayOrder: fieldValue(root, '[data-dd012b-option-field="displayOrder"]'),
    available: root.querySelector("[data-dd012b-option-available]")?.checked === true
  });
  if (!validation.ok) return showBlocked("Update modifier option", validation.reason);
  await mutate("Update modifier option", () => optionsApi.updateModifierOption({
    ...validation.modifierOption,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("update-option", id)
  }));
}

async function deleteModifierOption(id) {
  const current = state.modifierOptions.find((item) => item.id === id);
  if (!current || state.saving) return;
  await mutate("Delete modifier option", () => optionsApi.deleteModifierOption({
    id,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("delete-option", id)
  }));
}

async function toggleAssignment(groupId) {
  const root = document.querySelector(`[data-dd012b-assignment="${cssEscape(groupId)}"]`);
  const current = findAssignment(state.selectedProductId, groupId);
  if (!root || state.saving) return;
  const validation = validateProductModifierGroupAssignment({
    productId: state.selectedProductId,
    modifierGroupId: groupId,
    displayOrder: fieldValue(root, "[data-dd012b-assignment-order]")
  });
  if (!validation.ok) return showBlocked("Modifier assignment", validation.reason);
  await mutate(current ? "Unassign modifier group" : "Assign modifier group", () => optionsApi.setProductModifierGroupAssignment({
    ...validation.assignment,
    assigned: !current,
    expectedUpdatedAt: current?.updatedAt || null,
    idempotencyKey: commandKey(current ? "unassign-group" : "assign-group", `${state.selectedProductId}:${groupId}`)
  }));
}

async function mutate(label, action) {
  if (state.saving) return;
  state.saving = true;
  state.message = `${label}…`;
  render();
  const result = await action();
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage(label, result);
    render();
    return;
  }
  state.message = `${label}: server confirmed.`;
  await loadMenu({ force: true, preserveMessage: true });
}

async function loadMenu(options = {}) {
  if (config.mode !== BACKEND_MODES.SUPABASE || state.loading || (state.loaded && !options.force)) return;
  state.loading = true;
  if (!options.preserveMessage) state.message = "Đang tải variants/modifiers authority…";
  render();
  const result = await adminApi.fetchMenu();
  state.loading = false;
  state.loaded = true;
  if (!result.ok) {
    clearCatalogState();
    state.message = resultMessage("Option catalog", result);
    render();
    return;
  }
  state.products = array(result.payload?.products).map(normalizeAdminProduct);
  state.variants = array(result.payload?.variants).map(normalizeAdminVariant);
  state.modifierGroups = array(result.payload?.modifierGroups).map(normalizeAdminModifierGroup);
  state.modifierOptions = array(result.payload?.modifierOptions).map(normalizeAdminModifierOption);
  state.assignments = array(result.payload?.productModifierGroups).map(normalizeProductModifierGroupAssignment);
  ensureSelectedProduct();
  if (!options.preserveMessage) {
    state.message = `Loaded ${state.variants.length} variants, ${state.modifierGroups.length} modifier groups, ${state.modifierOptions.length} options from PostgreSQL.`;
  }
  render();
}

function clearCatalogState() {
  state.products = [];
  state.variants = [];
  state.modifierGroups = [];
  state.modifierOptions = [];
  state.assignments = [];
  state.selectedProductId = "";
}

function ensureSelectedProduct() {
  if (state.products.some((product) => product.id === state.selectedProductId)) return;
  state.selectedProductId = state.products[0]?.id || "";
}

function productOptions() {
  return state.products.map((product) => `<option value="${escapeAttr(product.id)}" ${product.id === state.selectedProductId ? "selected" : ""}>${escapeHtml(product.nameVi || product.nameEn || product.id)} · ${escapeHtml(product.id)}</option>`).join("");
}

function findAssignment(productId, modifierGroupId) {
  return state.assignments.find((item) => item.productId === productId && item.modifierGroupId === modifierGroupId) || null;
}

function showBlocked(label, reason) {
  state.message = `${label} blocked: ${safeText(reason)}`;
  render();
}

function canMutate() {
  return config.mode === BACKEND_MODES.SUPABASE && !state.loading && !state.saving;
}

function fieldValue(root, selector) {
  return root?.querySelector(selector)?.value?.trim?.() || "";
}

function commandKey(action, identity) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dd012b:${action}:${safeText(identity)}:${random}`;
}

function resultMessage(label, result) {
  return `${label} failed: ${safeText(result.category)}: ${safeText(result.reason)}${result.correlationId ? ` · ${safeText(result.correlationId)}` : ""}`;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : safeText(value).replace(/["\\]/g, "\\$&");
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function escapeHtml(value) {
  return safeText(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
