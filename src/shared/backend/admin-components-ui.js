import {
  BACKEND_MODES,
  createAdminBackendApi,
  createAdminComponentsBackendApi,
  getBackendConfig
} from "./index.js";
import { normalizeAdminProduct } from "../../features/admin-catalog/index.js";
import {
  normalizeAdminComponent,
  validateComponentDraft
} from "../../features/admin-catalog/components.js";
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
const componentsApi = createAdminComponentsBackendApi({ config, authApi, deviceStorage: localStorage, authStateRef });

let state = {
  loading: false,
  loaded: false,
  saving: false,
  products: [],
  components: [],
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
  const existing = document.querySelector("[data-dd012c-admin-components]");
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
  panel.dataset.dd012cAdminComponents = "";
  panel.className = "panel section-pad dd008d-admin-menu dd012b-admin-options";
  if (!existing) adminPage.appendChild(panel);

  panel.innerHTML = `
    <div class="order-head">
      <div>
        <div class="kicker">COMBO COMPONENT AUTHORITY · DD-012C</div>
        <h2>Combo components</h2>
        <p class="muted">Mỗi component là snapshot routing của combo cho order tương lai. Order đã submit giữ nguyên component lines lịch sử.</p>
      </div>
      <button class="ghost" data-dd012c-refresh ${state.saving ? "disabled" : ""}>Refresh</button>
    </div>
    ${state.message ? `<p class="notice" data-dd012c-message>${escapeHtml(state.message)}</p>` : ""}
    ${config.mode !== BACKEND_MODES.SUPABASE ? `<p class="muted">Component authority chỉ bật ở SUPABASE.</p>` : renderBody()}
  `;

  if (config.mode === BACKEND_MODES.SUPABASE && !state.loaded && !state.loading) {
    queueMicrotask(() => loadMenu());
  }
}

function renderBody() {
  if (state.loading && !state.loaded) return `<p class="muted">Đang tải component authority…</p>`;
  if (!state.products.length) return `<p class="muted">Tạo product core trước khi cấu hình combo components.</p>`;

  ensureSelectedProduct();
  const components = selectedComponents();
  return `
    <div class="dd012b-product-picker">
      <label><span>Product</span><select data-dd012c-product-select ${state.saving ? "disabled" : ""}>${productOptions()}</select></label>
    </div>
    <div class="dd012b-section" data-dd012c-components>
      <div class="dd012-form-heading">
        <strong>Components · ${escapeHtml(state.selectedProductId)}</strong>
        <p class="muted">Qty phải là số nguyên dương; station dùng mã routing như KITCHEN_HOT hoặc BAR_COFFEE.</p>
      </div>
      <div class="dd012-product-form dd012b-create-row" data-dd012c-create-form>
        <label><span>ID</span><input data-dd012c-create="id" placeholder="${escapeAttr(state.selectedProductId)}-main" /></label>
        <label><span>Key</span><input data-dd012c-create="componentKey" placeholder="main" /></label>
        <label><span>Name VI</span><input data-dd012c-create="nameVi" /></label>
        <label><span>Name EN</span><input data-dd012c-create="nameEn" /></label>
        <label><span>Qty</span><input type="number" min="1" step="1" value="1" data-dd012c-create="qty" /></label>
        <label><span>Station</span><input data-dd012c-create="stationCode" placeholder="KITCHEN_HOT" /></label>
        <label><span>Order</span><input type="number" min="0" step="1" value="${components.length}" data-dd012c-create="displayOrder" /></label>
        <button class="primary" data-dd012c-create ${state.saving ? "disabled" : ""}>Add component</button>
      </div>
      ${components.length ? components.map(renderComponentRow).join("") : `<p class="muted">Product này chưa có component; nó sẽ được xử lý như product thường.</p>`}
    </div>
  `;
}

function renderComponentRow(component) {
  return `
    <div class="dd012-product-editor dd012b-row" data-dd012c-row="${escapeAttr(component.id)}">
      <label><span>ID</span><input value="${escapeAttr(component.id)}" disabled /></label>
      <label><span>Key</span><input data-dd012c-field="componentKey" value="${escapeAttr(component.componentKey)}" /></label>
      <label><span>Name VI</span><input data-dd012c-field="nameVi" value="${escapeAttr(component.nameVi)}" /></label>
      <label><span>Name EN</span><input data-dd012c-field="nameEn" value="${escapeAttr(component.nameEn)}" /></label>
      <label><span>Qty</span><input type="number" min="1" step="1" data-dd012c-field="qty" value="${component.qty}" /></label>
      <label><span>Station</span><input data-dd012c-field="stationCode" value="${escapeAttr(component.stationCode)}" /></label>
      <label><span>Order</span><input type="number" min="0" step="1" data-dd012c-field="displayOrder" value="${component.displayOrder}" /></label>
      <div class="split-actions">
        <button class="primary compact" data-dd012c-save="${escapeAttr(component.id)}" ${state.saving ? "disabled" : ""}>Save</button>
        <button class="ghost compact" data-dd012c-delete="${escapeAttr(component.id)}" ${state.saving ? "disabled" : ""}>Delete</button>
      </div>
    </div>
  `;
}

async function handleClick(event) {
  if (event.target.closest("[data-dd012c-refresh]")) return loadMenu({ force: true });
  if (event.target.closest("[data-dd012c-create]")) return createComponent();

  const save = event.target.closest("[data-dd012c-save]");
  if (save) return saveComponent(save.dataset.dd012cSave || "");

  const remove = event.target.closest("[data-dd012c-delete]");
  if (remove) return deleteComponent(remove.dataset.dd012cDelete || "");
}

function handleChange(event) {
  const select = event.target.closest("[data-dd012c-product-select]");
  if (!select) return;
  state.selectedProductId = select.value;
  state.message = "";
  render();
}

async function loadMenu({ force = false } = {}) {
  if (state.loading || (state.loaded && !force)) return;
  state.loading = true;
  state.message = "";
  render();

  const result = await adminApi.fetchMenu({ locationId: currentLocationId() });
  state.loading = false;
  if (!result.ok) {
    state.loaded = false;
    state.message = resultMessage(result);
    render();
    return;
  }

  state.products = asArray(result.payload?.products).map(normalizeAdminProduct);
  state.components = asArray(result.payload?.components).map(normalizeAdminComponent);
  state.loaded = true;
  ensureSelectedProduct();
  render();
}

async function createComponent() {
  const form = document.querySelector("[data-dd012c-create-form]");
  if (!form || !state.selectedProductId) return;

  const draft = normalizeAdminComponent({
    parentProductId: state.selectedProductId,
    id: fieldValue(form, "[data-dd012c-create='id']"),
    componentKey: fieldValue(form, "[data-dd012c-create='componentKey']"),
    nameVi: fieldValue(form, "[data-dd012c-create='nameVi']"),
    nameEn: fieldValue(form, "[data-dd012c-create='nameEn']"),
    qty: fieldValue(form, "[data-dd012c-create='qty']"),
    stationCode: fieldValue(form, "[data-dd012c-create='stationCode']"),
    displayOrder: fieldValue(form, "[data-dd012c-create='displayOrder']")
  });
  const validation = validateComponentDraft(draft);
  if (!validation.ok) return setMessage(validation.errors.join(", "));

  await mutate(() => componentsApi.createComponent({
    ...validation.component,
    locationId: currentLocationId(),
    idempotencyKey: commandKey("create", validation.component.id)
  }), "Component created");
}

async function saveComponent(componentId) {
  const existing = state.components.find((component) => component.id === componentId);
  const row = document.querySelector(`[data-dd012c-row="${cssEscape(componentId)}"]`);
  if (!existing || !row) return;

  const draft = normalizeAdminComponent({
    ...existing,
    componentKey: fieldValue(row, "[data-dd012c-field='componentKey']"),
    nameVi: fieldValue(row, "[data-dd012c-field='nameVi']"),
    nameEn: fieldValue(row, "[data-dd012c-field='nameEn']"),
    qty: fieldValue(row, "[data-dd012c-field='qty']"),
    stationCode: fieldValue(row, "[data-dd012c-field='stationCode']"),
    displayOrder: fieldValue(row, "[data-dd012c-field='displayOrder']")
  });
  const validation = validateComponentDraft(draft, { requireUpdatedAt: true });
  if (!validation.ok) return setMessage(validation.errors.join(", "));

  await mutate(() => componentsApi.updateComponent({
    ...validation.component,
    expectedUpdatedAt: validation.component.updatedAt,
    locationId: currentLocationId(),
    idempotencyKey: commandKey("update", componentId)
  }), "Component updated");
}

async function deleteComponent(componentId) {
  const existing = state.components.find((component) => component.id === componentId);
  if (!existing?.updatedAt) return setMessage("EXPECTED_UPDATED_AT_REQUIRED");

  await mutate(() => componentsApi.deleteComponent({
    id: componentId,
    expectedUpdatedAt: existing.updatedAt,
    locationId: currentLocationId(),
    idempotencyKey: commandKey("delete", componentId)
  }), "Component deleted");
}

async function mutate(action, successMessage) {
  if (state.saving) return;
  state.saving = true;
  state.message = "";
  render();

  const result = await action();
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage(result);
    render();
    return;
  }

  state.loaded = false;
  state.message = successMessage;
  await loadMenu({ force: true });
  state.message = successMessage;
  render();
}

function selectedComponents() {
  return state.components
    .filter((component) => component.parentProductId === state.selectedProductId)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.componentKey.localeCompare(right.componentKey));
}

function ensureSelectedProduct() {
  if (state.products.some((product) => product.id === state.selectedProductId)) return;
  state.selectedProductId = state.products[0]?.id || "";
}

function productOptions() {
  return state.products.map((product) => `
    <option value="${escapeAttr(product.id)}" ${product.id === state.selectedProductId ? "selected" : ""}>
      ${escapeHtml(product.nameVi || product.id)} · ${escapeHtml(product.id)}
    </option>
  `).join("");
}

function currentLocationId() {
  return localStorage.getItem(STAFF_LOCATION_KEY) || DEFAULT_LOCATION_ID;
}

function commandKey(action, id) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dd012c-ui-${action}-${id}-${suffix}`;
}

function setMessage(message) {
  state.message = message;
  render();
}

function resultMessage(result) {
  return [result?.category, result?.reason].filter(Boolean).join(" · ") || "COMPONENT_COMMAND_FAILED";
}

function fieldValue(root, selector) {
  return root.querySelector(selector)?.value ?? "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cssEscape(value) {
  return globalThis.CSS?.escape?.(value) || String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
