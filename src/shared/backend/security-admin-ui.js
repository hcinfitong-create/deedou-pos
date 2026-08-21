import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createSupabasePasswordAuthApi, STAFF_LOCATION_KEY, WORKSTATION_MODE_KEY } from "../auth/index.js";
import { createSecurityAdminApi } from "./security-admin.js";

const config = getBackendConfig();
const authApi = createSupabasePasswordAuthApi({ config, storage: localStorage, deviceStorage: localStorage });
const securityApi = createSecurityAdminApi({ config, authApi, storage: localStorage });
const state = {
  loading: false,
  message: "",
  mfa: null,
  enrollment: null,
  staff: [],
  roles: [],
  devices: [],
  oneTimeCredential: ""
};

const root = document.getElementById("app");
if (root && "MutationObserver" in window) {
  new MutationObserver(() => queueMicrotask(render)).observe(root, { childList: true, subtree: true });
}
window.addEventListener("hashchange", () => queueMicrotask(render));
document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
queueMicrotask(render);

function isAdminRoute() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] === "admin";
}

function render() {
  const existing = document.querySelector("[data-dd011-security-admin]");
  if (!isAdminRoute()) {
    existing?.remove();
    return;
  }
  if (config.mode !== BACKEND_MODES.SUPABASE) return;
  const page = document.querySelector("#app .admin-page") || document.querySelector("#app .page");
  if (!page || page.querySelector("[data-auth-login]")) {
    existing?.remove();
    return;
  }
  const panel = existing || document.createElement("section");
  panel.dataset.dd011SecurityAdmin = "";
  panel.className = "panel section-pad dd011-security-admin";
  if (!existing) page.appendChild(panel);
  panel.innerHTML = `
    <div class="order-head">
      <div>
        <div class="kicker">DD-011 SECURITY</div>
        <h2>Identity, MFA & devices</h2>
        <p class="muted">Role và thiết bị được kiểm server-side. Thao tác nhạy cảm yêu cầu AAL2 (TOTP MFA).</p>
      </div>
      <button class="ghost" data-dd011-refresh ${state.loading ? "disabled" : ""}>Refresh security</button>
    </div>
    ${state.message ? `<p class="notice">${esc(state.message)}</p>` : ""}
    ${renderMfa()}
    ${renderStaff()}
    ${renderDevices()}
  `;
}

function renderMfa() {
  const level = state.mfa?.currentLevel || "unknown";
  const next = state.mfa?.nextLevel || "unknown";
  const factors = state.mfa?.totp || [];
  const verified = factors.filter((factor) => factor.status === "verified");
  return `
    <div class="dd011-block">
      <div class="order-head">
        <div><strong>MFA / Authenticator</strong><div class="muted">Current AAL: ${esc(level)} · Next: ${esc(next)}</div></div>
        <span class="station">${level === "aal2" ? "AAL2 VERIFIED" : "AAL1"}</span>
      </div>
      ${state.enrollment ? `
        <div class="dd011-mfa-enroll">
          <p><strong>Scan QR bằng Google Authenticator / Microsoft Authenticator / 1Password.</strong></p>
          ${state.enrollment.qrCode ? `<img class="dd011-mfa-qr" alt="TOTP enrollment QR" src="${attr(state.enrollment.qrCode)}" />` : ""}
          <p class="muted">Secret dự phòng: <code>${esc(state.enrollment.secret)}</code></p>
          <form data-dd011-mfa-verify>
            <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" required />
            <button class="primary" type="submit">Verify & enable MFA</button>
          </form>
        </div>
      ` : level !== "aal2" && verified.length === 0 ? `
        <button class="primary" data-dd011-mfa-enroll>Enroll TOTP MFA</button>
      ` : level !== "aal2" && verified.length ? `
        <form data-dd011-mfa-challenge>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code" required />
          <button class="primary" type="submit">Verify MFA</button>
        </form>
      ` : `<p class="muted">Phiên hiện tại đã đạt AAL2. Staff/role/device mutations được phép nếu RBAC cũng cho phép.</p>`}
    </div>
  `;
}

function renderStaff() {
  const roleOptions = state.roles.map((role) => `<option value="${attr(role.role_id)}">${esc(role.role_id)}</option>`).join("");
  return `
    <div class="dd011-block">
      <div class="order-head"><div><strong>Staff & roles</strong><div class="muted">Chỉ liên kết Auth user đã tồn tại; browser không có service-role.</div></div></div>
      <form class="dd011-inline-form" data-dd011-link-staff>
        <input name="email" type="email" placeholder="staff@example.com" required />
        <input name="displayName" placeholder="Display name" required />
        <button class="primary" type="submit">Link staff</button>
      </form>
      <div class="dd011-grid">
        ${state.staff.length ? state.staff.map((staff) => `
          <article class="dd011-card">
            <div><strong>${esc(staff.display_name || staff.staff_profile_id)}</strong></div>
            <div class="muted">${esc(staff.email)} · ${esc(staff.staff_profile_id)}</div>
            <div class="auth-context">${(staff.roles || []).map((role) => `<span class="station">${esc(role)}</span>`).join("") || `<span class="station">NO ROLE</span>`}</div>
            <div class="dd011-actions">
              <form data-dd011-assign-role data-staff-id="${attr(staff.staff_profile_id)}">
                <select name="roleId">${roleOptions}</select>
                <button class="ghost" type="submit">Assign role</button>
              </form>
              ${(staff.roles || []).map((role) => `<button class="ghost compact" data-dd011-revoke-role data-staff-id="${attr(staff.staff_profile_id)}" data-role-id="${attr(role)}">Revoke ${esc(role)}</button>`).join("")}
              <button class="ghost compact" data-dd011-toggle-staff data-staff-id="${attr(staff.staff_profile_id)}" data-next-active="${staff.staff_active ? "false" : "true"}">${staff.staff_active ? "Deactivate staff" : "Activate staff"}</button>
              <button class="ghost compact" data-dd011-toggle-location data-staff-id="${attr(staff.staff_profile_id)}" data-next-active="${staff.location_active ? "false" : "true"}">${staff.location_active ? "Remove location" : "Restore location"}</button>
            </div>
          </article>
        `).join("") : `<p class="muted">No staff rows loaded.</p>`}
      </div>
    </div>
  `;
}

function renderDevices() {
  return `
    <div class="dd011-block">
      <div class="order-head"><div><strong>Registered workstations</strong><div class="muted">Credential chỉ hiển thị một lần khi register/rotate.</div></div></div>
      <form class="dd011-inline-form" data-dd011-register-device>
        <input name="label" placeholder="e.g. Cashier iPad 1" required />
        <select name="mode">
          <option>CASHIER</option><option>STAFF</option><option>KDS_KITCHEN</option><option>KDS_BAR</option><option>KDS_DESSERT</option><option>ADMIN</option>
        </select>
        <button class="primary" type="submit">Register device</button>
      </form>
      ${state.oneTimeCredential ? `<div class="notice"><strong>One-time workstation credential</strong><br><code>${esc(state.oneTimeCredential)}</code><br><span class="muted">Nhập credential này tại màn Activate workstation trên thiết bị đích. Sau khi rời trang, server không thể đọc lại plaintext.</span></div>` : ""}
      <div class="dd011-grid">
        ${state.devices.length ? state.devices.map((device) => `
          <article class="dd011-card">
            <div><strong>${esc(device.label)}</strong> ${device.is_current_device ? `<span class="station">CURRENT</span>` : ""}</div>
            <div class="muted">${esc(device.device_id)} · ${esc(device.mode)} · ${device.active ? "ACTIVE" : "REVOKED"}</div>
            <div class="muted">Last seen: ${esc(device.last_seen_at || "never")} · Uses: ${esc(device.use_count ?? 0)}</div>
            <div class="dd011-actions">
              <button class="ghost compact" data-dd011-rotate-device data-device-id="${attr(device.device_id)}" data-current="${device.is_current_device ? "true" : "false"}">Rotate credential</button>
              ${device.active && !device.is_current_device ? `<button class="ghost compact" data-dd011-revoke-device data-device-id="${attr(device.device_id)}">Revoke</button>` : ""}
            </div>
          </article>
        `).join("") : `<p class="muted">No devices loaded.</p>`}
      </div>
    </div>
  `;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  render();
  try {
    const [mfa, staff, roles, devices] = await Promise.all([
      securityApi.getMfaState(), securityApi.listStaff(), securityApi.listRoles(), securityApi.listDevices()
    ]);
    state.mfa = mfa.ok ? mfa : null;
    state.staff = staff.ok ? staff.rows : [];
    state.roles = roles.ok ? roles.rows : [];
    state.devices = devices.ok ? devices.rows : [];
    state.message = [mfa, staff, roles, devices].find((item) => item?.ok === false)?.reason || "Security context loaded from Supabase.";
    await securityApi.touchCurrentDevice();
  } catch (error) {
    state.message = `Security refresh failed: ${text(error?.message)}`;
  } finally {
    state.loading = false;
    render();
  }
}

async function handleClick(event) {
  if (!isAdminRoute()) return;
  if (event.target.closest("[data-dd011-refresh]")) return refresh();
  if (event.target.closest("[data-dd011-mfa-enroll]")) {
    const result = await securityApi.enrollTotp("DeeDou privileged operator");
    state.enrollment = result.ok ? result : null;
    state.message = result.ok ? "Scan QR rồi nhập mã để hoàn tất MFA." : `MFA enroll failed: ${result.reason}`;
    render();
    return;
  }
  const revokeRole = event.target.closest("[data-dd011-revoke-role]");
  if (revokeRole) return runMutation(() => securityApi.revokeRole({ staffProfileId: revokeRole.dataset.staffId, roleId: revokeRole.dataset.roleId }));
  const toggleStaff = event.target.closest("[data-dd011-toggle-staff]");
  if (toggleStaff) return runMutation(() => securityApi.setStaffActive({ staffProfileId: toggleStaff.dataset.staffId, active: toggleStaff.dataset.nextActive === "true" }));
  const toggleLocation = event.target.closest("[data-dd011-toggle-location]");
  if (toggleLocation) return runMutation(() => securityApi.setLocationActive({ staffProfileId: toggleLocation.dataset.staffId, active: toggleLocation.dataset.nextActive === "true" }));
  const rotate = event.target.closest("[data-dd011-rotate-device]");
  if (rotate) {
    const current = rotate.dataset.current === "true";
    const result = await securityApi.rotateDevice({ deviceId: rotate.dataset.deviceId, currentDevice: current });
    if (result.ok) {
      state.oneTimeCredential = current ? "" : result.deviceCredential;
      state.message = current ? "Current device credential rotated and browser updated." : "Device credential rotated. Transfer the one-time credential to the target device.";
      await refresh();
    } else {
      state.message = result.reason;
      render();
    }
    return;
  }
  const revoke = event.target.closest("[data-dd011-revoke-device]");
  if (revoke) return runMutation(() => securityApi.revokeDevice({ deviceId: revoke.dataset.deviceId }));
}

async function handleSubmit(event) {
  if (!isAdminRoute()) return;
  const form = event.target;
  if (form.matches("[data-dd011-mfa-verify]")) {
    event.preventDefault();
    const result = await securityApi.challengeAndVerifyTotp({ factorId: state.enrollment?.factorId, code: new FormData(form).get("code") });
    state.message = result.ok ? "MFA enabled. Session is now AAL2." : `MFA verify failed: ${result.reason}`;
    if (result.ok) state.enrollment = null;
    await refresh();
    return;
  }
  if (form.matches("[data-dd011-mfa-challenge]")) {
    event.preventDefault();
    const verified = (state.mfa?.totp || []).find((factor) => factor.status === "verified");
    const result = await securityApi.challengeAndVerifyTotp({ factorId: verified?.id, code: new FormData(form).get("code") });
    state.message = result.ok ? "MFA verified. Session is AAL2." : `MFA challenge failed: ${result.reason}`;
    await refresh();
    return;
  }
  if (form.matches("[data-dd011-link-staff]")) {
    event.preventDefault();
    const data = new FormData(form);
    return runMutation(() => securityApi.linkStaffByEmail({ email: data.get("email"), displayName: data.get("displayName") }));
  }
  if (form.matches("[data-dd011-assign-role]")) {
    event.preventDefault();
    const data = new FormData(form);
    return runMutation(() => securityApi.assignRole({ staffProfileId: form.dataset.staffId, roleId: data.get("roleId") }));
  }
  if (form.matches("[data-dd011-register-device]")) {
    event.preventDefault();
    const data = new FormData(form);
    const result = await securityApi.registerDevice({ label: data.get("label"), mode: data.get("mode") });
    if (result.ok) {
      state.oneTimeCredential = result.deviceCredential;
      state.message = "Device registered. Credential is shown once below.";
      await refresh();
    } else {
      state.message = result.reason;
      render();
    }
  }
}

async function runMutation(operation) {
  const result = await operation();
  state.message = result.ok ? "Server confirmed security mutation." : result.reason === "MFA_REQUIRED" ? "MFA_REQUIRED: verify TOTP to reach AAL2 before this operation." : `Mutation denied: ${result.reason}`;
  if (result.ok) await refresh(); else render();
}

function text(value) { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function esc(value) { return text(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function attr(value) { return esc(value).replace(/`/g, "&#96;"); }
