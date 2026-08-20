import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeBackendConfig,
  serializeRuntimeBackendConfig
} from "../api/runtime-config.js";

function jwtForRole(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ role })}.signature`;
}

test("hosted runtime config exposes only approved public Supabase config", () => {
  const config = buildRuntimeBackendConfig({
    DEEDOU_BACKEND_MODE: "SUPABASE",
    DEEDOU_SUPABASE_URL: "https://example.supabase.co",
    DEEDOU_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
    SUPABASE_SERVICE_ROLE_KEY: "must-never-be-emitted"
  });

  assert.deepEqual(config, {
    mode: "SUPABASE",
    supabaseUrl: "https://example.supabase.co",
    supabasePublishableKey: "sb_publishable_example"
  });
  assert.equal(serializeRuntimeBackendConfig(config).includes("must-never-be-emitted"), false);
});

test("hosted runtime config fails closed for unsafe URL", () => {
  assert.deepEqual(buildRuntimeBackendConfig({
    DEEDOU_BACKEND_MODE: "SUPABASE",
    DEEDOU_SUPABASE_URL: "http://example.supabase.co",
    DEEDOU_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example"
  }), { mode: "LOCAL_DEMO" });
});

test("hosted runtime config rejects service-role JWT", () => {
  assert.deepEqual(buildRuntimeBackendConfig({
    DEEDOU_BACKEND_MODE: "SUPABASE",
    DEEDOU_SUPABASE_URL: "https://example.supabase.co",
    DEEDOU_SUPABASE_PUBLISHABLE_KEY: jwtForRole("service_role")
  }), { mode: "LOCAL_DEMO" });
});

test("hosted runtime config accepts legacy anon JWT for compatibility", () => {
  const key = jwtForRole("anon");
  assert.deepEqual(buildRuntimeBackendConfig({
    DEEDOU_BACKEND_MODE: "SUPABASE",
    DEEDOU_SUPABASE_URL: "https://example.supabase.co",
    DEEDOU_SUPABASE_PUBLISHABLE_KEY: key
  }), {
    mode: "SUPABASE",
    supabaseUrl: "https://example.supabase.co",
    supabasePublishableKey: key
  });
});
