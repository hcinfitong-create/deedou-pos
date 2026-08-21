import { BACKEND_MODES, createAdminBackendApi, getBackendConfig } from "./index.js";
import {
  DEFAULT_LOCATION_ID,
  STAFF_LOCATION_KEY,
  WORKSTATION_MODE_KEY,
  createSupabasePasswordAuthApi
} from "../auth/index.js";
import {
  buildCustomerTableUrl,
  dropPositionFromPointer,
  groupAdminTablesByZone,
  layoutStyle,
  normalizeAdminTable,
  TABLE_SHAPES,
  validateTableDraft
} from "../../features/admin-tables/index.js";
import { qrSvg } from "../qr/index.js";

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
  tables: [],
  message: "",
  editingId: "",
  dragTableId: ""
};

window.addEventListener("hashchange", () => queueMicrotask(render));
document.addEventListener("click", handleClick);
document.addEventListener("dragstart", handleDragStart);
document.addEventListener("dragover", handleDragOver);
document.addEventListener("drop", handleDrop);

const appRoot = document.getElementById("app");
if (appRoot && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(render)).observe(appRoot, { childList: true });
}
queueMicrotask(render);

function isAdminRoute() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] === "admin";
}

function render() {
  const existing = document.querySelector("[data-dd010a-admin-tables]");
  if (!isAdminRoute()) {
    existing?.remove();
    return;
  }
  const adminPage = document.querySelector("#app .admin-page") || document.querySelector("#app .page");
  if (!adminPage) return;

  const panel = existing || document.createElement("section");
  panel.dataset.dd010aAdminTables = "";
  panel.className = "panel section-pad dd010a-admin-tables";
  if (!existing) adminPage.appendChild(panel);

  const zones = groupAdminTablesByZone(state.tables);
  panel.innerHTML = `
    <div class="order-head dd010a-head">
      <div>
        <div class="kicker">TABLE AUTHORITY</div>
        <h2>Tables & floor plan</h2>
        <p class="muted">Bàn, khu vực, vị trí và QR được lưu trực tiếp trong PostgreSQL. Kéo bàn trên sơ đồ để đổi vị trí.</p>
      </div>
      <button class="ghost" data-dd010a-refresh ${config.mode === BACKEND_MODES.SUPABASE && !state.loading && !state.saving ? "" : "disabled"}>Refresh</button>
    </div>
    ${state.message ? `<p class="notice" data-dd010a-message>${escapeHtml(state.message)}</p>` : ""}
    ${config.mode !== BACKEND_MODES.SUPABASE ? `<p class="muted">Table authority chỉ bật ở SUPABASE mode.</p>` : `
      ${renderCreateForm()}
      ${state.loading && !state.loaded ? `<p class="muted">Đang tải sơ đồ bàn…</p>` : ""}
      ${zones.length ? `<div class="dd010a-zones">${zones.map(renderZone).join("")}</div>` : state.loaded ? `<p class="muted">Chưa có bàn. Tạo bàn đầu tiên phía trên.</p>` : ""}
      ${state.tables.length ? `<div class="dd010a-table-list">${state.tables.map(renderTableEditor).join("")}</div>` : ""}
    `}
  `;

  if (config.mode === BACKEND_MODES.SUPABASE && !state.loaded && !state.loading) queueMicrotask(() => loadLayout());
}

function renderCreateForm() {
  return `
    <div class="dd010a-create">
      <div><strong>Add table</strong><p class="muted">QR token được server sinh tự động.</p></div>
      <label><span>Code</span><input data-dd010a-create="code" maxlength="16" placeholder="A05" /></label>
      <label><span>Zone</span><input data-dd010a-create="zone" maxlength="64" placeholder="Beach" /></label>
      <label><span>Seats</span><input data-dd010a-create="seatCount" type="number" min="1" max="50" value="4" /></label>
      <label><span>Shape</span><select data-dd010a-create="shape">${TABLE_SHAPES.map((shape) => `<option value="${shape}">${shape}</option>`).join("")}</select></label>
      <button class="primary" data-dd010a-create-table ${state.saving ? "disabled" : ""}>Create table</button>
    </div>
  `;
}

function renderZone({ zone, tables }) {
  return `
    <section class="dd010a-zone">
      <div class="order-head"><div><strong>${escapeHtml(zone)}</strong><small>${tables.length} table${tables.length === 1 ? "" : "s"}</small></div></div>
      <div class="dd010a-floor" data-dd010a-drop-zone="${escapeAttr(zone)}">
        <div class="dd010a-grid-lines" aria-hidden="true"></div>
        ${tables.map(renderFloorTable).join("")}
      </div>
    </section>
  `;
}

function renderFloorTable(raw) {
  const table = normalizeAdminTable(raw);
  const style = layoutStyle(table);
  return `
    <button type="button"
      class="dd010a-floor-table shape-${table.shape.toLowerCase()} ${table.isActive ? "" : "inactive"}"
      draggable="true"
      data-dd010a-drag-table="${escapeAttr(table.id)}"
      data-dd010a-edit-table="${escapeAttr(table.id)}"
      style="left:${style.left}%;top:${style.top}%;width:${style.width}%;height:${style.height}%">
      <strong>${escapeHtml(table.code)}</strong>
      <span>${table.seatCount} seats</span>
      ${table.hasOpenSession ? `<small>OPEN</small>` : ""}
    </button>
  `;
}

function renderTableEditor(raw) {
  const table = normalizeAdminTable(raw);
  const editing = state.editingId === table.id;
  const customerUrl = buildCustomerTableUrl(table.qrToken, location.href);
  return `
    <article class="dd010a-table-editor ${editing ? "editing" : ""}" data-dd010a-table="${escapeAttr(table.id)}">
      <div class="order-head">
        <div>
          <strong>${escapeHtml(table.code)}</strong>
          <small>${escapeHtml(table.zone)} · ${table.seatCount} seats · v${table.version}${table.hasOpenSession ? " · OPEN SESSION" : ""}</small>
        </div>
        <div class="split-actions">
          <span class="station">${table.isActive ? "ACTIVE" : "INACTIVE"}</span>
          <button class="ghost compact" data-dd010a-edit-table="${escapeAttr(table.id)}">${editing ? "Close" : "Manage"}</button>
        </div>
      </div>
      ${editing ? `
        <div class="dd010a-editor-grid">
          <label><span>Code</span><input data-dd010a-field="code" value="${escapeAttr(table.code)}" maxlength="16" ${table.hasOpenSession ? "disabled" : ""}/></label>
          <label><span>Zone</span><input data-dd010a-field="zone" value="${escapeAttr(table.zone)}" maxlength="64" ${table.hasOpenSession ? "disabled" : ""}/></label>
          <label><span>Seats</span><input data-dd010a-field="seatCount" type="number" min="1" max="50" value="${table.seatCount}" ${table.hasOpenSession ? "disabled" : ""}/></label>
          <label><span>Shape</span><select data-dd010a-field="shape" ${table.hasOpenSession ? "disabled" : ""}>${TABLE_SHAPES.map((shape) => `<option value="${shape}" ${shape === table.shape ? "selected" : ""}>${shape}</option>`).join("")}</select></label>
          <label><span>X</span><input data-dd010a-field="layoutX" type="number" min="0" max="99" value="${table.layoutX}" /></label>
          <label><span>Y</span><input data-dd010a-field="layoutY" type="number" min="0" max="99" value="${table.layoutY}" /></label>
          <label><span>Width</span><input data-dd010a-field="layoutWidth" type="number" min="1" max="12" value="${table.layoutWidth}" /></label>
          <label><span>Height</span><input data-dd010a-field="layoutHeight" type="number" min="1" max="12" value="${table.layoutHeight}" /></label>
          <label><span>Order</span><input data-dd010a-field="displayOrder" type="number" min="0" max="9999" value="${table.displayOrder}" /></label>
        </div>
        <div class="split-actions dd010a-config-actions">
          <button class="primary" data-dd010a-save-table="${escapeAttr(table.id)}" ${state.saving ? "disabled" : ""}>Save configuration</button>
          <button class="ghost" data-dd010a-toggle-active="${escapeAttr(table.id)}" data-next-active="${table.isActive ? "false" : "true"}" ${table.hasOpenSession || state.saving ? "disabled" : ""}>${table.isActive ? "Deactivate" : "Activate"}</button>
        </div>
        ${table.hasOpenSession ? `<p class="muted">Phiên bàn đang OPEN: chỉ vị trí/kích thước sơ đồ được thay đổi. Code, zone, seats, shape, deactivate và rotate QR đang khóa.</p>` : ""}
        <div class="dd010a-qr-card">
          <div class="dd010a-qr-image">${safeQrSvg(customerUrl)}</div>
          <div class="dd010a-qr-meta">
            <strong>QR · ${escapeHtml(table.code)}</strong>
            <code>${escapeHtml(customerUrl)}</code>
            <div class="split-actions">
              <button class="ghost compact" data-dd010a-copy-url="${escapeAttr(table.id)}">Copy link</button>
              <button class="ghost compact" data-dd010a-download-qr="${escapeAttr(table.id)}">Download SVG</button>
              <button class="ghost compact" data-dd010a-print-qr="${escapeAttr(table.id)}">Print QR</button>
              <button class="danger compact" data-dd010a-rotate-qr="${escapeAttr(table.id)}" ${table.hasOpenSession || state.saving ? "disabled" : ""}>Rotate QR</button>
            </div>
          </div>
        </div>
      ` : ""}
    </article>
  `;
}

async function handleClick(event) {
  const refresh = event.target.closest("[data-dd010a-refresh]");
  if (refresh) return loadLayout({ force: true });

  const create = event.target.closest("[data-dd010a-create-table]");
  if (create) return createTable();

  const edit = event.target.closest("[data-dd010a-edit-table]");
  if (edit) {
    const tableId = edit.dataset.dd010aEditTable || "";
    state.editingId = state.editingId === tableId ? "" : tableId;
    render();
    return;
  }

  const save = event.target.closest("[data-dd010a-save-table]");
  if (save) return saveTable(save.dataset.dd010aSaveTable || "");

  const active = event.target.closest("[data-dd010a-toggle-active]");
  if (active) return setActive(active.dataset.dd010aToggleActive || "", active.dataset.nextActive === "true");

  const rotate = event.target.closest("[data-dd010a-rotate-qr]");
  if (rotate) return rotateQr(rotate.dataset.dd010aRotateQr || "");

  const copy = event.target.closest("[data-dd010a-copy-url]");
  if (copy) return copyCustomerUrl(copy.dataset.dd010aCopyUrl || "");

  const download = event.target.closest("[data-dd010a-download-qr]");
  if (download) return downloadQr(download.dataset.dd010aDownloadQr || "");

  const print = event.target.closest("[data-dd010a-print-qr]");
  if (print) return printQr(print.dataset.dd010aPrintQr || "");
}

function handleDragStart(event) {
  const target = event.target.closest("[data-dd010a-drag-table]");
  if (!target) return;
  state.dragTableId = target.dataset.dd010aDragTable || "";
  event.dataTransfer?.setData("text/plain", state.dragTableId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function handleDragOver(event) {
  if (!event.target.closest("[data-dd010a-drop-zone]")) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

async function handleDrop(event) {
  const floor = event.target.closest("[data-dd010a-drop-zone]");
  if (!floor) return;
  event.preventDefault();
  const tableId = event.dataTransfer?.getData("text/plain") || state.dragTableId;
  const table = findTable(tableId);
  if (!table || state.saving) return;
  const zone = floor.dataset.dd010aDropZone || table.zone;
  const position = dropPositionFromPointer({ clientX: event.clientX, clientY: event.clientY, rect: floor.getBoundingClientRect(), table });
  await updateTable(table, { zone, ...position }, "drag");
}

async function loadLayout(options = {}) {
  if (config.mode !== BACKEND_MODES.SUPABASE || state.loading || (state.loaded && !options.force)) return;
  state.loading = true;
  state.message = "Đang tải table authority…";
  render();
  const result = await adminApi.fetchTableLayout();
  state.loading = false;
  state.loaded = true;
  if (!result.ok) {
    state.tables = [];
    state.message = resultMessage("Load table layout", result);
    render();
    return;
  }
  state.tables = (result.payload?.tables || []).map(normalizeAdminTable);
  state.message = `Loaded ${state.tables.length} tables from PostgreSQL.`;
  render();
}

async function createTable() {
  if (state.saving) return;
  const root = document.querySelector("[data-dd010a-admin-tables]");
  const draft = {
    code: fieldValue(root, "[data-dd010a-create=\"code\"]"),
    zone: fieldValue(root, "[data-dd010a-create=\"zone\"]"),
    seatCount: numberValue(root, "[data-dd010a-create=\"seatCount\"]", 4),
    shape: fieldValue(root, "[data-dd010a-create=\"shape\"]") || "RECTANGLE",
    layoutX: 2 + (state.tables.length * 13) % 70,
    layoutY: 8 + (state.tables.length * 17) % 70,
    layoutWidth: 2,
    layoutHeight: 2,
    displayOrder: state.tables.length + 1
  };
  const validation = validateTableDraft(draft);
  if (!validation.ok) {
    state.message = `Create table blocked: ${validation.errors.join(", ")}`;
    render();
    return;
  }
  state.saving = true;
  state.message = `Đang tạo bàn ${validation.table.code}…`;
  render();
  const result = await adminApi.createPhysicalTable({ ...validation.table, idempotencyKey: commandKey("create", validation.table.code) });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Create table", result);
    render();
    return;
  }
  const created = normalizeAdminTable(result.payload?.table || {});
  state.editingId = created.id;
  state.message = `${created.code} created. QR server-generated.`;
  await loadLayout({ force: true });
}

async function saveTable(tableId) {
  const table = findTable(tableId);
  const article = document.querySelector(`[data-dd010a-table="${cssEscape(tableId)}"]`);
  if (!table || !article || state.saving) return;
  const patch = {
    code: table.hasOpenSession ? table.code : fieldValue(article, "[data-dd010a-field=\"code\"]"),
    zone: table.hasOpenSession ? table.zone : fieldValue(article, "[data-dd010a-field=\"zone\"]"),
    seatCount: table.hasOpenSession ? table.seatCount : numberValue(article, "[data-dd010a-field=\"seatCount\"]", table.seatCount),
    shape: table.hasOpenSession ? table.shape : fieldValue(article, "[data-dd010a-field=\"shape\"]"),
    layoutX: numberValue(article, "[data-dd010a-field=\"layoutX\"]", table.layoutX),
    layoutY: numberValue(article, "[data-dd010a-field=\"layoutY\"]", table.layoutY),
    layoutWidth: numberValue(article, "[data-dd010a-field=\"layoutWidth\"]", table.layoutWidth),
    layoutHeight: numberValue(article, "[data-dd010a-field=\"layoutHeight\"]", table.layoutHeight),
    displayOrder: numberValue(article, "[data-dd010a-field=\"displayOrder\"]", table.displayOrder)
  };
  await updateTable(table, patch, "save");
}

async function updateTable(table, patch, reason) {
  const next = normalizeAdminTable({ ...table, ...patch });
  const validation = validateTableDraft(next);
  if (!validation.ok) {
    state.message = `Update blocked: ${validation.errors.join(", ")}`;
    render();
    return;
  }
  state.saving = true;
  state.message = `Đang lưu ${table.code}…`;
  render();
  const result = await adminApi.updatePhysicalTable({
    ...validation.table,
    tableId: table.id,
    expectedVersion: table.version,
    idempotencyKey: commandKey(`update-${reason}`, table.id)
  });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Update table", result);
    render();
    return;
  }
  state.message = `${validation.table.code}: layout/configuration server confirmed.`;
  await loadLayout({ force: true });
}

async function setActive(tableId, active) {
  const table = findTable(tableId);
  if (!table || table.hasOpenSession || state.saving) return;
  state.saving = true;
  state.message = `${active ? "Activating" : "Deactivating"} ${table.code}…`;
  render();
  const result = await adminApi.setPhysicalTableActive({
    tableId,
    active,
    expectedVersion: table.version,
    idempotencyKey: commandKey(active ? "activate" : "deactivate", table.id)
  });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Table active state", result);
    render();
    return;
  }
  state.message = `${table.code}: ${active ? "ACTIVE" : "INACTIVE"}.`;
  await loadLayout({ force: true });
}

async function rotateQr(tableId) {
  const table = findTable(tableId);
  if (!table || table.hasOpenSession || state.saving) return;
  if (!confirm(`Rotate QR for ${table.code}? QR đã in trước đây sẽ ngừng hoạt động ngay.`)) return;
  state.saving = true;
  state.message = `Rotating QR for ${table.code}…`;
  render();
  const result = await adminApi.rotatePhysicalTableQr({
    tableId,
    expectedVersion: table.version,
    idempotencyKey: commandKey("rotate-qr", table.id)
  });
  state.saving = false;
  if (!result.ok) {
    state.message = resultMessage("Rotate QR", result);
    render();
    return;
  }
  state.message = `${table.code}: QR rotated. Old QR is invalid.`;
  await loadLayout({ force: true });
}

async function copyCustomerUrl(tableId) {
  const table = findTable(tableId);
  if (!table) return;
  const url = buildCustomerTableUrl(table.qrToken, location.href);
  try {
    await navigator.clipboard.writeText(url);
    state.message = `${table.code}: customer link copied.`;
  } catch {
    state.message = `${table.code}: clipboard unavailable. Copy the URL shown in the QR panel.`;
  }
  render();
}

function downloadQr(tableId) {
  const table = findTable(tableId);
  if (!table) return;
  const url = buildCustomerTableUrl(table.qrToken, location.href);
  const svg = qrSvg(url, { scale: 8, border: 4 });
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `deedou-${safeFileName(table.code)}-qr.svg`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function printQr(tableId) {
  const table = findTable(tableId);
  if (!table) return;
  const url = buildCustomerTableUrl(table.qrToken, location.href);
  const popup = window.open("", "_blank", "noopener,noreferrer,width=520,height=680");
  if (!popup) {
    state.message = "Popup bị chặn; hãy cho phép popup để in QR.";
    render();
    return;
  }
  popup.document.write(`<!doctype html><html><head><title>DeeDou ${escapeHtml(table.code)} QR</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:32px}svg{max-width:360px;height:auto}code{display:block;overflow-wrap:anywhere;margin:18px auto;max-width:440px}</style></head><body><h1>DeeDou · ${escapeHtml(table.code)}</h1><p>${escapeHtml(table.zone)}</p>${qrSvg(url, { scale: 8, border: 4 })}<code>${escapeHtml(url)}</code><script>window.onload=()=>window.print()<\/script></body></html>`);
  popup.document.close();
}

function safeQrSvg(url) {
  try {
    return qrSvg(url, { scale: 5, border: 4 });
  } catch (error) {
    return `<p class="muted">QR render unavailable: ${escapeHtml(error?.message || "QR_ERROR")}</p>`;
  }
}

function findTable(tableId) {
  return state.tables.find((table) => table.id === tableId) || null;
}

function fieldValue(root, selector) {
  return root?.querySelector(selector)?.value?.trim?.() || "";
}

function numberValue(root, selector, fallback) {
  const value = Number(root?.querySelector(selector)?.value);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function commandKey(action, identity) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dd010a:${action}:${safeText(identity)}:${random}`;
}

function resultMessage(label, result) {
  return `${label} failed: ${safeText(result.category)}: ${safeText(result.reason)}${result.correlationId ? ` · ${safeText(result.correlationId)}` : ""}`;
}

function safeFileName(value) {
  return safeText(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "table";
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
