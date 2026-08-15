import {
  BACKEND_MODES,
  OPERATIONAL_STATE_EVENT,
  buildLegacyExport,
  createLegacyMigrationApi,
  getBackendConfig,
  previewLegacyExport,
  serializeLegacyExport
} from "./index.js";
import {
  DEFAULT_LOCATION_ID,
  STAFF_LOCATION_KEY,
  WORKSTATION_MODE_KEY,
  createSupabasePasswordAuthApi
} from "../auth/index.js";
import { PRODUCT_KEY, STATE_KEY } from "../config/index.js";

const STAFF_ROUTES = new Set(["staff", "cashier", "bar", "kitchen", "dessert", "admin"]);
const config = getBackendConfig();
let operationalState = null;
let migrationState = {
  bundle: null,
  serializedBundle: "",
  importKey: "",
  serverPreviewSignature: "",
  localPreview: null,
  serverResult: null,
  message: ""
};

const authApi = createSupabasePasswordAuthApi({ config, storage: localStorage, deviceStorage: localStorage });
const migrationApi = createLegacyMigrationApi({
  config,
  authApi,
  deviceStorage: localStorage,
  authStateRef: () => ({
    locationId: localStorage.getItem(STAFF_LOCATION_KEY) || DEFAULT_LOCATION_ID,
    workstationMode: localStorage.getItem(WORKSTATION_MODE_KEY) || "ADMIN",
    authorization: { workstationMode: "ADMIN" }
  })
});

window.addEventListener(OPERATIONAL_STATE_EVENT, (event) => {
  operationalState = event.detail || null;
  renderRuntimeUi();
});
window.addEventListener("hashchange", () => queueMicrotask(renderRuntimeUi));
window.addEventListener("storage", () => queueMicrotask(renderRuntimeUi));

document.addEventListener("click", handleClick);
document.addEventListener("input", handleInput);

const appRoot = document.getElementById("app");
if (appRoot && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(renderRuntimeUi)).observe(appRoot, { childList: true, subtree: true });
}
queueMicrotask(renderRuntimeUi);

function routeName() {
  const hash = location.hash.replace(/^#\/?/, "");
  const first = hash.split("/").filter(Boolean)[0] || "t";
  return STAFF_ROUTES.has(first) ? first : "customer";
}

function renderRuntimeUi() {
  renderConnectivityBadge();
  renderAdminMigrationPanel();
}

function renderConnectivityBadge() {
  let badge = document.querySelector("[data-dd008d-connectivity]");
  const route = routeName();
  if (!STAFF_ROUTES.has(route)) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("aside");
    badge.dataset.dd008dConnectivity = "";
    document.body.appendChild(badge);
  }

  const state = config.mode === BACKEND_MODES.SUPABASE
    ? operationalState?.state || "RECONNECTING"
    : "LOCAL_DEMO";
  const failure = safeText(operationalState?.lastCommandFailureCode);
  const refreshed = formatTime(operationalState?.lastAuthoritativeRefreshAt);
  const correlation = safeText(operationalState?.lastCorrelationId);
  badge.dataset.state = state;
  badge.className = `dd008d-connectivity dd008d-state-${state.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  badge.innerHTML = `
    <div class="dd008d-connectivity-row">
      <strong>${escapeHtml(connectionLabel(state))}</strong>
      <span>${escapeHtml(config.mode)}</span>
    </div>
    ${refreshed ? `<small>Server refresh: ${escapeHtml(refreshed)}</small>` : ""}
    ${failure ? `<small>Last failure: ${escapeHtml(failure)}</small>` : ""}
    ${correlation ? `<small>Correlation: ${escapeHtml(correlation)}</small>` : ""}
  `;
}

function renderAdminMigrationPanel() {
  const existing = document.querySelector("[data-dd008d-migration-panel]");
  if (routeName() !== "admin") {
    existing?.remove();
    return;
  }
  const adminPage = document.querySelector("#app .admin-page") || document.querySelector("#app .page");
  if (!adminPage) return;
  const panel = existing || document.createElement("section");
  panel.dataset.dd008dMigrationPanel = "";
  panel.className = "panel section-pad dd008d-migration-panel";
  if (!existing) adminPage.appendChild(panel);

  const preview = migrationState.localPreview;
  const counts = preview?.counts || {};
  const malformedCount = Array.isArray(preview?.malformed) ? preview.malformed.length : 0;
  const importUnlocked = Boolean(
    migrationState.bundle
      && migrationState.importKey
      && migrationState.serverPreviewSignature === migrationSignature(migrationState.serializedBundle, migrationState.importKey)
      && migrationState.serverResult?.ok === true
  );
  panel.innerHTML = `
    <div class="order-head">
      <div>
        <div class="kicker">DD-008D CUTOVER</div>
        <h2>Legacy migration & production readiness</h2>
        <p class="muted">Không tự upload localStorage. Luồng bắt buộc: export/preview → server preview → operator review → import.</p>
      </div>
      <span class="station">${escapeHtml(config.mode)}</span>
    </div>
    <div class="dd008d-migration-grid">
      <div class="dd008d-migration-step">
        <strong>1. Legacy export</strong>
        <p class="muted">Đọc bản local hiện có trên trình duyệt này. Không gửi network.</p>
        <button class="ghost" data-dd008d-build-export>Tạo local export</button>
        <button class="ghost" data-dd008d-download-export ${migrationState.bundle ? "" : "disabled"}>Tải JSON</button>
      </div>
      <div class="dd008d-migration-step">
        <strong>2. Preview</strong>
        <label>Import key
          <input data-dd008d-import-key value="${escapeAttr(migrationState.importKey)}" placeholder="cutover-2026-08-16-01" />
        </label>
        <button class="ghost" data-dd008d-server-preview ${migrationState.bundle && migrationState.importKey && config.mode === BACKEND_MODES.SUPABASE ? "" : "disabled"}>Server preview</button>
      </div>
      <div class="dd008d-migration-step">
        <strong>3. Import</strong>
        <p class="muted">Server giữ nguyên authoritative record đã tồn tại; conflict sẽ skip/report.</p>
        <button class="primary" data-dd008d-import ${importUnlocked ? "" : "disabled"}>Import previewed payload</button>
      </div>
      <div class="dd008d-migration-step">
        <strong>4. Readiness</strong>
        <button class="ghost" data-dd008d-readiness ${config.mode === BACKEND_MODES.SUPABASE ? "" : "disabled"}>Kiểm tra server readiness</button>
      </div>
    </div>
    ${preview ? `
      <div class="dd008d-preview-summary" data-dd008d-local-preview>
        <strong>Local preview</strong>
        <span>sessions ${number(counts.tableSessions)}</span>
        <span>orders ${number(counts.orders)}</span>
        <span>lines ${number(counts.orderLines)}</span>
        <span>payments ${number(counts.payments)}</span>
        <span>requests ${number(counts.serviceRequests)}</span>
        <span>malformed ${malformedCount}</span>
      </div>
    ` : ""}
    ${migrationState.message ? `<pre class="dd008d-result" data-dd008d-result>${escapeHtml(migrationState.message)}</pre>` : ""}
  `;
}

async function handleClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.matches("[data-dd008d-build-export]")) {
    migrationState = buildExportState();
    renderRuntimeUi();
    return;
  }
  if (button.matches("[data-dd008d-download-export]")) {
    if (migrationState.bundle) downloadJson(migrationState.serializedBundle, `deedou-legacy-export-${Date.now()}.json`);
    return;
  }
  if (button.matches("[data-dd008d-server-preview]")) {
    await runServerPreview(button);
    return;
  }
  if (button.matches("[data-dd008d-import]")) {
    await runImport(button);
    return;
  }
  if (button.matches("[data-dd008d-readiness]")) {
    await runReadiness(button);
  }
}

function handleInput(event) {
  if (!event.target.matches("[data-dd008d-import-key]")) return;
  const next = safeText(event.target.value).slice(0, 120);
  if (migrationState.importKey === next) return;
  migrationState.importKey = next;
  migrationState.serverPreviewSignature = "";
  migrationState.serverResult = null;
  migrationState.message = "";
}

function buildExportState() {
  const locationId = localStorage.getItem(STAFF_LOCATION_KEY) || DEFAULT_LOCATION_ID;
  const legacyState = parseStorageJson(STATE_KEY, {});
  const products = parseStorageJson(PRODUCT_KEY, []);
  const bundle = buildLegacyExport({ state: legacyState, products, locationId });
  const localPreview = previewLegacyExport(bundle);
  return {
    ...migrationState,
    bundle,
    serializedBundle: serializeLegacyExport(bundle),
    serverPreviewSignature: "",
    serverResult: null,
    localPreview,
    message: localPreview.ok
      ? "Local export đã tạo. Chưa có dữ liệu nào được gửi lên server."
      : `Local preview warnings: ${localPreview.warnings.join(", ")}`
  };
}

async function runServerPreview(button) {
  if (!migrationState.bundle || !migrationState.importKey) return;
  setBusy(button, true);
  migrationState.serverPreviewSignature = "";
  migrationState.message = "Đang yêu cầu server preview…";
  renderRuntimeUi();
  const result = await migrationApi.preview({ bundle: migrationState.bundle, importKey: migrationState.importKey });
  migrationState.serverResult = result;
  if (result.ok) {
    migrationState.serverPreviewSignature = migrationSignature(migrationState.serializedBundle, migrationState.importKey);
    migrationState.message = formatResult("SERVER PREVIEW OK", result);
  } else {
    migrationState.message = formatResult("SERVER PREVIEW FAILED", result);
  }
  setBusy(button, false);
  renderRuntimeUi();
}

async function runImport(button) {
  const expected = migrationSignature(migrationState.serializedBundle, migrationState.importKey);
  if (!migrationState.bundle || migrationState.serverPreviewSignature !== expected) return;
  setBusy(button, true);
  migrationState.message = "Đang import đúng payload đã preview…";
  renderRuntimeUi();
  const result = await migrationApi.importData({ bundle: migrationState.bundle, importKey: migrationState.importKey });
  migrationState.serverResult = result;
  migrationState.message = formatResult(result.ok ? "IMPORT COMPLETE" : "IMPORT FAILED", result);
  setBusy(button, false);
  renderRuntimeUi();
}

async function runReadiness(button) {
  setBusy(button, true);
  migrationState.message = "Đang kiểm tra production readiness…";
  renderRuntimeUi();
  const result = await migrationApi.readiness();
  migrationState.message = formatResult(result.ok ? "READINESS REPORT" : "READINESS FAILED", result);
  setBusy(button, false);
  renderRuntimeUi();
}

function parseStorageJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function migrationSignature(serializedBundle, importKey) {
  return `${safeText(importKey)}:${simpleHash(serializedBundle)}`;
}

function simpleHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function formatResult(title, result = {}) {
  const safe = {
    title,
    ok: result.ok === true,
    category: safeText(result.category),
    reason: safeText(result.reason),
    entityId: safeText(result.entityId),
    correlationId: safeText(result.correlationId),
    payload: result.payload || {}
  };
  return JSON.stringify(safe, null, 2).slice(0, 12000);
}

function downloadJson(content, filename) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

function connectionLabel(state) {
  return ({
    ONLINE: "ONLINE · authoritative",
    RECONNECTING: "RECONNECTING",
    OFFLINE: "OFFLINE · read-only cache",
    DEGRADED: "DEGRADED",
    STALE: "STALE · refetch required",
    LOCAL_DEMO: "LOCAL DEMO"
  })[state] || state;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
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
