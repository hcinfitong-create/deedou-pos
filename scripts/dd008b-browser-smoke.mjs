import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const AUTH_PASSWORD_MAX_BYTES = 64;
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY;
const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY || statusEnv.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.DB_URL || statusEnv.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!anonKey || !serviceRoleKey) {
  throw new Error("Supabase local anon/service-role keys were not available from `supabase status -o env`.");
}

const backendConfig = Object.freeze({
  mode: "SUPABASE",
  supabaseUrl: apiUrl,
  supabasePublishableKey: anonKey
});

const runId = `dd008b_browser_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const ids = Object.freeze({
  locationA: "deedou-demo",
  locationB: `${runId}_loc_b`,
  owner: `${runId}_owner`,
  cashier: `${runId}_cashier`,
  kitchen: `${runId}_kitchen`,
  inactive: `${runId}_inactive`,
  adminDevice: `${runId}_dev_admin`,
  cashierDevice: `${runId}_dev_cashier`,
  kitchenDevice: `${runId}_dev_kitchen`,
  cashierBDevice: `${runId}_dev_cashier_b`,
  revokedDevice: `${runId}_dev_revoked`
});
const deviceSecrets = Object.freeze({
  admin: secret("admin-device"),
  cashier: secret("cashier-device"),
  kitchen: secret("kitchen-device"),
  cashierB: secret("cashier-b-device"),
  revoked: secret("revoked-device")
});

const adminClient = createClient(apiUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const server = await startStaticServer(repoRoot);
const browser = await chromium.launch();
const consoleErrors = [];

try {
  const users = await provisionRuntimeFixture();
  await runLocalDemoSmoke(browser, server.url, consoleErrors);
  await runSupabaseSmoke(browser, server.url, users, consoleErrors);
  if (consoleErrors.length) {
    throw new Error(`Browser smoke captured app console errors:\n${consoleErrors.join("\n")}`);
  }

  console.log("DD-008B browser smoke passed");
  console.log("LOCAL_DEMO routes: customer, cashier, staff, bar, kitchen, dessert, admin");
  console.log("SUPABASE browser: signed-out QR, sign-in gate, cashier allow/admin deny, kitchen allow/cashier/payment/admin deny");
  console.log("SUPABASE browser: location B denied, inactive denied, wrong/revoked workstation denied, local logout returned to sign-in gate");
  console.log("SUPABASE browser: read-only/fail-closed route left legacy localStorage business state unchanged");
  console.log("zero app console errors");
} finally {
  await browser.close();
  await server.close();
}

async function provisionRuntimeFixture() {
  const users = {
    owner: await createRuntimeUser("owner"),
    cashier: await createRuntimeUser("cashier"),
    kitchen: await createRuntimeUser("kitchen"),
    inactive: await createRuntimeUser("inactive")
  };

  runPsql(`
begin;

insert into public.locations (id, name, timezone, currency)
values (${lit(ids.locationB)}, 'DD-008B Browser Smoke B', 'Asia/Saigon', 'VND')
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  (${lit(ids.owner)}, ${lit(users.owner.id)}::uuid, 'Browser Smoke Owner', true),
  (${lit(ids.cashier)}, ${lit(users.cashier.id)}::uuid, 'Browser Smoke Cashier', true),
  (${lit(ids.kitchen)}, ${lit(users.kitchen.id)}::uuid, 'Browser Smoke Kitchen', true),
  (${lit(ids.inactive)}, ${lit(users.inactive.id)}::uuid, 'Browser Smoke Inactive', false)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  (${lit(ids.owner)}, ${lit(ids.locationA)}, true),
  (${lit(ids.cashier)}, ${lit(ids.locationA)}, true),
  (${lit(ids.kitchen)}, ${lit(ids.locationA)}, true),
  (${lit(ids.inactive)}, ${lit(ids.locationA)}, true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  (${lit(ids.owner)}, ${lit(ids.locationA)}, 'OWNER', true),
  (${lit(ids.cashier)}, ${lit(ids.locationA)}, 'CASHIER', true),
  (${lit(ids.kitchen)}, ${lit(ids.locationA)}, 'KITCHEN', true),
  (${lit(ids.inactive)}, ${lit(ids.locationA)}, 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  (${lit(ids.adminDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Admin', 'ADMIN', public.hash_device_credential(${lit(deviceSecrets.admin)}), true, ${lit(ids.owner)}),
  (${lit(ids.cashierDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Cashier', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashier)}), true, ${lit(ids.owner)}),
  (${lit(ids.kitchenDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Kitchen', 'KDS_KITCHEN', public.hash_device_credential(${lit(deviceSecrets.kitchen)}), true, ${lit(ids.owner)}),
  (${lit(ids.cashierBDevice)}, ${lit(ids.locationB)}, 'Browser Smoke Cashier B', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashierB)}), true, ${lit(ids.owner)}),
  (${lit(ids.revokedDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Revoked', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.revoked)}), false, ${lit(ids.owner)})
on conflict (id) do nothing;

commit;
`);

  return users;
}

async function runLocalDemoSmoke(activeBrowser, baseUrl, errorSink) {
  const context = await activeBrowser.newContext();
  try {
    const routes = [
      ["customer", "/#/t/beach-a01-47VLmz"],
      ["cashier", "/#/cashier"],
      ["staff", "/#/staff"],
      ["bar", "/#/bar"],
      ["kitchen", "/#/kitchen"],
      ["dessert", "/#/dessert"],
      ["admin", "/#/admin"]
    ];

    for (const [label, hashRoute] of routes) {
      const page = await newObservedPage(context, `LOCAL_DEMO ${label}`, errorSink);
      await page.goto(`${baseUrl}/index.html?v=dd008b-local-smoke${hashRoute}`, { waitUntil: "domcontentloaded" });
      await assertAppReady(page, `LOCAL_DEMO ${label}`);
      assert.equal(await page.locator(".auth-gate").count(), 0, `LOCAL_DEMO ${label} should not show Supabase auth gate`);
      assertNotContains(await bodyText(page), "Cannot GET", `LOCAL_DEMO ${label}`);
      await settle();
      await page.close();
    }
  } finally {
    await context.close();
  }
}

async function runSupabaseSmoke(activeBrowser, baseUrl, users, errorSink) {
  await verifyPublicQrSignedOut(activeBrowser, baseUrl, errorSink);

  const cashierContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE cashier",
    deviceCredential: deviceSecrets.cashier,
    workstationMode: "CASHIER",
    locationId: ids.locationA
  });
  try {
    const cashierPage = await newObservedPage(cashierContext, "SUPABASE cashier", errorSink);
    await verifySignedOutGateNoFlash(cashierPage, `${baseUrl}/index.html?v=dd008b-supabase#/cashier`, "Cashier POS");
    await loginThroughGate(cashierPage, users.cashier, ids.locationA, "CASHIER");
    await expectReadOnlyAuthorized(cashierPage, "Cashier");
    await expectLegacyBusinessStateUnchanged(cashierPage);

    await cashierPage.goto(`${baseUrl}/index.html?v=dd008b-supabase#/admin`, { waitUntil: "domcontentloaded" });
    await expectDeniedGate(cashierPage, "cashier denied admin", ["DeeDou POS setup"]);

    await cashierPage.goto(`${baseUrl}/index.html?v=dd008b-supabase#/cashier`, { waitUntil: "domcontentloaded" });
    await expectReadOnlyAuthorized(cashierPage, "Cashier");
    await cashierPage.locator("[data-auth-logout]").first().click();
    await expectSignedOutGate(cashierPage, "cashier logout");
  } finally {
    await cashierContext.close();
  }

  const kitchenContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE kitchen",
    deviceCredential: deviceSecrets.kitchen,
    workstationMode: "KDS_KITCHEN",
    locationId: ids.locationA
  });
  try {
    const kitchenPage = await newObservedPage(kitchenContext, "SUPABASE kitchen", errorSink);
    await kitchenPage.goto(`${baseUrl}/index.html?v=dd008b-supabase#/kitchen`, { waitUntil: "domcontentloaded" });
    await loginThroughGate(kitchenPage, users.kitchen, ids.locationA, "KDS_KITCHEN");
    await expectReadOnlyAuthorized(kitchenPage, "Kitchen KDS");

    for (const [routeName, forbidden] of [
      ["cashier", ["Cashier POS"]],
      ["bar", ["Bar drinks queue"]],
      ["admin", ["DeeDou POS setup"]]
    ]) {
      await kitchenPage.goto(`${baseUrl}/index.html?v=dd008b-supabase#/${routeName}`, { waitUntil: "domcontentloaded" });
      await expectDeniedGate(kitchenPage, `kitchen denied ${routeName}`, forbidden);
    }
  } finally {
    await kitchenContext.close();
  }

  await expectDeniedLogin(activeBrowser, baseUrl, errorSink, {
    label: "SUPABASE location B denied",
    user: users.cashier,
    locationId: ids.locationB,
    workstationMode: "CASHIER",
    deviceCredential: deviceSecrets.cashierB,
    routeName: "cashier",
    forbidden: ["Cashier POS"]
  });

  await expectDeniedLogin(activeBrowser, baseUrl, errorSink, {
    label: "SUPABASE inactive denied",
    user: users.inactive,
    locationId: ids.locationA,
    workstationMode: "CASHIER",
    deviceCredential: deviceSecrets.cashier,
    routeName: "cashier",
    forbidden: ["Cashier POS"]
  });

  await expectDeniedLogin(activeBrowser, baseUrl, errorSink, {
    label: "SUPABASE wrong workstation denied",
    user: users.cashier,
    locationId: ids.locationA,
    workstationMode: "CASHIER",
    deviceCredential: `${runId}_wrong_device`,
    routeName: "cashier",
    forbidden: ["Cashier POS"]
  });

  await expectDeniedLogin(activeBrowser, baseUrl, errorSink, {
    label: "SUPABASE revoked workstation denied",
    user: users.cashier,
    locationId: ids.locationA,
    workstationMode: "CASHIER",
    deviceCredential: deviceSecrets.revoked,
    routeName: "cashier",
    forbidden: ["Cashier POS"]
  });
}

async function verifyPublicQrSignedOut(activeBrowser, baseUrl, errorSink) {
  const context = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE public QR",
    deviceCredential: "",
    workstationMode: "",
    locationId: ids.locationA
  });
  try {
    const page = await newObservedPage(context, "SUPABASE public QR", errorSink);
    await page.goto(`${baseUrl}/index.html?v=dd008b-supabase#/t/beach-a01-47VLmz`, { waitUntil: "domcontentloaded" });
    await assertAppReady(page, "SUPABASE public QR");
    assert.equal(await page.locator(".auth-gate").count(), 0, "public QR should not require staff sign-in");
    assertContains(await bodyText(page), "DeeDou", "public QR");
  } finally {
    await context.close();
  }
}

async function expectDeniedLogin(activeBrowser, baseUrl, errorSink, options) {
  const context = await createSupabaseContext(activeBrowser, options);
  try {
    const page = await newObservedPage(context, options.label, errorSink);
    await page.goto(`${baseUrl}/index.html?v=dd008b-supabase#/${options.routeName}`, { waitUntil: "domcontentloaded" });
    await loginThroughGate(page, options.user, options.locationId, options.workstationMode);
    await expectDeniedGate(page, options.label, options.forbidden || []);
  } finally {
    await context.close();
  }
}

async function createSupabaseContext(activeBrowser, options) {
  const context = await activeBrowser.newContext();
  await context.addInitScript(({ config, storage }) => {
    window.DEEDOU_BACKEND_CONFIG = config;
    window.__DEEDOU_BACKEND_CONFIG__ = config;
    Object.entries(storage).forEach(([key, value]) => {
      if (value) window.localStorage.setItem(key, value);
    });
  }, {
    config: backendConfig,
    storage: {
      deedou_device_credential: options.deviceCredential || "",
      deedou_workstation_mode: options.workstationMode || "",
      deedou_staff_location_id: options.locationId || ids.locationA
    }
  });
  return context;
}

async function newObservedPage(context, label, errorSink) {
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errorSink.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errorSink.push(`${label}: pageerror: ${error.message}`);
  });
  return page;
}

async function verifySignedOutGateNoFlash(page, targetUrl, privilegedText) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  assertNotContains(await bodyText(page), privilegedText, "signed-out route before auth restore");
  await expectSignedOutGate(page, "signed-out gate");
  assertNotContains(await bodyText(page), privilegedText, "signed-out route after auth restore");
}

async function expectSignedOutGate(page, label) {
  await page.locator("form[data-auth-login]").waitFor({ timeout: 20000 });
  await waitForNotChecking(page);
  await assertAppReady(page, label);
  assert.equal(await page.locator("[data-supabase-command]").count(), 0, `${label} should not expose read-only command surface`);
}

async function loginThroughGate(page, user, locationId, workstationMode) {
  await page.locator("form[data-auth-login]").waitFor({ timeout: 20000 });
  await page.locator('form[data-auth-login] input[name="email"]').fill(user.email);
  await page.locator('form[data-auth-login] input[name="password"]').fill(user.password);
  await page.locator('form[data-auth-login] input[name="locationId"]').fill(locationId);
  await page.locator('form[data-auth-login] select[name="workstationMode"]').selectOption(workstationMode);
  await page.locator('form[data-auth-login] button[type="submit"]').click();
}

async function expectReadOnlyAuthorized(page, routeLabel) {
  await page.locator("[data-supabase-command]").waitFor({ timeout: 25000 });
  await assertAppReady(page, `authorized ${routeLabel}`);
  const text = await bodyText(page);
  assertContains(text, "DD-008B", `authorized ${routeLabel}`);
  assertContains(text, routeLabel, `authorized ${routeLabel}`);
  assert.equal(await page.locator("form[data-auth-login]").count(), 0, `authorized ${routeLabel} should not remain on login form`);
}

async function expectDeniedGate(page, label, forbiddenTexts = []) {
  await page.locator(".auth-gate").waitFor({ timeout: 25000 });
  await page.locator("[data-auth-logout]").waitFor({ timeout: 25000 });
  await waitForNotChecking(page);
  await assertAppReady(page, label);
  assert.equal(await page.locator("[data-supabase-command]").count(), 0, `${label} should not expose fail-closed command button`);
  const text = await bodyText(page);
  assertContains(text, "Supabase Auth", label);
  forbiddenTexts.forEach((forbidden) => assertNotContains(text, forbidden, label));
}

async function waitForNotChecking(page) {
  const checkingText = "\u0110ang ki\u1ec3m tra quy\u1ec1n truy c\u1eadp.";
  await page.waitForFunction((text) => !document.body.innerText.includes(text), checkingText, { timeout: 25000 });
}

async function expectLegacyBusinessStateUnchanged(page) {
  const storageKey = "deedou_state";
  const sentinelState = JSON.stringify({
    cart: [{ id: "legacy-sentinel", qty: 1 }],
    orders: [],
    events: [],
    audit: [],
    sequence: 987,
    tableSessions: []
  });
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [storageKey, sentinelState]);
  await page.locator("[data-supabase-command]").click();
  await page.waitForFunction(() => document.body.innerText.includes("Local demo storage was not mutated."), null, { timeout: 10000 });
  const stored = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
  assert.equal(stored, sentinelState, "SUPABASE read-only command must not mutate legacy localStorage business state");
}

async function assertAppReady(page, label) {
  await page.locator("#app").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const text = document.querySelector("#app")?.innerText || "";
    return text.trim().length > 20;
  }, null, { timeout: 15000 });
  assertNotContains(await bodyText(page), "Cannot GET", label);
}

async function bodyText(page) {
  await settle();
  return page.locator("body").innerText();
}

async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.replace(/^\/+/, "");
      const filePath = resolve(root, relativePath);
      if (!filePath.startsWith(root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const buffer = await readFile(filePath);
      response.writeHead(200, { "content-type": contentTypeFor(filePath) });
      response.end(buffer);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

function contentTypeFor(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function createRuntimeUser(kind) {
  const email = `${runId}_${kind}@example.invalid`;
  const password = runtimeAuthPassword(`${kind}-password`);
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { dd008b_browser_smoke: runId, kind }
  });
  if (error || !data.user?.id) {
    throw new Error(`Failed to create browser smoke runtime user ${kind}: ${error?.message || "missing user"}`);
  }
  return { id: data.user.id, email, password };
}

function runPsql(sql) {
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function parseEnvOutput(output) {
  return output.split(/\r?\n/).reduce((acc, line) => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) return acc;
    acc[match[1]] = match[2].replace(/^"|"$/g, "");
    return acc;
  }, {});
}

function runtimeAuthPassword(label) {
  const password = `Dd008B-${label}-${randomBytes(24).toString("base64url")}`;
  assert(
    Buffer.byteLength(password, "utf8") <= AUTH_PASSWORD_MAX_BYTES,
    `runtime Auth password exceeds ${AUTH_PASSWORD_MAX_BYTES} UTF-8 bytes`
  );
  return password;
}

function secret(label) {
  return `${runId}_${label}_${randomUUID()}_${randomUUID()}`;
}

function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertContains(text, expected, label) {
  assert(text.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
}

function assertNotContains(text, unexpected, label) {
  assert(!text.includes(unexpected), `${label} should not include ${JSON.stringify(unexpected)}`);
}

function settle() {
  return new Promise((resolveSettle) => setTimeout(resolveSettle, 250));
}
