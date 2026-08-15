import { BACKEND_MODES, createAdminBackendApi, getBackendConfig } from "./index.js";
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
  products: [],
  message: ""
};

window.addEventListener("hashchange", () => queueMicrotask(render));
document.addEventListener("click", handleClick);

const appRoot = document.getElementById("app");
if (appRoot && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(render)).observe(appRoot, { childList: true, subtree: true });
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
        <h2>Product availability</h2>
        <p class="muted">Availability được đọc/ghi trực tiếp PostgreSQL qua menu.manage; không persist business state vào localStorage.</p>
      </div>
      <button class="ghost" data-dd008d-admin-refresh ${config.mode === BACKEND_MODES.SUPABASE && !state.loading ? "" : "disabled"}>Refresh</button>
    </div>
    ${state.message ? `<p class="notice" data-dd008d-admin-message>${escapeHtml(state.message)}</p>` : ""}
    ${config.mode !== BACKEND_MODES.SUPABASE ? `<p class="muted">LOCAL_DEMO giữ hành vi demo; production availability command chỉ bật ở SUPABASE.</p>` : ""}
    ${state.products.length ? `
      <div class="dd008d-admin-products">
        ${state.products.map(renderProduct).join("")}
      </div>
    ` : config.mode === BACKEND_MODES.SUPABASE ? `<p class="muted">${state.loading ? "Đang tải menu authority…" : "Nhấn Refresh để tải menu authority."}</p>` : ""}
  `;
}

function renderProduct(product) {
  const available = product.available === true;
  return `
    <article class="dd008d-admin-product" data-dd008d-admin-product="${escapeAttr(product.id)}" data-available="${available}">
      <div>
        <strong>${escapeHtml(product.nameVi || product.nameEn || product.id)}</strong>
        <small>${escapeHtml(product.id)} · ${formatMoney(product.priceVnd)}</small>
      </div>
      <div class="dd008d-admin-product-actions">
        <span class="station">${available ? "AVAILABLE" : "UNAVAILABLE"}</span>
        <button class="${available ? "ghost" : "primary"} compact"
                data-dd008d-set-availability="${available ? "false" : "true"}"
                data-product-id="${escapeAttr(product.id)}"
                data-updated-at="${escapeAttr(product.updatedAt || "")}">
          ${available ? "Set unavailable" : "Set available"}
        </button>
      </div>
    </article>
  `;
}

async function handleClick(event) {
  const refresh = event.target.closest("[data-dd008d-admin-refresh]");
  if (refresh) {
    await loadMenu();
    return;
  }
  const button = event.target.closest("[data-dd008d-set-availability]");
  if (!button) return;
  const productId = button.dataset.productId || "";
  const available = button.dataset.dd008dSetAvailability === "true";
  const expectedUpdatedAt = button.dataset.updatedAt || null;
  if (!productId) return;
  button.disabled = true;
  state.message = `Đang cập nhật ${productId}…`;
  render();
  const result = await adminApi.setProductAvailability({
    productId,
    available,
    expectedUpdatedAt,
    idempotencyKey: availabilityKey(productId, available, expectedUpdatedAt)
  });
  if (!result.ok) {
    state.message = `Availability failed: ${safeText(result.category)}: ${safeText(result.reason)}${result.correlationId ? ` · ${safeText(result.correlationId)}` : ""}`;
    render();
    return;
  }
  state.message = `${productId}: ${available ? "AVAILABLE" : "UNAVAILABLE"} · server confirmed${result.correlationId ? ` · ${safeText(result.correlationId)}` : ""}`;
  await loadMenu({ preserveMessage: true });
}

async function loadMenu(options = {}) {
  if (config.mode !== BACKEND_MODES.SUPABASE || state.loading) return;
  state.loading = true;
  if (!options.preserveMessage) state.message = "Đang tải menu authority…";
  render();
  const result = await adminApi.fetchMenu();
  state.loading = false;
  if (!result.ok) {
    state.products = [];
    state.message = `Admin menu failed: ${safeText(result.category)}: ${safeText(result.reason)}${result.correlationId ? ` · ${safeText(result.correlationId)}` : ""}`;
    render();
    return;
  }
  state.products = Array.isArray(result.payload?.products) ? result.payload.products.map(normalizeProduct) : [];
  if (!options.preserveMessage) state.message = `Loaded ${state.products.length} products from PostgreSQL.`;
  render();
}

function normalizeProduct(value = {}) {
  return {
    id: safeText(value.id),
    nameVi: safeText(value.nameVi || value.name_vi),
    nameEn: safeText(value.nameEn || value.name_en),
    priceVnd: Number(value.priceVnd ?? value.price_vnd ?? 0),
    available: value.available === true,
    updatedAt: safeText(value.updatedAt || value.updated_at)
  };
}

function availabilityKey(productId, available, expectedUpdatedAt) {
  const stamp = safeText(expectedUpdatedAt).replace(/[^A-Za-z0-9]+/g, "-").slice(0, 80) || "none";
  return `admin-availability:${safeText(productId)}:${available ? "1" : "0"}:${stamp}`;
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? `${amount.toLocaleString("vi-VN")} đ` : "0 đ";
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
