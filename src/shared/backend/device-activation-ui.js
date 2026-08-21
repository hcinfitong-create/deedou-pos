import { BACKEND_MODES, getBackendConfig } from "./config.js";
import { createSupabasePasswordAuthApi, STAFF_LOCATION_KEY, WORKSTATION_MODE_KEY } from "../auth/index.js";
import { createSecurityAdminApi } from "./security-admin.js";

const config = getBackendConfig();
const authApi = createSupabasePasswordAuthApi({ config, storage: localStorage, deviceStorage: localStorage });
const securityApi = createSecurityAdminApi({ config, authApi, storage: localStorage });

if (config.mode === BACKEND_MODES.SUPABASE) {
  const root = document.getElementById("app");
  if (root && "MutationObserver" in window) {
    new MutationObserver(() => queueMicrotask(injectActivationForm)).observe(root, { childList: true, subtree: true });
  }
  document.addEventListener("submit", handleActivationSubmit);
  queueMicrotask(injectActivationForm);
}

function injectActivationForm() {
  const gate = document.querySelector("#app .auth-gate");
  if (!gate || gate.querySelector("[data-dd011-device-activation]")) return;
  const login = gate.querySelector("[data-auth-login]");
  const locationInput = login?.querySelector('[name="locationId"]');
  const modeInput = login?.querySelector('[name="workstationMode"]');
  const locationId = locationInput?.value || localStorage.getItem(STAFF_LOCATION_KEY) || "";
  const workstationMode = modeInput?.value || localStorage.getItem(WORKSTATION_MODE_KEY) || "ADMIN";
  const section = document.createElement("div");
  section.dataset.dd011DeviceActivation = "";
  section.className = "dd011-device-activation";
  section.innerHTML = `
    <hr />
    <div class="kicker">WORKSTATION ACTIVATION</div>
    <p class="muted">Sau khi đăng nhập, nhập credential một lần do Owner/Manager cấp. Server xác minh user + location + device trước khi lưu vào browser.</p>
    <form class="auth-form" data-dd011-activate-device>
      <label>Location ID<input name="locationId" value="${attr(locationId)}" required /></label>
      <label>Workstation
        <select name="workstationMode">
          ${["CASHIER", "STAFF", "KDS_KITCHEN", "KDS_BAR", "KDS_DESSERT", "ADMIN"].map((mode) => `<option value="${mode}" ${mode === workstationMode ? "selected" : ""}>${mode}</option>`).join("")}
        </select>
      </label>
      <label>One-time device credential<input name="credential" type="password" autocomplete="off" required /></label>
      <button class="ghost" type="submit">Activate workstation</button>
      <p class="muted" data-dd011-activation-message></p>
    </form>
  `;
  gate.appendChild(section);
}

async function handleActivationSubmit(event) {
  const form = event.target.closest?.("[data-dd011-activate-device]");
  if (!form) return;
  event.preventDefault();
  const message = form.querySelector("[data-dd011-activation-message]");
  const data = new FormData(form);
  const session = await authApi.getSessionInfo();
  if (!session.session) {
    message.textContent = "Đăng nhập tài khoản nhân viên trước khi activate thiết bị.";
    return;
  }
  const result = await securityApi.activateCredential({
    credential: data.get("credential"),
    locationId: data.get("locationId"),
    workstationMode: data.get("workstationMode")
  });
  if (!result.ok) {
    message.textContent = `Activation denied: ${result.reason}`;
    return;
  }
  message.textContent = "Device verified. Reloading…";
  location.reload();
}

function text(value) { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function esc(value) { return text(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function attr(value) { return esc(value).replace(/`/g, "&#96;"); }
