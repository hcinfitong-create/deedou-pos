import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const repo = process.env.GITHUB_REPOSITORY || "hcinfitong-create/deedou-pos";
const githubToken = requireEnv("GITHUB_TOKEN");
const prNumber = Number(requireEnv("DEEDOU_PR_NUMBER"));
const headSha = requireEnv("DEEDOU_HEAD_SHA");
const apiUrl = requireEnv("DEEDOU_HOSTED_SUPABASE_URL").replace(/\/+$/, "");
const publishableKey = requireEnv("DEEDOU_HOSTED_SUPABASE_PUBLISHABLE_KEY");
const bootstrapUrl = requireEnv("DEEDOU_HOSTED_BOOTSTRAP_URL");
const vercelBypassSecret = requireEnv("VERCEL_AUTOMATION_BYPASS_SECRET");
if (prNumber !== 38) throw new Error(`DD-011 hosted gate must run on PR #38, got #${prNumber}`);

const previewUrl = await discoverReadyVercelPreview();
await waitForPreviewRuntimeConfig();
await verifyPreviewSecuritySurface();

const runId = `dd011_hosted_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const locationId = `dd011-hosted-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
const accounts = {
  owner: account("owner"),
  manager: account("manager"),
  cashier: account("cashier"),
  target: account("target")
};
const secrets = Object.values(accounts).flatMap((item) => [item.password, item.deviceSecret]);
let browser;
let setupComplete = false;
const contexts = [];

try {
  const setup = await callBootstrap("setup", { runId, locationId, accounts: Object.values(accounts) });
  assert(setup.ok === true, `bootstrap setup failed: ${JSON.stringify(setup)}`);
  setupComplete = true;
  assert(Number(setup.diagnostic?.locations || 0) === 1, "bootstrap did not create exactly one location");
  assert(Number(setup.diagnostic?.authUsers || 0) === 4, "bootstrap did not create exactly four auth users");
  console.log("DD011_STAGING_BOOTSTRAP=PASS");

  const ownerStorage = memoryStorage();
  const ownerClient = runtimeClient(ownerStorage);
  await login(ownerClient, accounts.owner);
  await assertAal(ownerClient, "aal1", "owner password login starts at AAL1");

  const aal1Denied = await rpc(ownerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: staffId("target"),
    p_location_id: locationId,
    p_role_id: "CASHIER",
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: accounts.owner.deviceSecret
  });
  assertRow(aal1Denied, false, "MFA_REQUIRED", "AAL1 privileged mutation");
  console.log("DD011_STAGING_AAL1_DENIAL=PASS");

  const ownerTotp = await promoteSessionToAal2(ownerClient, "owner");
  await assertAal(ownerClient, "aal2", "owner TOTP verification promotes to AAL2");
  console.log("DD011_STAGING_TOTP_AAL2=PASS");

  const wrongMode = await rpc(ownerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: staffId("target"),
    p_location_id: locationId,
    p_role_id: "CASHIER",
    p_current_workstation_mode: "CASHIER",
    p_current_device_credential: accounts.cashier.deviceSecret
  });
  assertRow(wrongMode, false, "DEVICE_MODE_DENIED", "AAL2 still enforces workstation mode");

  const assigned = await rpc(ownerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: staffId("target"),
    p_location_id: locationId,
    p_role_id: "CASHIER",
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: accounts.owner.deviceSecret
  });
  assertRow(assigned, true, "", "AAL2 OWNER role assignment");

  const registered = firstRow(await rpc(ownerClient, "register_workstation_device", {
    p_location_id: locationId,
    p_label: "DD011 Hosted Runtime Cashier",
    p_mode: "CASHIER",
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: accounts.owner.deviceSecret
  }));
  assert(registered?.ok === true, `device registration failed: ${registered?.reason || "unknown"}`);
  assert(typeof registered.device_credential === "string" && registered.device_credential.length >= 40, "server-issued credential missing entropy");
  secrets.push(registered.device_credential);

  const newDeviceAllowed = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: registered.device_credential
  });
  assertAuthz(newDeviceAllowed, true, "", "new device credential");

  const rotated = firstRow(await rpc(ownerClient, "dd011_rotate_workstation_device", {
    p_location_id: locationId,
    p_device_id: registered.device_id,
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: accounts.owner.deviceSecret
  }));
  assert(rotated?.ok === true && rotated.device_credential !== registered.device_credential, `device rotation failed: ${rotated?.reason || "unknown"}`);
  secrets.push(rotated.device_credential);

  const oldDenied = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: registered.device_credential
  });
  assertAuthz(oldDenied, false, "DEVICE_UNREGISTERED", "old credential after rotation");

  const rotatedAllowed = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: rotated.device_credential
  });
  assertAuthz(rotatedAllowed, true, "", "rotated credential");

  const revoked = await rpc(ownerClient, "revoke_workstation_device", {
    p_location_id: locationId,
    p_device_id: registered.device_id,
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: accounts.owner.deviceSecret
  });
  assertRow(revoked, true, "", "revoke rotated workstation");

  const revokedDenied = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: rotated.device_credential
  });
  assertAuthz(revokedDenied, false, "DEVICE_UNREGISTERED", "revoked credential");
  console.log("DD011_STAGING_DEVICE_LIFECYCLE=PASS");

  const managerClient = runtimeClient(memoryStorage());
  await login(managerClient, accounts.manager);
  await promoteSessionToAal2(managerClient, "manager");
  const managerEscalation = await rpc(managerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: staffId("target"),
    p_location_id: locationId,
    p_role_id: "OWNER",
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: accounts.owner.deviceSecret
  });
  assertRow(managerEscalation, false, "PRIVILEGE_CEILING_EXCEEDED", "MANAGER cannot grant OWNER");

  const cashierClient = runtimeClient(memoryStorage());
  await login(cashierClient, accounts.cashier);
  const copiedAdminCredential = await rpc(cashierClient, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "devices.manage",
    p_workstation_mode: "ADMIN",
    p_device_credential: accounts.owner.deviceSecret
  });
  assertAuthz(copiedAdminCredential, false, "PERMISSION_DENIED", "copied ADMIN credential does not elevate CASHIER");
  console.log("DD011_STAGING_PRIVILEGE_BOUNDARIES=PASS");

  browser = await chromium.launch({ headless: true });
  const ownerContext = await previewContext(accounts.owner, "ADMIN");
  contexts.push(ownerContext);
  const page = await ownerContext.newPage();
  trackErrors(page, "owner-admin");

  await page.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  const loginForm = page.locator("[data-auth-login]");
  await loginForm.waitFor({ timeout: 30_000 });
  await page.locator("[data-dd011-device-activation]").waitFor({ timeout: 20_000 });
  console.log("DD011_PREVIEW_DEVICE_ACTIVATION_UI=PASS");

  await loginAdminPage(page, accounts.owner);
  const panel = page.locator("[data-dd011-security-admin]");
  await panel.waitFor({ timeout: 30_000 });
  await panel.locator("[data-dd011-refresh]").click();
  await waitFor(async () => /Current AAL:\s*aal1/i.test(await panel.innerText().catch(() => "")), "browser AAL1 security state", 30_000);
  await panel.locator("[data-dd011-mfa-challenge]").waitFor({ timeout: 30_000 });
  const panelText = await panel.innerText();
  assert(panelText.includes(accounts.target.email), "staff admin UI did not list target fixture");
  assert(/Registered workstations/i.test(panelText), "device admin UI missing");
  console.log("DD011_PREVIEW_SECURITY_ADMIN_UI=PASS");

  const code = generateTotp(ownerTotp.secret);
  secrets.push(code, ownerTotp.secret);
  const challengeForm = panel.locator("[data-dd011-mfa-challenge]");
  await challengeForm.locator('input[name="code"]').fill(code);
  await challengeForm.locator('button[type="submit"]').click();
  await waitFor(async () => /Current AAL:\s*aal2/i.test(await panel.innerText().catch(() => "")), "browser TOTP AAL2", 30_000);
  assert((await panel.innerText()).includes("AAL2 VERIFIED"), "browser UI did not display AAL2 VERIFIED");
  console.log("DD011_PREVIEW_BROWSER_TOTP=PASS");

  const registerForm = panel.locator("[data-dd011-register-device]");
  await registerForm.locator('input[name="label"]').fill("Hosted UI Cashier 2");
  await registerForm.locator('select[name="mode"]').selectOption("CASHIER");
  await registerForm.locator('button[type="submit"]').click();
  await waitFor(async () => /One-time workstation credential/i.test(await panel.innerText().catch(() => "")), "one-time device credential UI", 30_000);
  console.log("DD011_PREVIEW_UI_DEVICE_REGISTER=PASS");

  assertNoPageErrors(page);
  const diag = await callBootstrap("diagnose", { runId, locationId });
  assert(diag.ok === true, "bootstrap diagnose failed");
  assert(Number(diag.diagnostic?.audits || 0) >= 4, `expected security audit evidence, got ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.devices || 0) >= 3, `expected registered devices before cleanup, got ${JSON.stringify(diag.diagnostic || {})}`);
  console.log(`DD011_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD011_HOSTED_RUN_ID=${runId}`);
  console.log("DD-011 hosted staging security smoke passed");
} catch (error) {
  console.error(sanitize(String(error?.stack || error)));
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (setupComplete) {
    const cleanup = await callBootstrap("cleanup", { runId, locationId }).catch((error) => ({ ok: false, reason: sanitize(error?.message || error) }));
    console.log(`DD011_STAGING_CLEANUP=${JSON.stringify({ ok: cleanup?.ok === true, diagnostic: cleanup?.diagnostic || {}, reason: cleanup?.reason || "" })}`);
    const d = cleanup?.diagnostic || {};
    if (!cleanup?.ok || [d.locations, d.staffLocations, d.devices, d.audits, d.authUsers].some((value) => Number(value || 0) !== 0)) process.exitCode = 1;
  }
}

async function verifyPreviewSecuritySurface() {
  const response = await fetch(`${previewUrl}/`, { headers: bypassHeaders(), redirect: "follow" });
  assert(response.ok, `Preview root HTTP ${response.status}`);
  const csp = String(response.headers.get("content-security-policy") || "");
  assert(csp.includes("default-src 'self'"), `CSP missing self default: ${csp}`);
  assert(csp.includes("object-src 'none'"), `CSP missing object-src none: ${csp}`);
  assert(csp.includes("frame-ancestors 'none'"), `CSP missing frame-ancestors none: ${csp}`);
  assert(!/cdn\.jsdelivr\.net/i.test(csp), "CSP still allows jsDelivr");
  assert(String(response.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff", "nosniff header missing");
  assert(String(response.headers.get("x-frame-options") || "").toUpperCase() === "DENY", "X-Frame-Options DENY missing");
  assert(String(response.headers.get("referrer-policy") || "").toLowerCase() === "no-referrer", "Referrer-Policy no-referrer missing");
  const html = await response.text();
  assert(!/cdn\.jsdelivr\.net/i.test(html), "Preview HTML still references jsDelivr");
  assert(/vendor\/supabase\.js/i.test(html), "Preview HTML missing same-origin Supabase vendor");

  const vendor = await fetch(`${previewUrl}/vendor/supabase.js`, { headers: bypassHeaders(), redirect: "follow" });
  assert(vendor.ok && vendor.url.startsWith(previewUrl), `same-origin Supabase vendor unavailable: ${vendor.status} ${vendor.url}`);
  const vendorBody = await vendor.text();
  assert(vendorBody.length > 50_000, `Supabase vendor unexpectedly small: ${vendorBody.length}`);
  console.log("DD011_PREVIEW_CSP_VENDOR=PASS");
}

async function login(client, spec) {
  const { data, error } = await client.auth.signInWithPassword({ email: spec.email, password: spec.password });
  if (error || !data.session?.access_token) throw new Error(`login ${spec.name}: ${error?.message || "missing session"}`);
}

async function loginAdminPage(page, spec) {
  const form = page.locator("[data-auth-login]");
  await waitFor(async () => !(await page.locator("body").innerText()).includes("Đang kiểm tra quyền truy cập."), "Admin auth gate ready", 30_000);
  await form.locator('input[name="email"]').fill(spec.email);
  await form.locator('input[name="password"]').fill(spec.password);
  await form.locator('input[name="locationId"]').fill(locationId);
  await form.locator('select[name="workstationMode"]').selectOption("ADMIN");
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("[data-auth-login]"), null, { timeout: 30_000 });
}

async function promoteSessionToAal2(client, label) {
  const enrollment = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `DeeDou DD011 Hosted ${label} ${runId}` });
  if (enrollment.error || !enrollment.data?.id || !enrollment.data?.totp?.secret) throw new Error(`${label} TOTP enrollment failed: ${enrollment.error?.message || "missing factor/secret"}`);
  const factorId = enrollment.data.id;
  const secret = enrollment.data.totp.secret;
  secrets.push(secret);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const challenge = await client.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data?.id) throw new Error(`${label} TOTP challenge failed: ${challenge.error?.message || "missing challenge id"}`);
    const code = generateTotp(secret);
    secrets.push(code);
    const verification = await client.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    if (!verification.error) return { factorId, secret };
    lastError = verification.error;
    if (attempt === 0) await sleep(1100);
  }
  throw new Error(`${label} TOTP verification failed: ${lastError?.message || "unknown"}`);
}

async function assertAal(client, expected, label) {
  const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw new Error(`${label}: ${error.message}`);
  assert(data?.currentLevel === expected, `${label}: expected ${expected}, got ${data?.currentLevel || "null"}`);
}

function generateTotp(base32Secret, nowMs = Date.now()) {
  const key = decodeBase32(base32Secret);
  const counter = BigInt(Math.floor(nowMs / 1000 / 30));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff)) >>> 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid base32 TOTP secret");
    bits = (bits << 5) | index;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  if (!bytes.length) throw new Error("empty TOTP secret");
  return Buffer.from(bytes);
}

function runtimeClient(storage) {
  return createClient(apiUrl, publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage } });
}

async function previewContext(spec, mode) {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.route(`${previewUrl}/**`, async (route) => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders() } }));
  await context.addInitScript(({ deviceSecret, mode, locationId }) => {
    localStorage.setItem("deedou_device_credential", deviceSecret);
    localStorage.setItem("deedou_workstation_mode", mode);
    localStorage.setItem("deedou_staff_location_id", locationId);
  }, { deviceSecret: spec.deviceSecret, mode, locationId });
  return context;
}

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

function assertRow(data, ok, reason, label) {
  const row = firstRow(data);
  assert(row?.ok === ok && (reason ? row?.reason === reason : true), `${label}: got ${row?.ok}/${row?.reason}`);
}
function assertAuthz(data, ok, reason, label) { assertRow(data, ok, reason, label); }
function firstRow(data) { return Array.isArray(data) ? data[0] : data; }
function staffId(name) { return `${runId}_${name}`; }

async function callBootstrap(action, payload) {
  const token = await githubOidcToken();
  const response = await fetch(bootstrapUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ action, ...payload }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`hosted bootstrap HTTP ${response.status}: ${body?.reason || "UNKNOWN"}`);
  return body;
}

async function githubOidcToken() {
  const url = new URL(requireEnv("ACTIONS_ID_TOKEN_REQUEST_URL"));
  url.searchParams.set("audience", "deedou-hosted-smoke");
  const response = await fetch(url, { headers: { authorization: `Bearer ${requireEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` } });
  if (!response.ok) throw new Error(`GitHub OIDC request failed: ${response.status}`);
  const body = await response.json();
  if (!body?.value) throw new Error("GitHub OIDC token missing");
  return body.value;
}

async function discoverReadyVercelPreview() {
  const [owner, name] = repo.split("/");
  const started = Date.now();
  let last = "not attempted";
  while (Date.now() - started < 180_000) {
    try {
      const status = await githubFetch(`https://api.github.com/repos/${owner}/${name}/commits/${headSha}/status`);
      const vercel = (status.statuses || []).find((entry) => entry.context === "Vercel");
      if (vercel?.state === "success") {
        const comments = await githubFetch(`https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`);
        const comment = [...comments].reverse().find((item) => item?.user?.login === "vercel[bot]" && /\[Preview\]\(https:\/\//.test(item.body || ""));
        const match = comment?.body?.match(/\[Preview\]\((https:\/\/[^)]+\.vercel\.app)\)/);
        if (match?.[1]) return match[1].replace(/\/+$/, "");
        last = "Vercel success but Preview URL missing";
      } else last = `Vercel status=${vercel?.state || "missing"}`;
    } catch (error) { last = sanitize(error?.message || error); }
    await sleep(2_000);
  }
  throw new Error(`Unable to discover Ready Vercel Preview: ${last}`);
}

async function waitForPreviewRuntimeConfig() {
  const started = Date.now();
  let last = "not attempted";
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch(`${previewUrl}/api/runtime-config`, { headers: bypassHeaders() });
      const body = await response.text();
      const safe = !/service_role|sb_secret_|SUPABASE_SECRET|DATABASE_URL|DB_PASSWORD|JWT_SECRET|PRIVATE KEY/i.test(body);
      const expected = body.includes('"mode":"SUPABASE"') && body.includes(apiUrl) && body.includes(publishableKey);
      if (response.ok && safe && expected) return;
      last = `status=${response.status} safe=${safe} expected=${expected}`;
    } catch (error) { last = sanitize(error?.message || error); }
    await sleep(2_000);
  }
  throw new Error(`Preview runtime config not ready: ${last}`);
}

async function githubFetch(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

function account(name) {
  const nonce = randomUUID().replace(/-/g, "");
  return {
    name,
    email: `deedou.smoke.${runId}.${name}@gmail.com`,
    password: `Dd011!${randomBytes(20).toString("base64url")}Aa1`,
    deviceSecret: `${runId}_${name}_device_${nonce}_${randomUUID().replace(/-/g, "")}`
  };
}

function memoryStorage() {
  const store = new Map();
  return { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
}
function bypassHeaders() { return { "x-vercel-protection-bypass": vercelBypassSecret, "cache-control": "no-cache" }; }
function trackErrors(page, label) { page.__label = label; page.__errors = []; page.on("pageerror", (e) => page.__errors.push(`pageerror:${sanitize(e?.message || e)}`)); page.on("console", (m) => { if (m.type() === "error") page.__errors.push(`console:${sanitize(m.text())}`); }); }
function assertNoPageErrors(...pages) { const failures = pages.flatMap((page) => (page.__errors || []).map((error) => `${page.__label}:${error}`)); if (failures.length) throw new Error(`browser errors:\n${failures.join("\n")}`); }
function sanitize(value) { let out = String(value || "").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]"); for (const secret of secrets.filter(Boolean)) out = out.split(secret).join("[SECRET_REDACTED]"); return out.slice(0, 800); }
async function waitFor(fn, label, timeout = 20_000) { const started = Date.now(); let last; while (Date.now() - started < timeout) { try { if (await fn()) return; } catch (error) { last = error; } await sleep(200); } throw new Error(`Timeout waiting for ${label}${last ? `: ${sanitize(last?.message || last)}` : ""}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function requireEnv(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
