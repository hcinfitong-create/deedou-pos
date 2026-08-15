import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BACKEND_MODES } from "../src/shared/backend/index.js";
import {
  AUTH_DENIAL_REASONS,
  createInitialStaffAuthState,
  createSupabasePasswordAuthApi,
  DEFAULT_LOCATION_ID,
  DEVICE_CREDENTIAL_KEY,
  evaluateStaffRouteAccess,
  getStaffRoutePolicy,
  isStaffRoute,
  normalizeAuthorizationResult,
  normalizeStaffContextRows,
  renderStaffAuthGate,
  routeAuthorizationKey,
  STAFF_ROUTE_POLICIES,
  WORKSTATION_MODES
} from "../src/shared/auth/index.js";

const authSource = readFileSync(new URL("../src/shared/auth/index.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("staff route policies map protected routes to permission and workstation intent", () => {
  assert.equal(isStaffRoute("customer"), false);
  assert.equal(isStaffRoute("cashier"), true);
  assert.deepEqual(getStaffRoutePolicy("cashier"), STAFF_ROUTE_POLICIES.cashier);
  assert.equal(STAFF_ROUTE_POLICIES.cashier.permission, "payments.record");
  assert.equal(STAFF_ROUTE_POLICIES.cashier.workstationMode, WORKSTATION_MODES.CASHIER);
  assert.equal(STAFF_ROUTE_POLICIES.kitchen.permission, "kds.kitchen");
  assert.equal(STAFF_ROUTE_POLICIES.admin.permission, "menu.manage");
});

test("LOCAL_DEMO route access remains open while SUPABASE signed-out staff routes are gated", () => {
  const localState = createInitialStaffAuthState({ config: {} });
  assert.equal(localState.status, "LOCAL_DEMO");
  assert.equal(evaluateStaffRouteAccess({ routeName: "cashier", authState: localState }).ok, true);

  const supabaseState = createInitialStaffAuthState({
    config: supabaseConfig(),
    storage: memoryStorage(),
    localStorage: memoryStorage()
  });
  const access = evaluateStaffRouteAccess({ config: supabaseConfig(), routeName: "cashier", authState: supabaseState });
  assert.equal(access.ok, false);
  assert.equal(access.reason, AUTH_DENIAL_REASONS.AUTH_LOADING);
  assert.equal(evaluateStaffRouteAccess({ config: supabaseConfig(), routeName: "customer", authState: supabaseState }).ok, true);
});

test("SUPABASE route gate waits for the matching server authorization result", () => {
  const session = { userEmail: "staff@example.invalid", userId: "auth-user" };
  const loading = evaluateStaffRouteAccess({
    config: supabaseConfig(),
    routeName: "kitchen",
    authState: { status: "SIGNED_IN_STALE", session }
  });
  assert.equal(loading.ok, false);
  assert.equal(loading.reason, AUTH_DENIAL_REASONS.AUTH_LOADING);

  const denied = evaluateStaffRouteAccess({
    config: supabaseConfig(),
    routeName: "kitchen",
    authState: {
      status: "DENIED",
      session,
      authorization: normalizeAuthorizationResult([{ ok: false, reason: "PERMISSION_DENIED" }], "kitchen")
    }
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, AUTH_DENIAL_REASONS.PERMISSION_DENIED);

  const allowed = evaluateStaffRouteAccess({
    config: supabaseConfig(),
    routeName: "kitchen",
    authState: {
      status: "AUTHORIZED",
      session,
      authorization: normalizeAuthorizationResult([{ ok: true, reason: "", workstation_mode: "KDS_KITCHEN" }], "kitchen")
    }
  });
  assert.equal(allowed.ok, true);
});

test("staff context and auth result normalization preserve identity and deny malformed payloads", () => {
  assert.deepEqual(normalizeStaffContextRows(null), []);
  assert.deepEqual(normalizeStaffContextRows([{
    staff_profile_id: "staff-1",
    display_name: "Cashier",
    active: true,
    location_id: "deedou-demo",
    location_name: "DeeDou",
    roles: ["CASHIER", ""],
    permissions: ["payments.record"],
    device_id: "dev-1",
    workstation_mode: "CASHIER"
  }]), [{
    staffProfileId: "staff-1",
    displayName: "Cashier",
    active: true,
    locationId: "deedou-demo",
    locationName: "DeeDou",
    roles: ["CASHIER"],
    permissions: ["payments.record"],
    deviceId: "dev-1",
    workstationMode: "CASHIER"
  }]);

  assert.deepEqual(normalizeAuthorizationResult(null, "admin"), {
    ok: false,
    reason: AUTH_DENIAL_REASONS.BACKEND_UNAVAILABLE,
    route: "admin"
  });
});

test("Supabase auth API delegates lifecycle to Supabase-managed client", async () => {
  const calls = [];
  const storage = memoryStorage();
  const deviceStorage = memoryStorage();
  deviceStorage.setItem(DEVICE_CREDENTIAL_KEY, "server-issued-device-credential");
  const session = { user: { id: "auth-user", email: "cashier@example.invalid" } };
  const api = createSupabasePasswordAuthApi({
    config: supabaseConfig(),
    storage,
    deviceStorage,
    client: {
      auth: {
        getSession: async () => {
          calls.push({ type: "getSession" });
          return { data: { session } };
        },
        signInWithPassword: async (credentials) => {
          calls.push({ type: "signInWithPassword", credentials });
          return { data: { session } };
        },
        signOut: async (options) => {
          calls.push({ type: "signOut", options });
          return {};
        },
        onAuthStateChange: (callback) => {
          calls.push({ type: "onAuthStateChange", callback: typeof callback });
          return { data: { subscription: { unsubscribe() {} } } };
        }
      },
      rpc: async (functionName, params) => {
        calls.push({ type: "rpc", functionName, params });
        if (functionName === "authorize_staff_access") {
          return { data: [{ ok: true, reason: "", staff_profile_id: "staff-cashier", location_id: "deedou-demo", device_id: "dev-cashier", workstation_mode: "CASHIER" }] };
        }
        if (functionName === "get_my_staff_context") {
          return { data: [{ staff_profile_id: "staff-cashier", display_name: "Cashier", active: true, location_id: "deedou-demo", roles: ["CASHIER"], permissions: ["payments.record"], device_id: "dev-cashier", workstation_mode: "CASHIER" }] };
        }
        return { data: [] };
      }
    }
  });

  const signedIn = await api.signInWithPassword({ email: "cashier@example.invalid", password: "local-only" });
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.session.userEmail, "cashier@example.invalid");

  const restored = await api.restoreSession();
  assert.equal(restored.session.userId, "auth-user");

  const authorization = await api.authorize({
    locationId: DEFAULT_LOCATION_ID,
    permission: "payments.record",
    workstationMode: "CASHIER",
    routeName: "cashier"
  });
  assert.equal(authorization.ok, true);
  assert.equal(authorization.deviceId, "dev-cashier");

  const context = await api.getStaffContext({
    locationId: DEFAULT_LOCATION_ID,
    workstationMode: "CASHIER"
  });
  assert.equal(context[0].staffProfileId, "staff-cashier");

  const logout = await api.logout();
  assert.equal(logout.ok, true);

  assert.deepEqual(calls.find((call) => call.type === "signInWithPassword").credentials, {
    email: "cashier@example.invalid",
    password: "local-only"
  });
  assert.deepEqual(calls.find((call) => call.functionName === "authorize_staff_access").params, {
    p_location_id: DEFAULT_LOCATION_ID,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: "server-issued-device-credential"
  });
  assert.deepEqual(calls.find((call) => call.functionName === "get_my_staff_context").params, {
    p_location_id: DEFAULT_LOCATION_ID,
    p_workstation_mode: "CASHIER",
    p_device_credential: "server-issued-device-credential"
  });
  assert.deepEqual(calls.find((call) => call.type === "signOut").options, { scope: "local" });
});

test("auth gate renders escaped denial context and does not expose privileged page content", () => {
  const html = renderStaffAuthGate({
    routeName: "admin",
    config: supabaseConfig(),
    access: { ok: false, reason: "PERMISSION_DENIED", policy: getStaffRoutePolicy("admin") },
    authState: {
      status: "DENIED",
      session: { userEmail: "admin@example.invalid" },
      locationId: "<script>",
      workstationMode: "ADMIN",
      hasDeviceCredential: true,
      authorization: { ok: false, reason: "PERMISSION_DENIED" }
    }
  });

  assert.match(html, /Không đủ quyền truy cập/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /Device token/);
  assert.doesNotMatch(html, /name="deviceCredential"/);
  assert.doesNotMatch(html, /DeeDou POS setup/);
});

test("authorization cache keys never include JWTs or device bearer credentials", () => {
  const key = routeAuthorizationKey({
    routeName: "cashier",
    authState: {
      session: { accessToken: "jwt-secret", userEmail: "cashier@example.invalid" },
      locationId: DEFAULT_LOCATION_ID,
      deviceCredential: "device-secret",
      authVersion: 7
    },
    policy: getStaffRoutePolicy("cashier")
  });

  assert.doesNotMatch(key, /jwt-secret/);
  assert.doesNotMatch(key, /device-secret/);
  assert.match(key, /cashier/);
  assert.match(key, /payments\.record/);
});

test("authorized SUPABASE routes load authoritative operational state before privileged handlers", () => {
  assert.match(appSource, /createAuthoritativeBackendApi/);
  assert.match(appSource, /shouldUseSupabaseAuthoritativeState\(current\.name, staffAccess\)/);
  assert.match(appSource, /ensureSupabaseOperationalState\(\)/);
  assert.match(appSource, /authoritativeBackendApi\.fetchStaffSnapshot/);
  assert.match(appSource, /authoritativeBackendApi\.recordOrderPayment/);
  assert.match(appSource, /authoritativeBackendApi\.updateKdsLinePrep/);
  assert.match(appSource, /authoritativeBackendApi\.serveOrderLine/);
  assert.match(appSource, /authoritativeBackendApi\.recordTableTender/);
  assert.match(appSource, /function saveState\(\) \{\s*if \(blockSupabaseLocalCommand\("STATE_SAVE"\)\)/s);
  assert.match(appSource, /function saveProducts\(\) \{\s*if \(blockSupabaseLocalCommand\("MENU_SAVE"\)\)/s);
  assert.match(appSource, /localStorage admin changes are disabled in SUPABASE mode/);
  assert.doesNotMatch(appSource, /shouldRenderSupabaseReadOnly/);
  assert.doesNotMatch(appSource, /server command not available until DD-008C/);
});

test("browser source has no Supabase admin API or server secret exposure", () => {
  [authSource, appSource].forEach((source) => {
    assert.doesNotMatch(source, /supabase\.auth\.admin/i);
    assert.doesNotMatch(source, /service[_-]?role/i);
    assert.doesNotMatch(source, /sb_secret_/i);
    assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE/i);
  });
  assert.match(appSource, /shouldRenderStaffAuthGate\(current\.name, staffAccess\)/);
  assert.match(appSource, /return renderStaffAuthGate/);
  assert.match(authSource, /resolveSupabaseCreateClient/);
  assert.match(authSource, /@supabase\/supabase-js/);
  assert.match(authSource, /signInWithPassword/);
  assert.match(authSource, /getSession/);
  assert.match(authSource, /autoRefreshToken:\s*true/);
  assert.match(authSource, /onAuthStateChange/);
  assert.match(authSource, /signOut\(\{\s*scope:\s*"local"\s*\}\)/);
  assert.doesNotMatch(authSource, /accessToken|refreshToken/);
  assert.match(appSource, /shouldUseSupabaseAuthoritativeState/);
  assert.match(appSource, /command must run through DeeDou server authority in SUPABASE mode/);
  assert.doesNotMatch(appSource, /shouldRenderSupabaseReadOnly/);
});

function supabaseConfig() {
  return {
    mode: BACKEND_MODES.SUPABASE,
    supabaseUrl: "https://deedou-demo.supabase.co",
    supabasePublishableKey: "sb_publishable_demo_key"
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}
