import { BACKEND_MODES, getBackendConfig } from "../backend/index.js";
import { escapeAttr, escapeHtml } from "../utils/index.js";

export const AUTH_SESSION_KEY = "deedou_supabase_auth_session";
export const STAFF_LOCATION_KEY = "deedou_staff_location_id";
export const DEVICE_CREDENTIAL_KEY = "deedou_device_credential";
export const WORKSTATION_MODE_KEY = "deedou_workstation_mode";
export const DEFAULT_LOCATION_ID = "deedou-demo";

export const AUTH_DENIAL_REASONS = Object.freeze({
  AUTH_LOADING: "AUTH_LOADING",
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED",
  STAFF_INACTIVE: "STAFF_INACTIVE",
  LOCATION_DENIED: "LOCATION_DENIED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  DEVICE_UNREGISTERED: "DEVICE_UNREGISTERED",
  DEVICE_MODE_DENIED: "DEVICE_MODE_DENIED",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE"
});

export const WORKSTATION_MODES = Object.freeze({
  CASHIER: "CASHIER",
  STAFF: "STAFF",
  KDS_KITCHEN: "KDS_KITCHEN",
  KDS_BAR: "KDS_BAR",
  KDS_DESSERT: "KDS_DESSERT",
  ADMIN: "ADMIN"
});

export const STAFF_ROUTE_POLICIES = Object.freeze({
  cashier: Object.freeze({
    route: "cashier",
    label: "Cashier",
    permission: "payments.record",
    workstationMode: WORKSTATION_MODES.CASHIER
  }),
  staff: Object.freeze({
    route: "staff",
    label: "Staff",
    permission: "orders.accept",
    workstationMode: WORKSTATION_MODES.STAFF
  }),
  bar: Object.freeze({
    route: "bar",
    label: "Bar KDS",
    permission: "kds.bar",
    workstationMode: WORKSTATION_MODES.KDS_BAR
  }),
  kitchen: Object.freeze({
    route: "kitchen",
    label: "Kitchen KDS",
    permission: "kds.kitchen",
    workstationMode: WORKSTATION_MODES.KDS_KITCHEN
  }),
  dessert: Object.freeze({
    route: "dessert",
    label: "Dessert KDS",
    permission: "kds.dessert",
    workstationMode: WORKSTATION_MODES.KDS_DESSERT
  }),
  admin: Object.freeze({
    route: "admin",
    label: "Admin",
    permission: "menu.manage",
    workstationMode: WORKSTATION_MODES.ADMIN
  })
});

const MODE_LABELS = Object.freeze({
  CASHIER: "Cashier",
  STAFF: "Staff",
  KDS_KITCHEN: "Kitchen KDS",
  KDS_BAR: "Bar KDS",
  KDS_DESSERT: "Dessert KDS",
  ADMIN: "Admin"
});

const DENIAL_MESSAGES = Object.freeze({
  AUTH_LOADING: "Đang kiểm tra quyền truy cập.",
  SIGN_IN_REQUIRED: "Vui lòng đăng nhập bằng tài khoản nhân viên.",
  STAFF_INACTIVE: "Tài khoản nhân viên chưa được kích hoạt hoặc đã bị khóa.",
  LOCATION_DENIED: "Tài khoản này không có quyền tại cơ sở đang chọn.",
  PERMISSION_DENIED: "Vai trò hiện tại không có quyền mở màn hình này.",
  DEVICE_UNREGISTERED: "Thiết bị/quầy này chưa được đăng ký hoặc đã bị thu hồi.",
  DEVICE_MODE_DENIED: "Chế độ thiết bị không phù hợp với màn hình này.",
  BACKEND_UNAVAILABLE: "Chưa kết nối được Supabase Auth."
});

export function isStaffRoute(routeName) {
  return Object.hasOwn(STAFF_ROUTE_POLICIES, routeName);
}

export function getStaffRoutePolicy(routeName) {
  return STAFF_ROUTE_POLICIES[routeName] || null;
}

export function createInitialStaffAuthState(options = {}) {
  const config = getBackendConfig(options.config);
  const storage = options.storage || safeSessionStorage();
  const localStorageRef = options.localStorage || safeLocalStorage();
  const session = readStoredAuthSession(storage);
  const locationId = normalizeText(localStorageRef?.getItem?.(STAFF_LOCATION_KEY)) || DEFAULT_LOCATION_ID;
  const workstationMode = normalizeWorkstationMode(localStorageRef?.getItem?.(WORKSTATION_MODE_KEY)) || "";
  const deviceCredential = normalizeText(storage?.getItem?.(DEVICE_CREDENTIAL_KEY));

  if (config.mode !== BACKEND_MODES.SUPABASE) {
    return {
      backendMode: config.mode,
      status: "LOCAL_DEMO",
      session: null,
      locationId,
      workstationMode,
      deviceCredential,
      authorization: { ok: true, reason: "" },
      staffContext: [],
      error: ""
    };
  }

  return {
    backendMode: config.mode,
    status: session?.accessToken ? "SIGNED_IN_STALE" : "SIGNED_OUT",
    session,
    locationId,
    workstationMode,
    deviceCredential,
    authorization: null,
    staffContext: [],
    error: ""
  };
}

export function evaluateStaffRouteAccess({ config, routeName, authState } = {}) {
  const backendConfig = getBackendConfig(config);
  const policy = getStaffRoutePolicy(routeName);
  if (!policy) return { ok: true, reason: "", policy: null };
  if (backendConfig.mode !== BACKEND_MODES.SUPABASE) return { ok: true, reason: "", policy };
  if (!authState?.session?.accessToken) return { ok: false, reason: AUTH_DENIAL_REASONS.SIGN_IN_REQUIRED, policy };
  if (authState.status === "CHECKING") return { ok: false, reason: AUTH_DENIAL_REASONS.AUTH_LOADING, policy };
  if (authState.authorization?.ok === true && authState.authorization?.route === routeName) {
    return { ok: true, reason: "", policy, authorization: authState.authorization };
  }
  if (authState.authorization?.ok === false && authState.authorization?.route === routeName) {
    return {
      ok: false,
      reason: authState.authorization.reason || AUTH_DENIAL_REASONS.PERMISSION_DENIED,
      policy,
      authorization: authState.authorization
    };
  }
  return { ok: false, reason: AUTH_DENIAL_REASONS.AUTH_LOADING, policy };
}

export function normalizeStaffContextRows(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows
    .map((row) => ({
      staffProfileId: normalizeText(row.staff_profile_id || row.staffProfileId),
      displayName: normalizeText(row.display_name || row.displayName),
      active: row.active === true,
      locationId: normalizeText(row.location_id || row.locationId),
      locationName: normalizeText(row.location_name || row.locationName),
      roles: normalizeStringList(row.roles),
      permissions: normalizeStringList(row.permissions),
      deviceId: normalizeText(row.device_id || row.deviceId),
      workstationMode: normalizeWorkstationMode(row.workstation_mode || row.workstationMode)
    }))
    .filter((row) => row.staffProfileId && row.locationId);
}

export function normalizeAuthorizationResult(value, routeName = "") {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") {
    return { ok: false, reason: AUTH_DENIAL_REASONS.BACKEND_UNAVAILABLE, route: routeName };
  }
  return {
    ok: row.ok === true,
    reason: normalizeText(row.reason),
    route: routeName,
    staffProfileId: normalizeText(row.staff_profile_id || row.staffProfileId),
    locationId: normalizeText(row.location_id || row.locationId),
    deviceId: normalizeText(row.device_id || row.deviceId),
    workstationMode: normalizeWorkstationMode(row.workstation_mode || row.workstationMode)
  };
}

export function getPreferredWorkstationMode(routeName, storedMode = "") {
  return normalizeWorkstationMode(storedMode) || getStaffRoutePolicy(routeName)?.workstationMode || WORKSTATION_MODES.CASHIER;
}

export function renderStaffAuthGate({ routeName, authState, access, config } = {}) {
  const policy = access?.policy || getStaffRoutePolicy(routeName);
  const backendConfig = getBackendConfig(config);
  const reason = access?.reason || authState?.authorization?.reason || AUTH_DENIAL_REASONS.SIGN_IN_REQUIRED;
  const isSignedIn = Boolean(authState?.session?.accessToken);
  const locationId = normalizeText(authState?.locationId) || DEFAULT_LOCATION_ID;
  const workstationMode = getPreferredWorkstationMode(routeName, authState?.workstationMode);
  const deviceCredential = normalizeText(authState?.deviceCredential);
  const message = authState?.error || DENIAL_MESSAGES[reason] || DENIAL_MESSAGES.PERMISSION_DENIED;
  const title = isSignedIn ? "Không đủ quyền truy cập" : "Đăng nhập nhân viên";

  return `
    <section class="page admin-page">
      <div class="auth-gate panel section-pad">
        <div class="order-head">
          <div>
            <div class="kicker">Supabase Auth</div>
            <h1>${escapeHtml(title)}</h1>
            <p class="muted">${escapeHtml(message)}</p>
          </div>
          ${isSignedIn ? `<button class="ghost" data-auth-logout>Logout</button>` : ""}
        </div>
        <div class="auth-context">
          <span class="station">${escapeHtml(policy?.label || routeName || "Staff")}</span>
          <span class="station">${escapeHtml(locationId)}</span>
          <span class="station">${escapeHtml(workstationMode)}</span>
          <span class="station">${escapeHtml(backendConfig.mode)}</span>
        </div>
        <form class="auth-form" data-auth-login>
          <label>
            Email
            <input name="email" type="email" autocomplete="username" ${isSignedIn ? "" : "required"} />
          </label>
          <label>
            Password
            <input name="password" type="password" autocomplete="current-password" ${isSignedIn ? "" : "required"} />
          </label>
          <label>
            Location ID
            <input name="locationId" value="${escapeAttr(locationId)}" required />
          </label>
          <label>
            Workstation
            <select name="workstationMode">
              ${Object.values(WORKSTATION_MODES).map((mode) => `
                <option value="${escapeAttr(mode)}" ${mode === workstationMode ? "selected" : ""}>${escapeHtml(MODE_LABELS[mode] || mode)}</option>
              `).join("")}
            </select>
          </label>
          <label>
            Device token
            <input name="deviceCredential" value="${escapeAttr(deviceCredential)}" autocomplete="off" required />
          </label>
          <button class="primary" type="submit">${isSignedIn ? "Kiểm tra lại quyền" : "Đăng nhập"}</button>
        </form>
        <p class="muted auth-note">External VNPAY/MoMo/ZaloPay payments are still local demo flows. Staff auth uses the public Supabase key only.</p>
      </div>
    </section>
  `;
}

export function createSupabasePasswordAuthApi(options = {}) {
  const config = getBackendConfig(options.config);
  const fetchFn = options.fetch || globalThis.fetch;
  const storage = options.storage || safeSessionStorage();
  if (config.mode !== BACKEND_MODES.SUPABASE || typeof fetchFn !== "function") {
    return {
      isAvailable: false,
      config,
      readSession: () => readStoredAuthSession(storage),
      signInWithPassword: async () => ({ ok: false, reason: AUTH_DENIAL_REASONS.BACKEND_UNAVAILABLE }),
      authorize: async () => ({ ok: false, reason: AUTH_DENIAL_REASONS.BACKEND_UNAVAILABLE }),
      getStaffContext: async () => [],
      logout: () => clearStoredAuthSession(storage)
    };
  }

  async function request(path, { method = "POST", token = "", body = null } = {}) {
    const response = await fetchFn(`${config.supabaseUrl}${path}`, {
      method,
      headers: {
        apikey: config.supabasePublishableKey,
        Authorization: token ? `Bearer ${token}` : `Bearer ${config.supabasePublishableKey}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : null
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: payload?.msg || payload?.message || payload?.error_description || payload?.error || "REQUEST_FAILED",
        payload
      };
    }
    return { ok: true, status: response.status, payload };
  }

  return {
    isAvailable: true,
    config,
    readSession: () => readStoredAuthSession(storage),
    async signInWithPassword({ email, password } = {}) {
      const result = await request("/auth/v1/token?grant_type=password", {
        body: {
          email: normalizeText(email),
          password: String(password || "")
        }
      });
      if (!result.ok) return result;
      const session = normalizeAuthSession(result.payload);
      if (!session.accessToken) return { ok: false, reason: "SESSION_MISSING" };
      writeStoredAuthSession(storage, session);
      return { ok: true, session };
    },
    async authorize({ session, locationId, permission, workstationMode, deviceCredential, routeName } = {}) {
      const token = session?.accessToken || readStoredAuthSession(storage)?.accessToken || "";
      if (!token) return { ok: false, reason: AUTH_DENIAL_REASONS.SIGN_IN_REQUIRED, route: routeName };
      const result = await request("/rest/v1/rpc/authorize_staff_access", {
        token,
        body: {
          p_location_id: normalizeText(locationId),
          p_permission_key: normalizeText(permission),
          p_workstation_mode: normalizeWorkstationMode(workstationMode),
          p_device_credential: normalizeText(deviceCredential)
        }
      });
      if (!result.ok) return { ok: false, reason: result.reason || AUTH_DENIAL_REASONS.BACKEND_UNAVAILABLE, route: routeName };
      return normalizeAuthorizationResult(result.payload, routeName);
    },
    async getStaffContext({ session, locationId, deviceCredential } = {}) {
      const token = session?.accessToken || readStoredAuthSession(storage)?.accessToken || "";
      if (!token) return [];
      const result = await request("/rest/v1/rpc/get_my_staff_context", {
        token,
        body: {
          p_location_id: normalizeText(locationId) || null,
          p_device_credential: normalizeText(deviceCredential)
        }
      });
      if (!result.ok) return [];
      return normalizeStaffContextRows(result.payload);
    },
    logout() {
      clearStoredAuthSession(storage);
    }
  };
}

export function normalizeAuthSession(payload = {}) {
  return {
    accessToken: normalizeText(payload.access_token || payload.accessToken),
    refreshToken: normalizeText(payload.refresh_token || payload.refreshToken),
    expiresAt: Number(payload.expires_at || payload.expiresAt || 0) || 0,
    tokenType: normalizeText(payload.token_type || payload.tokenType) || "bearer",
    userEmail: normalizeText(payload.user?.email || payload.userEmail)
  };
}

export function readStoredAuthSession(storage = safeSessionStorage()) {
  try {
    const raw = storage?.getItem?.(AUTH_SESSION_KEY);
    if (!raw) return null;
    const session = normalizeAuthSession(JSON.parse(raw));
    return session.accessToken ? session : null;
  } catch {
    return null;
  }
}

export function writeStoredAuthSession(storage = safeSessionStorage(), session) {
  const normalized = normalizeAuthSession(session);
  if (!normalized.accessToken) return false;
  storage?.setItem?.(AUTH_SESSION_KEY, JSON.stringify(normalized));
  return true;
}

export function clearStoredAuthSession(storage = safeSessionStorage()) {
  storage?.removeItem?.(AUTH_SESSION_KEY);
}

export function routeAuthorizationKey({ routeName, authState, policy } = {}) {
  return [
    routeName || "",
    authState?.session?.accessToken || "",
    authState?.locationId || "",
    authState?.deviceCredential || "",
    policy?.permission || "",
    policy?.workstationMode || ""
  ].join("|");
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeWorkstationMode(value) {
  const mode = normalizeText(value).toUpperCase();
  return Object.hasOwn(WORKSTATION_MODES, mode) ? mode : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
