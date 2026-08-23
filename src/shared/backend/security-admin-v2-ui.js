import { createSecurityV2Api } from "./security-v2-api.js";

const api = createSecurityV2Api();
const state = { loading: false, isOwner: null, snapshot: null, message: "" };
let scheduled = false;

const root = document.getElementById("app");
if (root && "MutationObserver" in window) {
  new MutationObserver((mutations) => {
    const hasExternalMutation = mutations.some(({ target }) => !target.closest?.("[data-dd011b-security-admin]"));
    if (hasExternalMutation) schedule();
  }).observe(root, { childList: true, subtree: true });
}
window.addEventListener("hashchange", schedule);
document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
schedule();

function isAdminRoute() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] === "admin";
}

function resetOwnerState() {
  state.isOwner = null;
  state.snapshot = null;
  state.message = "";
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    ensure();
  });
}

function ensure() {
  const existing = document.querySelector("[data-dd011b-security-admin]");
  if (!isAdminRoute()) {
    existing?.remove();
    resetOwnerState();
    return;
  }
  const page = document.querySelector("#app .admin-page") || document.querySelector("#app .page");
  if (!page || page.querySelector("[data-auth-login]")) {
    existing?.remove();
    resetOwnerState();
    return;
  }
  if (state.isOwner === false) {
    existing?.remove();
    return;
  }
  let panel = existing;
  if (!panel) {
    panel = document.createElement("section");
    panel.dataset.dd011bSecurityAdmin = "";
    panel.className = "panel section-pad dd011-security-admin";
    page.appendChild(panel);
    refresh();
  }
  render(panel);
}

function render(panel) {
  const snapshot = state.snapshot;
  if (!snapshot?.ok) {
    panel.innerHTML = `
      <div class="order-head"><div><div class="kicker">DD-011B SECURITY</div><h2>Owner Security</h2></div><button class="ghost" data-dd011b-admin-refresh>Refresh</button></div>
      <p class="muted">${esc(state.message || "Loading Owner security context…")}</p>
    `;
    return;
  }
  const roles = Array.isArray(snapshot.roles) ? snapshot.roles : [];
  const roleOptions = roles.map((role) => `<option value="${attr(role.roleId)}">${esc(role.roleId)} · ${esc(role.roleName)}</option>`).join("");
  const staff = Array.isArray(snapshot.staff) ? snapshot.staff : [];
  const pending = Array.isArray(snapshot.pendingActivations) ? snapshot.pendingActivations : [];
  const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];

  panel.innerHTML = `
    <div class="order-head">
      <div>
        <div class="kicker">DD-011B · SOLE OWNER</div>
        <h2>Staff & Device Activation</h2>
        <p class="muted">Tạo tài khoản, cấp role, đối chiếu first-login code và revoke access từ backend. Security mutations yêu cầu Owner AAL2.</p>
      </div>
      <button class="ghost" data-dd011b-admin-refresh ${state.loading ? "disabled" : ""}>Refresh</button>
    </div>
    ${state.message ? `<p class="notice">${esc(state.message)}</p>` : ""}

    <div class="dd011-block">
      <div class="order-head"><div><strong>Create staff account</strong><div class="muted">Name là tên hiển thị; username là định danh đăng nhập duy nhất.</div></div></div>
      <form class="dd011-inline-form" data-dd011b-create-staff>
        <input name="displayName" placeholder="Nguyễn Minh Hiếu" required />
        <input name="username" placeholder="hieustaff1" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,31}" autocomplete="off" required />
        <input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="Temporary password" required />
        <select name="roleId" required>${roleOptions}</select>
        <button class="primary" type="submit">Create pending staff</button>
      </form>
      <p class="muted">Location: ${esc(snapshot.locationId)} · tài khoản chưa có quyền vận hành cho tới khi Owner approve first login.</p>
    </div>

    <div class="dd011-block">
      <div class="order-head"><div><strong>Pending activations</strong><div class="muted">Đối chiếu code trên máy nhân viên trước khi nhấn Activate.</div></div><span class="station">${pending.length}</span></div>
      <div class="dd011-grid">
        ${pending.length ? pending.map((item) => `
          <article class="dd011-card">
            <div><strong>${esc(item.displayName)}</strong> · @${esc(item.username)}</div>
            <div class="muted">${esc(item.roleId)} · ${esc(item.workstationMode)} · ${esc(item.deviceLabel)}</div>
            <div class="notice"><strong class="dd011b-code">${esc(formatCode(item.verificationCode))}</strong></div>
            <div class="muted">${esc(item.activationKind)} · expires ${esc(timeLabel(item.expiresAt))}</div>
            <div class="dd011-actions">
              <button class="primary compact" data-dd011b-approve data-request-id="${attr(item.requestId)}">Activate</button>
              <button class="ghost compact" data-dd011b-reject data-request-id="${attr(item.requestId)}">Reject</button>
            </div>
          </article>
        `).join("") : `<p class="muted">Không có activation request đang chờ.</p>`}
      </div>
    </div>

    <div class="dd011-block">
      <div class="order-head"><div><strong>Staff accounts</strong><div class="muted">Disable staff sẽ chặn toàn bộ thiết bị của tài khoản đó ngay ở request tiếp theo.</div></div></div>
      <div class="dd011-grid">
        ${staff.map((item) => renderStaff(item, roleOptions)).join("") || `<p class="muted">No staff.</p>`}
      </div>
    </div>

    <div class="dd011-block">
      <div class="order-head"><div><strong>Backend-managed devices</strong><div class="muted">Browser không nhìn thấy device secret; revoke làm session backend mất hiệu lực.</div></div></div>
      <div class="dd011-grid">
        ${devices.map((device) => `
          <article class="dd011-card">
            <div><strong>${esc(device.label)}</strong></div>
            <div class="muted">${esc(device.deviceId)} · ${esc(device.mode)} · ${device.active ? "ACTIVE" : "REVOKED"}</div>
            <div class="muted">Last seen: ${esc(device.lastSeenAt || "never")} · Uses: ${esc(device.useCount ?? 0)}</div>
            ${device.active ? `<button class="ghost compact" data-dd011b-revoke-device data-device-id="${attr(device.deviceId)}">Revoke device</button>` : ""}
          </article>
        `).join("") || `<p class="muted">No devices.</p>`}
      </div>
    </div>
  `;
}

function renderStaff(item, roleOptions) {
  const isOwner = Array.isArray(item.roles) && item.roles.includes("OWNER");
  return `
    <article class="dd011-card">
      <div><strong>${esc(item.displayName || item.staffProfileId)}</strong>${item.username ? ` · @${esc(item.username)}` : ""}</div>
      <div class="muted">${esc(item.provisioningStatus)} · staff ${item.active ? "ACTIVE" : "INACTIVE"} · location ${item.locationActive ? "ACTIVE" : "INACTIVE"}</div>
      <div class="auth-context">${(item.roles || []).map((role) => `<span class="station">${esc(role)}</span>`).join("") || `<span class="station">NO ACTIVE ROLE</span>`}</div>
      ${isOwner ? `<p class="muted">SOLE OWNER · protected from revoke/deactivate.</p>` : `
        <div class="dd011-actions">
          <form data-dd011b-assign-role data-staff-id="${attr(item.staffProfileId)}">
            <select name="roleId">${roleOptions}</select>
            <button class="ghost compact" type="submit">Assign role</button>
          </form>
          ${(item.roles || []).map((role) => `<button class="ghost compact" data-dd011b-revoke-role data-staff-id="${attr(item.staffProfileId)}" data-role-id="${attr(role)}">Revoke ${esc(role)}</button>`).join("")}
          <button class="ghost compact" data-dd011b-toggle-staff data-staff-id="${attr(item.staffProfileId)}" data-active="${item.active ? "false" : "true"}">${item.active ? "Disable account" : "Enable account"}</button>
          <button class="ghost compact" data-dd011b-toggle-location data-staff-id="${attr(item.staffProfileId)}" data-active="${item.locationActive ? "false" : "true"}">${item.locationActive ? "Disable location" : "Enable location"}</button>
        </div>
      `}
    </article>
  `;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  schedule();
  try {
    const status = await api.status();
    if (!status.ok) {
      state.isOwner = null;
      state.snapshot = null;
      state.message = status.reason;
      return;
    }

    state.isOwner = status.isOwner === true;
    if (!state.isOwner) {
      state.snapshot = null;
      state.message = "";
      return;
    }

    const result = await api.securitySnapshot();
    state.snapshot = result.ok ? result : null;
    state.message = result.ok ? "Security state loaded from backend." : result.reason;
  } finally {
    state.loading = false;
    schedule();
  }
}

async function run(operation, successMessage = "Security mutation confirmed.") {
  const result = await operation();
  state.message = result.ok ? successMessage : `Denied: ${result.reason}`;
  if (result.ok) await refresh(); else schedule();
}

async function handleClick(event) {
  if (!isAdminRoute()) return;
  if (event.target.closest("[data-dd011b-admin-refresh]")) return refresh();
  const approve = event.target.closest("[data-dd011b-approve]");
  if (approve) return run(() => api.approveActivation(approve.dataset.requestId), "Activation approved. Nhân viên sẽ được trust khi browser poll lại.");
  const reject = event.target.closest("[data-dd011b-reject]");
  if (reject) return run(() => api.rejectActivation(reject.dataset.requestId), "Activation rejected.");
  const toggleStaff = event.target.closest("[data-dd011b-toggle-staff]");
  if (toggleStaff) return run(() => api.setStaffActive(toggleStaff.dataset.staffId, toggleStaff.dataset.active === "true"));
  const toggleLocation = event.target.closest("[data-dd011b-toggle-location]");
  if (toggleLocation) return run(() => api.setLocationActive(toggleLocation.dataset.staffId, toggleLocation.dataset.active === "true"));
  const revokeRole = event.target.closest("[data-dd011b-revoke-role]");
  if (revokeRole) return run(() => api.revokeRole(revokeRole.dataset.staffId, revokeRole.dataset.roleId));
  const revokeDevice = event.target.closest("[data-dd011b-revoke-device]");
  if (revokeDevice) return run(() => api.revokeDevice(revokeDevice.dataset.deviceId));
}

async function handleSubmit(event) {
  if (!isAdminRoute()) return;
  const form = event.target;
  if (form.matches?.("[data-dd011b-create-staff]")) {
    event.preventDefault();
    const data = new FormData(form);
    const result = await api.createStaff({
      displayName: data.get("displayName"),
      username: data.get("username"),
      password: data.get("password"),
      roleId: data.get("roleId"),
      locationId: state.snapshot?.locationId
    });
    state.message = result.ok ? `Created @${result.username} as PENDING_FIRST_LOGIN.` : `Create denied: ${result.reason}`;
    if (result.ok) form.reset();
    await refresh();
    return;
  }
  if (form.matches?.("[data-dd011b-assign-role]")) {
    event.preventDefault();
    const roleId = new FormData(form).get("roleId");
    return run(() => api.assignRole(form.dataset.staffId, roleId));
  }
}

function formatCode(value) {
  const code = String(value || "").replace(/\D/g, "").slice(0, 6);
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
function timeLabel(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]); }
function attr(value) { return esc(value).replace(/`/g, "&#96;"); }
