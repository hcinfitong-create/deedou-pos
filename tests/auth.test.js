import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BACKEND_MODES } from "../src/shared/backend/index.js";
import {
  AUTH_DENIAL_REASONS,
  createInitialStaffAuthState,
  createSupabasePasswordAuthApi,
  DEFAULT_LOCATION_ID,
  evaluateStaffRouteAccess,
  getStaffRoutePolicy,
  isStaffRoute,
  normalizeAuthorizationResult,
  normalizeStaffContextRows,
  renderStaffAuthGate,
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
  assert.equal(access.reason, AUTH_DENIAL_REASONS.SIGN_IN_REQUIRED);
  assert.equal(evaluateStaffRouteAccess({ config: supabaseConfig(), routeName: "customer", authState: supabaseState }).ok, true);
});

test("SUPABASE route gate waits for the matching server authorization result", () => {
  const session = { accessToken: "jwt-local-test" };
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

test("Supabase password auth API uses public auth and RPC endpoints only", async () => {
  const calls = [];
  const storage = memoryStorage();
  const api = createSupabasePasswordAuthApi({
    config: supabaseConfig(),
    storage,
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body || "{}") });
      if (url.endsWith("/auth/v1/token?grant_type=password")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_at: 123,
          user: { email: "cashier@example.invalid" }
        });
      }
      if (url.endsWith("/rest/v1/rpc/authorize_staff_access")) {
        return jsonResponse([{ ok: true, reason: "", staff_profile_id: "staff-cashier", location_id: "deedou-demo", device_id: "dev-cashier", workstation_mode: "CASHIER" }]);
      }
      if (url.endsWith("/rest/v1/rpc/get_my_staff_context")) {
        return jsonResponse([{ staff_profile_id: "staff-cashier", display_name: "Cashier", active: true, location_id: "deedou-demo", roles: ["CASHIER"], permissions: ["payments.record"], device_id: "dev-cashier", workstation_mode: "CASHIER" }]);
      }
      return jsonResponse({ message: "not found" }, false, 404);
    }
  });

  const signedIn = await api.signInWithPassword({ email: "cashier@example.invalid", password: "local-only" });
  assert.equal(signedIn.ok, true);
  assert.equal(api.readSession().accessToken, "access-token");

  const authorization = await api.authorize({
    session: signedIn.session,
    locationId: DEFAULT_LOCATION_ID,
    permission: "payments.record",
    workstationMode: "CASHIER",
    deviceCredential: "ci-cashier-device",
    routeName: "cashier"
  });
  assert.equal(authorization.ok, true);
  assert.equal(authorization.deviceId, "dev-cashier");

  const context = await api.getStaffContext({
    session: signedIn.session,
    locationId: DEFAULT_LOCATION_ID,
    deviceCredential: "ci-cashier-device"
  });
  assert.equal(context[0].staffProfileId, "staff-cashier");

  assert.equal(calls[0].url, "https://deedou-demo.supabase.co/auth/v1/token?grant_type=password");
  assert.equal(calls[1].url, "https://deedou-demo.supabase.co/rest/v1/rpc/authorize_staff_access");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(calls[1].body, {
    p_location_id: DEFAULT_LOCATION_ID,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: "ci-cashier-device"
  });
});

test("auth gate renders escaped denial context and does not expose privileged page content", () => {
  const html = renderStaffAuthGate({
    routeName: "admin",
    config: supabaseConfig(),
    access: { ok: false, reason: "PERMISSION_DENIED", policy: getStaffRoutePolicy("admin") },
    authState: {
      status: "DENIED",
      session: { accessToken: "token" },
      locationId: "<script>",
      workstationMode: "ADMIN",
      deviceCredential: "\"token\"",
      authorization: { ok: false, reason: "PERMISSION_DENIED" }
    }
  });

  assert.match(html, /Không đủ quyền truy cập/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;token&quot;/);
  assert.doesNotMatch(html, /DeeDou POS setup/);
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
});

function supabaseConfig() {
  return {
    mode: BACKEND_MODES.SUPABASE,
    supabaseUrl: "https://deedou-demo.supabase.co",
    supabasePublishableKey: "sb_publishable_demo_key"
  };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload)
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
