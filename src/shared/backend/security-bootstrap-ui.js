import { STAFF_LOCATION_KEY, WORKSTATION_MODE_KEY } from "../auth/index.js";
import { createSecurityV2Api } from "./security-v2-api.js";

const api = createSecurityV2Api();
const state = {
  loading: false,
  status: null,
  mfa: null,
  enrollment: null,
  message: ""
};
let scheduled = false;
let pollTimer = null;

const root = document.getElementById("app");
if (root && "MutationObserver" in window) {
  new MutationObserver((mutations) => {
    const hasExternalMutation = mutations.some(({ target }) => !target.closest?.("[data-dd011b-bootstrap]"));
    if (hasExternalMutation) scheduleEnsure();
  }).observe(root, { childList: true, subtree: true });
}
document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
scheduleEnsure();

function scheduleEnsure() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    ensure();
  });
}

function decorateLogin(gate) {
  const form = gate?.querySelector("[data-auth-login]");
  if (!form) return;
  const identifier = form.querySelector('[name="email"]');
  if (identifier) {
    identifier.type = "text";
    identifier.autocomplete = "username";
    identifier.placeholder = "hieustaff1 hoặc email Owner";
    const label = identifier.closest("label");
    if (label && !label.dataset.dd011bIdentifierLabel) {
      label.dataset.dd011bIdentifierLabel = "";
      for (const node of label.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          node.textContent = "\n            Username / Owner email\n            ";
          break;
        }
      }
    }
  }
  for (const name of ["locationId", "workstationMode"]) {
    const input = form.querySelector(`[name="${name}"]`);
    if (input?.closest("label")) input.closest("label").hidden = true;
  }
  const note = form.parentElement?.querySelector(".auth-note");
  const noteText = "Location, role và workstation trust được Owner cấp từ backend. Device secret không được lưu trong browser storage.";
  if (note && note.textContent !== noteText) note.textContent = noteText;
}

function ensure() {
  const gate = document.querySelector("#app .auth-gate");
  if (!gate) {
    document.querySelector("[data-dd011b-bootstrap]")?.remove();
    stopPolling();
    return;
  }
  decorateLogin(gate);
  let panel = gate.querySelector("[data-dd011b-bootstrap]");
  if (!panel) {
    panel = document.createElement("section");
    panel.dataset.dd011bBootstrap = "";
    panel.className = "dd011-device-activation";
    gate.appendChild(panel);
    refresh();
  }
  render(panel);
}

function render(panel) {
  const status = state.status;
  if (!status?.ok) {
    panel.innerHTML = state.message ? `<p class="muted">${esc(state.message)}</p>` : "";
    return;
  }
  const profile = status.profile;
  if (!profile) {
    panel.innerHTML = `<p class="muted">Tài khoản này chưa được Owner liên kết với DeeDou staff.</p>`;
    return;
  }

  if (status.device?.active) {
    panel.innerHTML = `
      <hr />
      <div class="kicker">DEVICE & STAFF ACTIVATION</div>
      <p><strong>${esc(profile.display_name || profile.username || "Staff")}</strong></p>
      <p class="muted">Thiết bị đã được backend xác nhận: ${esc(status.device.workstationMode)} · ${esc(status.device.locationId)}</p>
      <button class="primary" data-dd011b-reload>Tiếp tục vào DeeDou</button>
    `;
    return;
  }

  if (status.isOwner) {
    panel.innerHTML = renderOwnerBootstrap(profile);
    return;
  }

  if (profile.provisioning_status === "DISABLED" || profile.active === false && profile.provisioning_status === "DISABLED") {
    panel.innerHTML = `<hr /><div class="kicker">ACCOUNT DISABLED</div><p class="muted">Tài khoản đã bị Owner vô hiệu hóa.</p>`;
    return;
  }

  panel.innerHTML = renderStaffActivation(profile, status.activation);
  if (status.activation?.status === "PENDING") startPolling(); else stopPolling();
}

function renderOwnerBootstrap(profile) {
  const mfa = state.mfa;
  const verifiedFactors = (mfa?.totp || []).filter((factor) => factor.status === "verified");
  const aal2 = mfa?.currentLevel === "aal2";
  return `
    <hr />
    <div class="kicker">SOLE OWNER SECURITY</div>
    <p><strong>${esc(profile.display_name || "DeeDou Owner")}</strong></p>
    <p class="muted">Owner bắt buộc TOTP 2FA (AAL2) trước khi bootstrap workstation đầu tiên.</p>
    ${state.message ? `<p class="notice">${esc(state.message)}</p>` : ""}
    ${state.enrollment ? `
      <div class="dd011-mfa-enroll">
        <p><strong>Scan QR bằng ứng dụng Authenticator do bạn quản lý.</strong></p>
        ${state.enrollment.qrCode ? `<img class="dd011-mfa-qr" alt="Owner TOTP QR" src="${attr(state.enrollment.qrCode)}" />` : ""}
        <p class="muted">Recovery secret: <code>${esc(state.enrollment.secret)}</code></p>
        <form data-dd011b-owner-mfa-verify>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" required />
          <button class="primary" type="submit">Verify & enable Owner 2FA</button>
        </form>
      </div>
    ` : !mfa?.ok ? `<button class="ghost" data-dd011b-refresh>Kiểm tra MFA</button>`
      : verifiedFactors.length === 0 ? `<button class="primary" data-dd011b-owner-mfa-enroll>Enroll Owner TOTP 2FA</button>`
      : !aal2 ? `
        <form data-dd011b-owner-mfa-challenge>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code" required />
          <button class="primary" type="submit">Verify Owner 2FA</button>
        </form>
      ` : `
        <form data-dd011b-owner-bootstrap>
          <input name="deviceLabel" value="Owner Admin" placeholder="Tên thiết bị Owner" required />
          <button class="primary" type="submit">Activate Owner workstation</button>
        </form>
        <p class="muted">Phiên thiết bị sẽ được lưu bằng Secure HttpOnly cookie; JavaScript không đọc được secret.</p>
      `}
  `;
}

function renderStaffActivation(profile, activation) {
  if (activation && ["PENDING", "APPROVED"].includes(activation.status)) {
    return `
      <hr />
      <div class="kicker">OWNER APPROVAL REQUIRED</div>
      <p><strong>${esc(profile.display_name || profile.username)}</strong> · @${esc(profile.username)}</p>
      <p class="muted">Đọc mã này cho Owner và đối chiếu mã đang hiện trong Owner Security.</p>
      <div class="notice"><strong class="dd011b-code">${esc(formatCode(activation.verificationCode))}</strong></div>
      <p class="muted">Status: ${esc(activation.status)} · Expires: ${esc(timeLabel(activation.expiresAt))}</p>
      <button class="ghost" data-dd011b-refresh>Kiểm tra lại trạng thái</button>
    `;
  }
  return `
    <hr />
    <div class="kicker">FIRST LOGIN / NEW DEVICE</div>
    <p><strong>${esc(profile.display_name || profile.username)}</strong> · @${esc(profile.username)}</p>
    <p class="muted">Đăng nhập đúng password chưa cấp quyền vận hành. Owner phải đối chiếu mã và approve thiết bị này.</p>
    ${state.message ? `<p class="notice">${esc(state.message)}</p>` : ""}
    <form data-dd011b-request-activation>
      <input name="deviceLabel" placeholder="VD: Quầy thu ngân 1" required />
      <select name="workstationMode">
        <option value="CASHIER">Cashier</option>
        <option value="STAFF">Floor Staff</option>
        <option value="KDS_KITCHEN">Kitchen KDS</option>
        <option value="KDS_BAR">Bar KDS</option>
        <option value="KDS_DESSERT">Dessert KDS</option>
        <option value="ADMIN">Admin</option>
      </select>
      <button class="primary" type="submit">Tạo mã xác nhận</button>
    </form>
  `;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    const status = await api.status();
    state.status = status.ok ? status : null;
    state.message = status.ok ? "" : status.reason || "";
    if (status.ok && status.isOwner) {
      state.mfa = await api.getMfaState();
    }
    if (status.ok && status.device?.active) {
      localStorage.setItem(STAFF_LOCATION_KEY, status.device.locationId || "");
      localStorage.setItem(WORKSTATION_MODE_KEY, status.device.workstationMode || "");
    }
  } finally {
    state.loading = false;
    scheduleEnsure();
  }
}

async function handleClick(event) {
  if (event.target.closest("[data-dd011b-refresh]")) return refresh();
  if (event.target.closest("[data-dd011b-reload]")) return location.reload();
  if (event.target.closest("[data-dd011b-owner-mfa-enroll]")) {
    const result = await api.enrollTotp("DeeDou Sole Owner");
    state.enrollment = result.ok ? result : null;
    state.message = result.ok ? "Scan QR rồi nhập mã TOTP để hoàn tất 2FA." : result.reason;
    scheduleEnsure();
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (form.matches?.("[data-dd011b-owner-mfa-verify]")) {
    event.preventDefault();
    const result = await api.verifyTotp({ factorId: state.enrollment?.factorId, code: new FormData(form).get("code") });
    state.message = result.ok ? "Owner 2FA enabled. Session now AAL2." : result.reason;
    if (result.ok) state.enrollment = null;
    await refresh();
    return;
  }
  if (form.matches?.("[data-dd011b-owner-mfa-challenge]")) {
    event.preventDefault();
    const verified = (state.mfa?.totp || []).find((factor) => factor.status === "verified");
    const result = await api.verifyTotp({ factorId: verified?.id, code: new FormData(form).get("code") });
    state.message = result.ok ? "Owner session is AAL2." : result.reason;
    await refresh();
    return;
  }
  if (form.matches?.("[data-dd011b-owner-bootstrap]")) {
    event.preventDefault();
    const result = await api.bootstrapOwnerDevice({ deviceLabel: new FormData(form).get("deviceLabel") });
    state.message = result.ok ? "Owner workstation activated." : result.reason;
    if (result.ok) {
      localStorage.setItem(STAFF_LOCATION_KEY, result.locationId || "");
      localStorage.setItem(WORKSTATION_MODE_KEY, result.workstationMode || "ADMIN");
      location.reload();
      return;
    }
    await refresh();
    return;
  }
  if (form.matches?.("[data-dd011b-request-activation]")) {
    event.preventDefault();
    const data = new FormData(form);
    const result = await api.requestActivation({ deviceLabel: data.get("deviceLabel"), workstationMode: data.get("workstationMode") });
    state.message = result.ok ? "Mã đã tạo. Hãy đối chiếu với Owner." : result.reason;
    await refresh();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, 3000);
}
function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
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
