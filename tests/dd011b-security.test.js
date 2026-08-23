import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEVICE_SESSION_COOKIE,
  backendConfig,
  secureCookie,
  normalizeUsername,
  isValidUsername,
  sameOriginAllowed,
  staffLoginEmail
} from "../api/_dd011b.js";
import {
  LEGACY_DEVICE_CREDENTIAL_KEY,
  loginEmailForIdentifier,
  shouldProxyStaffRpc,
  rpcFunctionName
} from "../src/shared/backend/device-session-transport.js";

test("DD011B normalizes unique staff username into internal Auth email", () => {
  assert.equal(normalizeUsername("  HieuStaff1 "), "hieustaff1");
  assert.equal(isValidUsername("hieustaff1"), true);
  assert.equal(isValidUsername("ab"), false);
  assert.equal(staffLoginEmail("HieuStaff1"), "hieustaff1@staff.deedou.invalid");
  assert.equal(loginEmailForIdentifier("hieustaff1"), "hieustaff1@staff.deedou.invalid");
  assert.equal(loginEmailForIdentifier("owner@example.com"), "owner@example.com");
});

test("DD011B device session cookie is JS-inaccessible and strict same-origin", () => {
  const cookie = secureCookie(DEVICE_SESSION_COOKIE, "secret", 300);
  assert.match(cookie, /^__Host-deedou_device_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

test("DD011B local backend allows loopback HTTP without allowing remote insecure origins", () => {
  const local = backendConfig({
    DEEDOU_SUPABASE_URL: "http://127.0.0.1:54321",
    DEEDOU_SUPABASE_PUBLISHABLE_KEY: "publishable",
    DEEDOU_SUPABASE_SERVICE_ROLE_KEY: "service"
  });
  assert.equal(local?.supabaseUrl, "http://127.0.0.1:54321");
  assert.equal(backendConfig({
    DEEDOU_SUPABASE_URL: "http://example.com",
    DEEDOU_SUPABASE_PUBLISHABLE_KEY: "publishable",
    DEEDOU_SUPABASE_SERVICE_ROLE_KEY: "service"
  }), null);
  assert.equal(sameOriginAllowed({ headers: { origin: "http://127.0.0.1:8099", host: "127.0.0.1:8099" } }), true);
  assert.equal(sameOriginAllowed({ headers: { origin: "http://localhost:8099", host: "localhost:8099" } }), true);
  assert.equal(sameOriginAllowed({ headers: { origin: "http://example.com", host: "example.com" } }), false);
  assert.equal(sameOriginAllowed({ headers: { origin: "https://pos.deedou.example", host: "pos.deedou.example" } }), true);
});

test("DD011B proxies only RPCs carrying workstation proof", () => {
  const staffUrl = "https://example.supabase.co/rest/v1/rpc/authorize_staff_access";
  assert.equal(shouldProxyStaffRpc(staffUrl, { p_device_credential: "" }), true);
  assert.equal(shouldProxyStaffRpc(staffUrl, { p_current_device_credential: "" }), true);
  assert.equal(shouldProxyStaffRpc("https://example.supabase.co/rest/v1/rpc/submit_qr_order", { p_qr_token: "abc" }), false);
  assert.equal(rpcFunctionName(staffUrl), "authorize_staff_access");
});

test("DD011B production HTML no longer loads legacy browser credential UI", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /device-session-transport\.js/);
  assert.match(html, /security-bootstrap-ui\.js/);
  assert.match(html, /security-admin-v2-ui\.js/);
  assert.doesNotMatch(html, /device-activation-ui\.js/);
  assert.doesNotMatch(html, /security-admin-ui\.js/);
});

test("DD011B loaded security surfaces never persist legacy device credential", () => {
  const files = [
    "../src/shared/backend/device-session-transport.js",
    "../src/shared/backend/security-bootstrap-ui.js",
    "../src/shared/backend/security-admin-v2-ui.js",
    "../src/shared/backend/security-v2-api.js"
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes(`setItem(\"${LEGACY_DEVICE_CREDENTIAL_KEY}\"`), false, file);
    assert.equal(source.includes(`setItem('${LEGACY_DEVICE_CREDENTIAL_KEY}'`), false, file);
  }
});
