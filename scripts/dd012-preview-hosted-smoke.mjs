import { randomBytes, randomUUID } from "node:crypto";
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
if (prNumber !== 42) throw new Error(`DD-012 hosted gate must run on PR #42, got #${prNumber}`);

const previewUrl = await discoverReadyVercelPreview();
await waitForPreviewRuntimeConfig();

const runId = `dd012_hosted_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const locationId = `dd012-hosted-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
const productId = `dd012-hosted-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
const tableId = `${runId}_table`;
const qrToken = `dd012_${randomBytes(24).toString("base64url")}`;
const account = {
  email: `deedou.smoke.${runId}.owner@gmail.com`,
  password: `Dd012!${randomBytes(20).toString("base64url")}Aa1`,
  deviceSecret: `${runId}_admin_device_${randomUUID().replace(/-/g, "")}_${randomUUID().replace(/-/g, "")}`
};
const secrets = [account.password, account.deviceSecret, qrToken];
let browser;
let setupComplete = false;
const contexts = [];

try {
  const setup = await callBootstrap("setup", {
    runId,
    locationId,
    account,
    table: { id: tableId, code: "H01", zone: "HOSTED", qrToken }
  });
  assert(setup.ok === true, `bootstrap setup failed: ${JSON.stringify(setup)}`);
  assert(Number(setup.diagnostic?.locations || 0) === 1, "bootstrap did not create one location");
  assert(Number(setup.diagnostic?.authUsers || 0) === 1, "bootstrap did not create one auth user");
  assert(Number(setup.diagnostic?.tables || 0) === 1, "bootstrap did not create one table");
  assert(Number(setup.diagnostic?.devices || 0) === 1, "bootstrap did not create one ADMIN device");
  setupComplete = true;
  console.log("DD012_STAGING_BOOTSTRAP=PASS");

  const ownerClient = runtimeClient(memoryStorage());
  await login(ownerClient);
  const directWrite = await ownerClient.from("products").insert({
    id: `${productId}-direct`,
    location_id: locationId,
    kind: "DRINK",
    category: "drink-coffee",
    name_vi: "Direct write must fail",
    name_en: "Direct write must fail",
    price_vnd: 1,
    station_code: "BAR_COFFEE",
    periods: ["morning"]
  });
  assert(Boolean(directWrite.error), "authenticated direct products INSERT unexpectedly succeeded");
  console.log("DD012_STAGING_DIRECT_WRITE_DENIAL=PASS");

  browser = await chromium.launch({ headless: true });
  const adminContext = await previewContext(account.deviceSecret, "ADMIN");
  contexts.push(adminContext);
  const adminPage = await adminContext.newPage();
  trackErrors(adminPage, "admin");
  await adminPage.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  await adminPage.locator("[data-auth-login]").waitFor({ timeout: 30_000 });
  await sleep(500);
  assert(await adminPage.locator("[data-dd008d-admin-menu]").count() === 0, "catalog UI mounted before Admin authentication");
  console.log("DD012_PREVIEW_PREAUTH_GUARD=PASS");

  await loginAdminPage(adminPage);
  const catalog = adminPage.locator("[data-dd008d-admin-menu]");
  await catalog.waitFor({ timeout: 30_000 });
  await catalog.locator("[data-dd012-create-form]").waitFor({ timeout: 30_000 });
  await waitFor(async () => /Loaded 0 products from PostgreSQL|Chưa có sản phẩm/i.test(await catalog.innerText().catch(() => "")), "empty authoritative catalog", 30_000);

  const create = catalog.locator("[data-dd012-create-form]");
  await create.locator('[data-dd012-create="id"]').fill(productId);
  await create.locator('[data-dd012-create="kind"]').selectOption("DRINK");
  await create.locator('[data-dd012-create="category"]').selectOption("drink-coffee");
  await create.locator('[data-dd012-create="nameVi"]').fill("Cà phê DD012 Hosted");
  await create.locator('[data-dd012-create="nameEn"]').fill("DD012 Hosted Coffee");
  await create.locator('[data-dd012-create="priceVnd"]').fill("42000");
  await create.locator('[data-dd012-create="stationCode"]').fill("BAR_COFFEE");
  await create.locator('[data-dd012-create="descVi"]').fill("Hosted staging acceptance");
  await create.locator('[data-dd012-create="descEn"]').fill("Hosted staging acceptance");
  await create.locator("[data-dd012-create-product]").click();

  const productCard = catalog.locator(`[data-dd012-product="${productId}"]`);
  await productCard.waitFor({ timeout: 30_000 });
  await waitFor(async () => (await productCard.innerText().catch(() => "")).includes("Cà phê DD012 Hosted"), "created product in Admin", 30_000);
  console.log("DD012_PREVIEW_ADMIN_CREATE=PASS");

  const customerContext = await previewContext("", "");
  contexts.push(customerContext);
  const customerPage = await customerContext.newPage();
  trackErrors(customerPage, "customer");
  await customerPage.goto(`${previewUrl}/#/t/${encodeURIComponent(qrToken)}`, { waitUntil: "domcontentloaded" });
  await waitFor(async () => (await customerPage.locator("body").innerText()).includes("Cà phê DD012 Hosted"), "created product on public QR menu", 30_000);
  console.log("DD012_PREVIEW_PUBLIC_CREATE_VISIBILITY=PASS");

  await productCard.locator('[data-dd012-field="nameVi"]').fill("Cà phê DD012 Hosted Updated");
  await productCard.locator('[data-dd012-field="nameEn"]').fill("DD012 Hosted Coffee Updated");
  await productCard.locator('[data-dd012-field="priceVnd"]').fill("47000");
  await productCard.locator(`[data-dd012-save-product="${productId}"]`).click();
  await waitFor(async () => {
    const text = await catalog.locator(`[data-dd012-product="${productId}"]`).innerText().catch(() => "");
    return text.includes("Cà phê DD012 Hosted Updated") && /47[.\s]?000/.test(text);
  }, "updated product in Admin", 30_000);
  console.log("DD012_PREVIEW_ADMIN_UPDATE=PASS");

  await customerPage.reload({ waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const text = await customerPage.locator("body").innerText();
    return text.includes("Cà phê DD012 Hosted Updated") && !text.includes("Cà phê DD012 Hosted\n");
  }, "updated product on public QR menu", 30_000);
  console.log("DD012_PREVIEW_PUBLIC_UPDATE_VISIBILITY=PASS");

  const publicSnapshot = firstRow(await rpc(ownerClient, "dd008c_get_public_table_snapshot", { p_qr_token: qrToken }));
  assert(publicSnapshot?.ok === true, `public snapshot failed: ${publicSnapshot?.reason || "unknown"}`);
  const product = (publicSnapshot.payload?.products || []).find((item) => item.id === productId);
  assert(product?.vi === "Cà phê DD012 Hosted Updated" && Number(product?.price) === 47000, "public snapshot did not reflect authoritative update");
  console.log("DD012_STAGING_PUBLIC_PROJECTION=PASS");

  assertNoPageErrors(adminPage, customerPage);
  const diag = await callBootstrap("diagnose", { runId, locationId });
  assert(diag.ok === true, "bootstrap diagnose failed");
  assert(Number(diag.diagnostic?.products || 0) === 1, `expected one product before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.audits || 0) >= 2, `expected create/update audit evidence: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.dedupe || 0) >= 2, `expected create/update idempotency evidence: ${JSON.stringify(diag.diagnostic || {})}`);
  console.log(`DD012_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD012_HOSTED_RUN_ID=${runId}`);
  console.log("DD-012 hosted staging catalog smoke passed");
} catch (error) {
  console.error(sanitize(String(error?.stack || error)));
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (setupComplete) {
    const cleanup = await callBootstrap("cleanup", { runId, locationId }).catch((error) => ({ ok: false, reason: sanitize(error?.message || error) }));
    const d = cleanup?.diagnostic || {};
    console.log(`DD012_STAGING_CLEANUP=${JSON.stringify({ ok: cleanup?.ok === true, diagnostic: d, reason: cleanup?.reason || "" })}`);
    const mustBeZero = [d.locations, d.products, d.tables, d.staffProfiles, d.staffLocations, d.staffRoles, d.devices, d.audits, d.dedupe, d.refreshHints, d.authUsers];
    if (!cleanup?.ok || mustBeZero.some((value) => Number(value || 0) !== 0)) process.exitCode = 1;
  }
}

async function login(client) {
  const { data, error } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (error || !data.session?.access_token) throw new Error(`owner login failed: ${error?.message || "missing session"}`);
}

async function loginAdminPage(page) {
  const form = page.locator("[data-auth-login]");
  await waitFor(async () => !(await page.locator("body").innerText()).includes("Đang kiểm tra quyền truy cập."), "Admin auth gate ready", 30_000);
  await form.locator('input[name="email"]').fill(account.email);
  await form.locator('input[name="password"]').fill(account.password);
  await form.locator('input[name="locationId"]').fill(locationId);
  await form.locator('select[name="workstationMode"]').selectOption("ADMIN");
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("[data-auth-login]"), null, { timeout: 30_000 });
}

function runtimeClient(storage) {
  return createClient(apiUrl, publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage } });
}

async function previewContext(deviceSecret, mode) {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.route(`${previewUrl}/**`, async (route) => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders() } }));
  if (deviceSecret) {
    await context.addInitScript(({ credential, workstationMode, targetLocation }) => {
      localStorage.setItem("deedou_device_credential", credential);
      localStorage.setItem("deedou_workstation_mode", workstationMode);
      localStorage.setItem("deedou_staff_location_id", targetLocation);
    }, { credential: deviceSecret, workstationMode: mode, targetLocation: locationId });
  }
  return context;
}

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
function firstRow(data) { return Array.isArray(data) ? data[0] : data; }

async function callBootstrap(action, payload) {
  const token = await githubOidcToken();
  const response = await fetch(bootstrapUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ action, ...payload })
  });
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

function memoryStorage() {
  const store = new Map();
  return { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
}
function bypassHeaders() { return { "x-vercel-protection-bypass": vercelBypassSecret, "cache-control": "no-cache" }; }
function trackErrors(page, label) { page.__label = label; page.__errors = []; page.on("pageerror", (e) => page.__errors.push(`pageerror:${sanitize(e?.message || e)}`)); page.on("console", (m) => { if (m.type() === "error") page.__errors.push(`console:${sanitize(m.text())}`); }); }
function assertNoPageErrors(...pages) { const failures = pages.flatMap((page) => (page.__errors || []).map((error) => `${page.__label}:${error}`)); if (failures.length) throw new Error(`browser errors:\n${failures.join("\n")}`); }
function sanitize(value) { let out = String(value || "").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]"); for (const secret of secrets.filter(Boolean)) out = out.split(secret).join("[SECRET_REDACTED]"); return out.slice(0, 1000); }
async function waitFor(fn, label, timeout = 20_000) { const started = Date.now(); let last; while (Date.now() - started < timeout) { try { if (await fn()) return; } catch (error) { last = error; } await sleep(200); } throw new Error(`Timeout waiting for ${label}${last ? `: ${sanitize(last?.message || last)}` : ""}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function requireEnv(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
