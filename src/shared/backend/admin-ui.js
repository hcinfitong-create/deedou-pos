import { BACKEND_MODES, createAdminBackendApi, getBackendConfig } from "./index.js";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_KINDS,
  PRODUCT_PERIODS,
  normalizeAdminProduct,
  validateProductDraft
} from "../../features/admin-catalog/index.js";
import {
  DEFAULT_LOCATION_ID,
  STAFF_LOCATION_KEY,
  WORKSTATION_MODE_KEY,
  createSupabasePasswordAuthApi
} from "../auth/index.js";

const config = getBackendConfig();
const authApi = createSupabasePasswordAuthApi({ config, storage: localStorage, deviceStorage: localStorage });
const adminApi = createAdminBackendApi({
  config,
  authApi,
  deviceStorage: localStorage,
  authStateRef: () => ({
    locationId: localStorage.getItem(STAFF_LOCATION_KEY) || DEFAULT_LOCATION_ID,
    workstationMode: localStorage.getItem(WORKSTATION_MODE_KEY) || "ADMIN",
    authorization: { workstationMode: "ADMIN" }
  })
});

let state = {
  loading: false,
  loaded: false,
  saving: false,
  products: [],
  editingId: "",
  message: ""
};

window.addEventListener("hashchange", () => queueMicrotask(render));
document.addEventListener("click", handleClick);

const appRoot = document.getElementById("app");
if (appRoot && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(render)).observe(appRoot, { childList: true });
}
queueMicrotask(render);

function isAdminRoute() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] === "admin";
}

function render() {
  const existing = document.querySelector("[data-dd008d-admin-menu]");
  if (!isAdminRoute()) {
    existing?.remove();
    return;
  }
  const adminPage = document.querySelector("#app .admin-page") || document.querySelector("#app .page");
  if (!adminPage) return;

  const panel = existing || document.createElement("section");
  panel.dataset.dd008dAdminMenu = "";
  panel.className = "panel section-pad dd008d-admin-menu";
  if (!existing) adminPage.appendChild(panel);

  panel.innerHTML = `
    <div class="order-head">
      <div>
        <div class="kicker">SERVER MENU AUTHORITY</div>
        <h2>Catalog & availability</h2>
        <p class="muted">Product core được tạo/sửa trực tiếp qua PostgreSQL menu.manage. localStorage không giữ business authority.</p>
      </div>
      <button class="ghost" data-dd008d-admin-refresh ${config.mode === BACKEND_MODES.SUPABASE && !state.loading && !state.saving ? "" : "disabled"}>Refresh</button>
    </div>
    ${state.message ? `<p class="notice" data-dd008d-admin-message>${escapeHtml(state.message)}</p>` : ""}
    ${config.mode !== BACKEND_MODES.SUPABASE ? `<p class="muted">LOCAL_DEMO giữ hành vi demo; catalog authority chỉ bật ở SUPABASE.</p>` : `
      ${renderCreateForm()}
      ${state.loading && !state.loaded ? `<p class="muted">Đang tải menu authority…</p>` : ""}
      ${state.products.length ? `<div class="dd008d-admin-products">${state.products.map(renderProduct).join("")}</div>` : state.loaded ? `<p class="muted">Chưa có sản phẩm. Tạo sản phẩm đầu tiên phía trên.</p>` : ""}
    `}
  `;

  if (config.mode === BACKEND_MODES.SUPABASE && !state.loaded && !state.loading) queueMicrotask(() => loadMenu());
}

function renderCreateForm() {
  return `
    <div class="dd012-product-form" data-dd012-create-form>
      <div class="dd012-form-heading"><strong>Add product</strong><p class="muted">Slice A quản lý product core; variants/modifiers sẽ ở slice tiếp theo.</p></div>
      <label><span>ID</span><input data-dd012-create="id" maxlength="80" placeholder="coconut-coffee" /></label>
      <label><span>Kind</span><select data-dd012-create="kind">${kindOptions("DRINK")}</select></label>
      <label><span>Category</span><select data-dd012-create="category">${categoryOptions("drink-coffee")}</select></label>
      <label><span>Name VI</span><input data-dd012-create="nameVi" maxlength="160" /></label>
      <label><span>Name EN</span><input data-dd012-create="nameEn" maxlength="160" /></label>
      <label><span>Price VND</span><input data-dd012-create="priceVnd" type="number" min="0" step="1000" /></label>
      <label><span>Station</span><input data-dd012-create="stationCode" maxlength="64" placeholder="BAR_COFFEE" /></label>
      <label class="dd012-wide"><span>Description VI</span><textarea data-dd012-create="descVi" rows="2"></textarea></label>
      <label class="dd012-wide"><span>Description EN</span><textarea data-dd012-create="descEn" rows="2"></textarea></label>
      <label><span>Image path</span><input data-dd012-create="imageUrl" placeholder="/images/item.png" /></label>
      <label><span>Color</span><input data-dd012-create="color" placeholder="#dcefe5" /></label>
      <label><span>Art key</span><input data-dd012-create="art" placeholder="cup" /></label>
      <div class="dd012-periods dd012-wide"><span>Service periods</span>${periodCheckboxes(PRODUCT_PERIODS, "data-dd012-create-period")}</div>
      <button class="primary" data-dd012-create-product ${state.saving ? "disabled" : ""}>Create product</button>
    </div>
  `;
}

function renderProduct(raw) {
  const product = normalizeAdminProduct(raw);
  const available = product.available === true;
  const editing = state.editingId === product.id;
  return `
    <article class="dd008d-admin-product dd012-product-card ${editing ? "editing" : ""}" data-dd008d-admin-product="${escapeAttr(product.id)}" data-dd012-product="${escapeAttr(product.id)}" data-available="${available}">
      <div class="dd012-product-summary">
        <strong>${escapeHtml(product.nameVi || product.nameEn || product.id)}</strong>
        <small>${escapeHtml(product.id)} · ${escapeHtml(product.category)} · ${formatMoney(product.priceVnd)} · ${escapeHtml(product.stationCode)}</small>
      </div>
      <div class="dd008d-admin-product-actions">
        <span class="station">${available ? "AVAILABLE" : "UNAVAILABLE"}</span>
        <button class="ghost compact" data-dd012-edit-product="${escapeAttr(product.id)}">${editing ? "Close" : "Edit"}</button>
        <button class="${available ? "ghost" : "primary"} compact"
                data-dd008d-set-availability="${available ? "false" : "true"}"
                data-product-id="${escapeAttr(product.id)}"
                data-updated-at="${escapeAttr(product.updatedAt || "")}">
          ${available ? "Set unavailable" : "Set available"}
        </button>
      </div>
      ${editing ? renderProductEditor(product) : ""}
    </article>
  `;
}

function renderProductEditor(product) {
  return `
    <div class="dd012-product-editor">
      <label><span>ID</span><input value="${escapeAttr(product.id)}" disabled /></label>
      <label><span>Kind</span><select data-dd012-field="kind">${kindOptions(product.kind)}</select></label>
      <label><span>Category</span><select data-dd012-field="category">${categoryOptions(product.category)}</select></label>
      <label><span>Name VI</span><input data-dd012-field="nameVi" value="${escapeAttr(product.nameVi)}" maxlength="160" /></label>
      <label><span>Name EN</span><input data-dd012-field="nameEn" value="${escapeAttr(product.nameEn)}" maxlength="160" /></label>
      <label><span>Price VND</span><input data-dd012-field="priceVnd" type="number" min="0" step="1000" value="${product.priceVnd}" /></label>
      <label><span>Station</span><input data-dd012-field="stationCode" value="${escapeAttr(product.stationCode)}" maxlength="64" /></label>
      <label class="dd012-wide"><span>Description VI</span><textarea data-dd012-field="descVi" rows="2">${escapeHtml(product.descVi)}</textarea></label>
      <label class="dd012-wide"><span>Description EN</span><textarea data-dd012-field="descEn" rows="2">${escapeHtml(product.descEn)}</textarea></label>
      <label><span>Image path</span><input data-dd012-field="imageUrl" value="${escapeAttr(product.imageUrl)}" /></label>
      <label><span>Color</span><input data-dd012-field="color" value="${escapeAttr(product.color)}" /></label>
      <label><span>Art key</span><input data-dd012-field="art" value="${escapeAttr(product.art)}" /></label>
      <div class="dd012-periods dd012-wide"><span>Service periods</span>${periodCheckboxes(product.periods, "data-dd012-edit-period")}</div>
      <div class="split-actions dd012-wide">
        <button class="primary" data-dd012-save-product="${escapeAttr(product.id)}" ${state.saving ? "disabled" : ""}>Save product</button>
      </div>
    </div>
  `;
}

async function handleClick(event) {
  const refresh = event.target.closest("[data-dd008d-admin-refresh]");
  if (refresh) return loadMenu({ force: true });

  const create = event.target.closest("[data-dd012-create-product]");
  if (create) return createProduct();

  const edit = event.target.closest("[data-dd012-edit-product]");
  if (edit) {
    const productId = edit.dataset.dd012EditProduct || "";
    state.editingId = state.editingId === productId ? "" : productId;
    render();
    return;
  }

  const save = event.target.closest("[data-dd012-save-product]");
  if (save) return saveProduct(save.dataset.dd012SaveProduct || "");

  const button = event.target.closest("[data-dd008d-set-availability]");
  if (!button) return;
  const productId = button.dataset.productId || "";
  const available = button.dataset.dd008dSetAvailability === "true";
  const expectedUpdatedAt = button.dataset.updatedAt || null;
  if (!productId || state.saving) return;
  state.saving = true;
  state.message = `Đang cập nhật ${productId}…`;
  render();
  const result = await adminApi.setProductAvailability({
    productId,
    available,
    expectedUpdatedAt,
    idempotencyKey: commandKey("availability", productId)
  });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Availability", result);
    render();
    return;
  }
  state.message = `${productId}: ${available ? "AVAILABLE" : "UNAVAILABLE"} · server confirmed.`;
  await loadMenu({ force: true, preserveMessage: true });
}

async function createProduct() {
  const root = document.querySelector("[data-dd012-create-form]");
  if (!root || state.saving) return;
  const validation = validateProductDraft(readDraft(root, "create"));
  if (!validation.ok) {
    state.message = `Create product blocked: ${validation.reason}`;
    render();
    return;
  }
  state.saving = true;
  state.message = `Đang tạo ${validation.product.id}…`;
  render();
  const result = await adminApi.createProduct({
    ...validation.product,
    idempotencyKey: commandKey("create", validation.product.id)
  });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Create product", result);
    render();
    return;
  }
  const created = normalizeAdminProduct(result.payload?.product || validation.product);
  state.editingId = created.id;
  state.message = `${created.id}: product created in PostgreSQL.`;
  await loadMenu({ force: true, preserveMessage: true });
}

async function saveProduct(productId) {
  const current = findProduct(productId);
  const root = document.querySelector(`[data-dd012-product="${cssEscape(productId)}"]`);
  if (!current || !root || state.saving) return;
  const validation = validateProductDraft({ ...readDraft(root, "edit"), id: current.id });
  if (!validation.ok) {
    state.message = `Update blocked: ${validation.reason}`;
    render();
    return;
  }
  state.saving = true;
  state.message = `Đang lưu ${current.id}…`;
  render();
  const result = await adminApi.updateProduct({
    ...validation.product,
    expectedUpdatedAt: current.updatedAt,
    idempotencyKey: commandKey("update", current.id)
  });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Update product", result);
    render();
    return;
  }
  state.message = `${current.id}: product update server confirmed.`;
  await loadMenu({ force: true, preserveMessage: true });
}

async function loadMenu(options = {}) {
  if (config.mode !== BACKEND_MODES.SUPABASE || state.loading || (state.loaded && !options.force)) return;
  state.loading = true;
  if (!options.preserveMessage) state.message = "Đang tải menu authority…";
  render();
  const result = await adminApi.fetchMenu();
  state.loading = false;
  state.loaded = true;
  if (!result.ok) {
    state.products = [];
    state.message = resultMessage("Admin menu", result);
    render();
    return;
  }
  state.products = Array.isArray(result.payload?.products) ? result.payload.products.map(normalizeAdminProduct) : [];
  if (!options.preserveMessage) state.message = `Loaded ${state.products.length} products from PostgreSQL.`;
  render();
}

function readDraft(root, mode) {
  const attribute = mode === "create" ? "data-dd012-create" : "data-dd012-field";
  const periodAttribute = mode === "create" ? "data-dd012-create-period" : "data-dd012-edit-period";
  return {
    id: mode === "create" ? fieldValue(root, `[${attribute}="id"]`) : "",
    kind: fieldValue(root, `[${attribute}="kind"]`),
    category: fieldValue(root, `[${attribute}="category"]`),
    nameVi: fieldValue(root, `[${attribute}="nameVi"]`),
    nameEn: fieldValue(root, `[${attribute}="nameEn"]`),
    descVi: fieldValue(root, `[${attribute}="descVi"]`),
    descEn: fieldValue(root, `[${attribute}="descEn"]`),
    priceVnd: fieldValue(root, `[${attribute}="priceVnd"]`),
    stationCode: fieldValue(root, `[${attribute}="stationCode"]`),
    periods: [...root.querySelectorAll(`[${periodAttribute}]:checked`)].map((input) => input.value),
    imageUrl: fieldValue(root, `[${attribute}="imageUrl"]`),
    color: fieldValue(root, `[${attribute}="color"]`),
    art: fieldValue(root, `[${attribute}="art"]`)
  };
}

function kindOptions(selected) {
  return PRODUCT_KINDS.map((kind) => `<option value="${kind}" ${kind === selected ? "selected" : ""}>${kind}</option>`).join("");
}

function categoryOptions(selected) {
  return Object.values(PRODUCT_CATEGORIES).flat().map((category) => `<option value="${category}" ${category === selected ? "selected" : ""}>${category}</option>`).join("");
}

function periodCheckboxes(selectedPeriods, attribute) {
  const selected = new Set(selectedPeriods || []);
  return PRODUCT_PERIODS.map((period) => `<label><input type="checkbox" ${attribute} value="${period}" ${selected.has(period) ? "checked" : ""} /> ${period}</label>`).join("");
}

function findProduct(productId) {
  return state.products.find((product) => product.id === productId) || null;
}

function fieldValue(root, selector) {
  return root?.querySelector(selector)?.value?.trim?.() || "";
}

function commandKey(action, identity) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dd012:${action}:${safeText(identity)}:${random}`;
}

function resultMessage(label, result) {
  return `${label} failed: ${safeText(result.category)}: ${safeText(result.reason)}${result.correlationId ? ` · ${safeText(result.correlationId)}` : ""}`;
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? `${amount.toLocaleString("vi-VN")} đ` : "0 đ";
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
