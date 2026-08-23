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
if (prNumber !== 46) throw new Error(`DD-012C hosted gate must run on PR #46, got #${prNumber}`);

const previewUrl = await discoverReadyVercelPreview();
await waitForPreviewRuntimeConfig();

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
const runId = `dd012c_hosted_${suffix}`.replace(/-/g, "_");
const locationId = `dd012c-hosted-${suffix}`;
const productId = `dd012c-combo-${suffix}`;
const componentId = `${productId}-main`;
const tableId = `${runId}_table`;
const qrToken = `dd012c_${randomBytes(24).toString("base64url")}`;
const account = {
  email: `deedou.smoke.${runId}.owner@gmail.com`,
  password: `Dd012c!${randomBytes(20).toString("base64url")}Aa1`
};
const secrets = [account.password, qrToken];
let browser;
let setupComplete = false;
const contexts = [];

try {
  const setup = await callBootstrap("setup", {
    runId,
    locationId,
    account,
    table: { id: tableId, code: "C12", zone: "DD012C", qrToken }
  });
  assert(setup.ok === true, `bootstrap setup failed: ${JSON.stringify(setup)}`);
  assert(Number(setup.diagnostic?.locations || 0) === 1, "bootstrap did not create one location");
  assert(Number(setup.diagnostic?.authUsers || 0) === 1, "bootstrap did not create one auth user");
  assert(Number(setup.diagnostic?.tables || 0) === 1, "bootstrap did not create one table");
  setupComplete = true;
  console.log("DD012C_STAGING_BOOTSTRAP=PASS");

  const ownerClient = runtimeClient(memoryStorage());
  await login(ownerClient);

  browser = await chromium.launch({ headless: true });
  const adminContext = await previewContext();
  contexts.push(adminContext);
  const adminPage = await adminContext.newPage();
  trackErrors(adminPage, "admin");
  await adminPage.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  await adminPage.locator("[data-auth-login]").waitFor({ timeout: 30_000 });
  await sleep(500);
  assert(await adminPage.locator("[data-dd012c-admin-components]").count() === 0, "DD-012C component UI mounted before Admin authentication");
  console.log("DD012C_PREVIEW_PREAUTH_GUARD=PASS");

  await loginThroughGate(adminPage, account.email, account.password, "ADMIN");
  await enrollOwnerTotpThroughUi(adminPage);
  await bootstrapOwnerDeviceThroughUi(adminPage);
  await assertBackendDeviceSessionCookie(adminContext, "Owner");
  await assertNoBrowserDeviceCredential(adminPage, "Owner");
  console.log("DD012C_PREVIEW_OWNER_BOOTSTRAP_HTTPONLY=PASS");

  const ownerStatus = await securityStatusFromPage(adminPage);
  assert(
    ownerStatus.ok === true &&
      ownerStatus.isOwner === true &&
      ownerStatus.device?.active === true &&
      ownerStatus.device?.locationId === locationId &&
      ownerStatus.device?.workstationMode === "ADMIN",
    `Owner status/device not active: ${JSON.stringify(safeStatus(ownerStatus))}`
  );

  await adminPage.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  const catalog = adminPage.locator("[data-dd008d-admin-menu]");
  await catalog.waitFor({ timeout: 30_000 });
  console.log("DD012C_PREVIEW_ADMIN_CATALOG_MOUNT=PASS");
  const create = catalog.locator("[data-dd012-create-form]");
  await create.waitFor({ timeout: 30_000 });
  await create.locator('[data-dd012-create="id"]').fill(productId);
  await create.locator('[data-dd012-create="kind"]').selectOption("FOOD");
  await create.locator('[data-dd012-create="category"]').selectOption("food-combo");
  await create.locator('[data-dd012-create="nameVi"]').fill("Combo DD012C Hosted");
  await create.locator('[data-dd012-create="nameEn"]').fill("DD012C Hosted Combo");
  await create.locator('[data-dd012-create="priceVnd"]').fill("70000");
  await create.locator('[data-dd012-create="stationCode"]').fill("KITCHEN");
  await create.locator('[data-dd012-create="descVi"]').fill("DD-012C hosted component acceptance");
  await create.locator('[data-dd012-create="descEn"]').fill("DD-012C hosted component acceptance");
  await create.locator("[data-dd012-create-product]").click();
  await catalog.locator(`[data-dd012-product="${productId}"]`).waitFor({ timeout: 30_000 });
  console.log("DD012C_PREVIEW_PRODUCT_CREATE=PASS");

  const directWrite = await ownerClient.from("product_components").insert({
    id: `${componentId}-direct`,
    parent_product_id: productId,
    component_key: "direct",
    name_vi: "Direct",
    name_en: "Direct",
    qty: 1,
    station_code: "KITCHEN"
  });
  assert(Boolean(directWrite.error), "authenticated direct product_components INSERT unexpectedly succeeded");
  console.log("DD012C_STAGING_DIRECT_COMPONENT_WRITE_DENIAL=PASS");

  const panel = adminPage.locator("[data-dd012c-admin-components]");
  await panel.waitFor({ timeout: 30_000 });
  await panel.locator("[data-dd012c-refresh]").click();
  await waitFor(async () => (await panel.locator("[data-dd012c-product-select]").inputValue().catch(() => "")) === productId, "DD-012C product selection", 30_000);

  const componentForm = panel.locator("[data-dd012c-create-form]");
  await componentForm.locator('[data-dd012c-create="id"]').fill(componentId);
  await componentForm.locator('[data-dd012c-create="componentKey"]').fill("main");
  await componentForm.locator('[data-dd012c-create="nameVi"]').fill("Phần chính");
  await componentForm.locator('[data-dd012c-create="nameEn"]').fill("Main plate");
  await componentForm.locator('[data-dd012c-create="qty"]').fill("1");
  await componentForm.locator('[data-dd012c-create="stationCode"]').fill("KITCHEN_HOT");
  await componentForm.locator('[data-dd012c-create="displayOrder"]').fill("1");
  await componentForm.locator("button[data-dd012c-create]").click();
  let componentRow = panel.locator(`[data-dd012c-row="${componentId}"]`);
  await componentRow.waitFor({ timeout: 30_000 });
  console.log("DD012C_PREVIEW_COMPONENT_CREATE=PASS");

  const publicSnapshot = firstRow(await rpc(ownerClient, "dd008c_get_public_table_snapshot", { p_qr_token: qrToken }));
  assert(publicSnapshot?.ok === true, `public snapshot failed: ${publicSnapshot?.reason || "unknown"}`);
  const publicProduct = (publicSnapshot.payload?.products || []).find((item) => item.id === productId);
  const publicComponent = (publicProduct?.components || []).find((item) => item.key === "main");
  assert(publicProduct, "public combo product missing");
  assert(publicComponent?.en === "Main plate" && Number(publicComponent?.qty) === 1, "public component projection mismatch");
  console.log("DD012C_STAGING_PUBLIC_COMPONENT_PROJECTION=PASS");

  const firstOrder = firstRow(await rpc(ownerClient, "submit_qr_order", {
    p_qr_token: qrToken,
    p_items: [{ productId, qty: 2 }],
    p_note: "",
    p_idempotency_key: `${runId}_order_1`
  }));
  assert(firstOrder?.ok === true, `first combo QR order failed: ${firstOrder?.category}/${firstOrder?.reason}`);
  const firstItems = firstOrder.payload?.order?.items || [];
  const firstParent = firstItems.find((item) => !item.isComponent);
  const firstComponent = firstItems.find((item) => item.isComponent);
  assert(Number(firstParent?.price) === 70000 && Number(firstParent?.qty) === 2, "first combo parent snapshot mismatch");
  assert(firstComponent?.nameEn === "Main plate", "first component name mismatch");
  assert(Number(firstComponent?.qty) === 2, `first component qty expected 2, got ${firstComponent?.qty}`);
  assert(firstComponent?.station === "KITCHEN_HOT", `first component station mismatch: ${firstComponent?.station}`);
  assert(firstComponent?.parentComboId === productId, "first component parent combo mismatch");
  console.log("DD012C_STAGING_COMBO_ORDER_INITIAL=PASS");

  componentRow = panel.locator(`[data-dd012c-row="${componentId}"]`);
  await componentRow.locator('[data-dd012c-field="nameVi"]').fill("Phần chính mới");
  await componentRow.locator('[data-dd012c-field="nameEn"]').fill("Updated plate");
  await componentRow.locator('[data-dd012c-field="qty"]').fill("2");
  await componentRow.locator('[data-dd012c-field="stationCode"]').fill("KITCHEN_FINISH");
  await componentRow.locator('[data-dd012c-field="displayOrder"]').fill("2");
  await componentRow.locator(`[data-dd012c-save="${componentId}"]`).click();
  await waitFor(async () => (await panel.locator(`[data-dd012c-row="${componentId}"] [data-dd012c-field="nameEn"]`).inputValue().catch(() => "")) === "Updated plate", "component live edit", 30_000);
  console.log("DD012C_PREVIEW_COMPONENT_UPDATE=PASS");

  const updatedSnapshot = firstRow(await rpc(ownerClient, "dd008c_get_public_table_snapshot", { p_qr_token: qrToken }));
  const updatedProduct = (updatedSnapshot.payload?.products || []).find((item) => item.id === productId);
  const updatedComponent = (updatedProduct?.components || []).find((item) => item.key === "main");
  assert(updatedComponent?.en === "Updated plate" && Number(updatedComponent?.qty) === 2, "updated public component projection mismatch");

  const secondOrder = firstRow(await rpc(ownerClient, "submit_qr_order", {
    p_qr_token: qrToken,
    p_items: [{ productId, qty: 1 }],
    p_note: "",
    p_idempotency_key: `${runId}_order_2`
  }));
  assert(secondOrder?.ok === true, `updated combo QR order failed: ${secondOrder?.category}/${secondOrder?.reason}`);
  const secondComponent = (secondOrder.payload?.order?.items || []).find((item) => item.isComponent);
  assert(secondComponent?.nameEn === "Updated plate", "updated component name snapshot mismatch");
  assert(Number(secondComponent?.qty) === 2, `updated component qty expected 2, got ${secondComponent?.qty}`);
  assert(secondComponent?.station === "KITCHEN_FINISH", `updated component station mismatch: ${secondComponent?.station}`);
  console.log("DD012C_STAGING_COMBO_ORDER_UPDATED=PASS");

  componentRow = panel.locator(`[data-dd012c-row="${componentId}"]`);
  await componentRow.locator(`[data-dd012c-delete="${componentId}"]`).click();
  await waitFor(async () => (await panel.locator(`[data-dd012c-row="${componentId}"]`).count()) === 0, "component deletion", 30_000);
  console.log("DD012C_PREVIEW_COMPONENT_DELETE=PASS");

  const deletedSnapshot = firstRow(await rpc(ownerClient, "dd008c_get_public_table_snapshot", { p_qr_token: qrToken }));
  const deletedProduct = (deletedSnapshot.payload?.products || []).find((item) => item.id === productId);
  assert((deletedProduct?.components || []).length === 0, "deleted component still present in public projection");

  const thirdOrder = firstRow(await rpc(ownerClient, "submit_qr_order", {
    p_qr_token: qrToken,
    p_items: [{ productId, qty: 1 }],
    p_note: "",
    p_idempotency_key: `${runId}_order_3`
  }));
  assert(thirdOrder?.ok === true, `post-delete combo QR order failed: ${thirdOrder?.category}/${thirdOrder?.reason}`);
  assert(!(thirdOrder.payload?.order?.items || []).some((item) => item.isComponent), "post-delete order unexpectedly expanded a component");
  console.log("DD012C_STAGING_POST_DELETE_ORDER=PASS");

  assertNoPageErrors(adminPage);
  const diag = await callBootstrap("diagnose", { runId, locationId });
  assert(diag.ok === true, "bootstrap diagnose failed");
  assert(Number(diag.diagnostic?.products || 0) === 1, `expected one product before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.components || 0) === 0, `expected deleted component before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.orders || 0) === 3, `expected three orders before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.audits || 0) >= 4, `expected DD-012C audit evidence: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.dedupe || 0) >= 4, `expected DD-012C idempotency evidence: ${JSON.stringify(diag.diagnostic || {})}`);
  console.log(`DD012C_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD012C_HOSTED_RUN_ID=${runId}`);
  console.log("DD-012C hosted staging component smoke passed");
} catch (error) {
  console.error(sanitize(String(error?.stack || error)));
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (setupComplete) {
    const cleanup = await callBootstrap("cleanup", { runId, locationId }).catch((error) => ({ ok: false, reason: sanitize(error?.message || error) }));
    const d = cleanup?.diagnostic || {};
    console.log(`DD012C_STAGING_CLEANUP=${JSON.stringify({ ok: cleanup?.ok === true, diagnostic: d, reason: cleanup?.reason || "" })}`);
    const mustBeZero = [d.locations, d.products, d.components, d.orders, d.orderLines, d.tables, d.staffProfiles, d.staffLocations, d.staffRoles, d.devices, d.audits, d.dedupe, d.refreshHints, d.authUsers];
    if (!cleanup?.ok || mustBeZero.some((value) => Number(value || 0) !== 0)) process.exitCode = 1;
  }
}

async function login(client) {
  const { data, error } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (error || !data.session?.access_token) throw new Error(`owner login failed: ${error?.message || "missing session"}`);
}

function runtimeClient(storage) {
  return createClient(apiUrl, publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage } });
}

async function previewContext() {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.route(`${previewUrl}/**`, async (route) => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders() } }));
  return context;
}

async function loginThroughGate(page, identifier, password, mode) {
  return withPagePhase(page, `auth-gate:login:${mode}`, async () => {
    const form = page.locator("[data-auth-login]");
    await form.waitFor({ timeout: 30_000 });
    await waitFor(async () => !(await page.locator("body").innerText()).includes("Đang kiểm tra quyền truy cập."), `${mode} auth gate ready`, 30_000);
    await form.locator('input[name="email"]').fill(identifier);
    await form.locator('input[name="password"]').fill(password);
    await setFormValue(form.locator('input[name="locationId"]'), locationId);
    await setSelectValue(form.locator('select[name="workstationMode"]'), mode);
    await form.locator('button[type="submit"]').click();
    await waitFor(async () => {
      const body = await page.locator("body").innerText().catch(() => "");
      return !body.includes("Đang kiểm tra quyền truy cập.");
    }, `${mode} login resolved`, 30_000);
  });
}

async function setFormValue(locator, value) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.fill(value);
    return;
  }
  await locator.evaluate((element, nextValue) => {
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function setSelectValue(locator, value) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.selectOption(value);
    return;
  }
  await locator.evaluate((element, nextValue) => {
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function enrollOwnerTotpThroughUi(page) {
  return withPagePhase(page, "owner-bootstrap:enroll-totp", async () => {
    const panel = page.locator("[data-dd011b-bootstrap]");
    await panel.waitFor({ timeout: 30_000 });
    if (await panel.locator("[data-dd011b-owner-mfa-challenge]").count()) {
      throw new Error("Hosted Owner unexpectedly already has a verified TOTP factor");
    }
    await panel.locator("[data-dd011b-owner-mfa-enroll]").click();
    const secretLocator = panel.locator(".dd011-mfa-enroll code");
    await secretLocator.waitFor({ timeout: 30_000 });
    const secret = String(await secretLocator.textContent() || "").trim();
    assert(secret.length > 10, "Owner TOTP secret missing from enrollment UI");
    secrets.push(secret);
    const code = generateTotp(secret);
    secrets.push(code);
    const form = panel.locator("[data-dd011b-owner-mfa-verify]");
    await form.locator('input[name="code"]').fill(code);
    await form.locator('button[type="submit"]').click();
    await waitFor(async () => {
      const text = await panel.innerText().catch(() => "");
      return /Session now AAL2|Owner session is AAL2|Activate Owner workstation/i.test(text);
    }, "Owner browser AAL2", 30_000);
    console.log("DD012C_PREVIEW_OWNER_BROWSER_AAL2=PASS");
  });
}

async function bootstrapOwnerDeviceThroughUi(page) {
  return withPagePhase(page, "owner-bootstrap:device", async () => {
    const panel = page.locator("[data-dd011b-bootstrap]");
    await panel.locator("[data-dd011b-owner-bootstrap]").waitFor({ timeout: 30_000 });
    const form = panel.locator("[data-dd011b-owner-bootstrap]");
    await form.locator('input[name="deviceLabel"]').fill("DD012C Hosted Owner Admin");
    await form.locator('button[type="submit"]').click();
    await waitFor(async () => {
      const status = await securityStatusFromPage(page).catch(() => null);
      return status?.device?.active === true && status?.device?.workstationMode === "ADMIN";
    }, "Owner HttpOnly device session", 30_000);
  });
}

async function securityStatusFromPage(page) {
  return securityPostFromPage(page, "/api/security", { action: "status" }).then((result) => result.body);
}

async function securityPostFromPage(page, path, payload) {
  return withPagePhase(page, `security-post:${path}:${String(payload?.action || "unknown")}`, () => page.evaluate(async ({ path, payload }) => {
    const token = JSON.parse(localStorage.getItem("deedou_supabase_auth_session") || "{}")?.access_token || "";
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json().catch(() => ({})), path };
  }, { path, payload }));
}

async function assertBackendDeviceSessionCookie(context, label) {
  const cookies = await context.cookies(previewUrl);
  const cookie = cookies.find((item) => item.name === "__Host-deedou_device_session");
  assert(cookie, `${label} missing backend device-session cookie`);
  assert(cookie.httpOnly === true, `${label} device-session cookie must be HttpOnly`);
  assert(cookie.secure === true, `${label} device-session cookie must be Secure`);
  assert(cookie.sameSite === "Strict", `${label} device-session cookie must be SameSite=Strict`);
}

async function assertNoBrowserDeviceCredential(page, label) {
  const storage = await page.evaluate(() => {
    const dump = (area) => {
      const result = {};
      for (let index = 0; index < area.length; index += 1) {
        const key = area.key(index);
        result[key] = area.getItem(key);
      }
      return result;
    };
    return { local: dump(localStorage), session: dump(sessionStorage) };
  });
  assert(!Object.hasOwn(storage.local, "deedou_device_credential"), `${label} localStorage exposes legacy device credential`);
  assert(!Object.hasOwn(storage.session, "deedou_device_credential"), `${label} sessionStorage exposes legacy device credential`);
  console.log("DD012C_PREVIEW_NO_BROWSER_DEVICE_CREDENTIAL=PASS");
}

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${sanitize(error.message || error.code)}`);
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

async function withPagePhase(page, phase, operation) {
  page.__phase = String(phase || "unknown");
  return operation();
}

function trackErrors(page, label) {
  page.__label = label;
  page.__phase = "tracked";
  page.__errors = [];
  page.__forbiddenResponses = [];
  page.__forbiddenConsoles = [];
  page.on("pageerror", (error) => page.__errors.push(`pageerror:${sanitize(error?.message || error)}`));
  page.on("response", async (response) => {
    if (response.status() !== 403) return;
    const request = response.request();
    const entry = {
      page: label,
      phase: sanitize(page.__phase || "unknown"),
      method: sanitize(request.method()),
      status: response.status(),
      ...safeResponseUrl(response.url()),
      reason: await safeResponseReason(response)
    };
    page.__forbiddenResponses.push(entry);
    console.log(`DD012C_HTTP_403_DIAG=${JSON.stringify(entry)}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = sanitize(message.text());
    if (isExpectedForbiddenConsoleText(text)) {
      const entry = { page: label, phase: sanitize(page.__phase || "unknown"), text };
      page.__forbiddenConsoles.push(entry);
      console.log(`DD012C_CONSOLE_403_DIAG=${JSON.stringify(entry)}`);
      return;
    }
    page.__errors.push(`console:${text}`);
  });
}

function assertNoPageErrors(...pages) {
  const classified = [];
  const unclassified403 = [];
  for (const page of pages) {
    for (const entry of page.__forbiddenConsoles || []) {
      if (isExpectedDeviceSessionProbe(page, entry)) classified.push(entry);
      else unclassified403.push(`${page.__label}:console:${entry.text}`);
    }
  }
  if (classified.length) console.log(`DD012C_EXPECTED_403_CONSOLE_DIAG=${JSON.stringify(classified)}`);
  const failures = [
    ...pages.flatMap((page) => (page.__errors || []).map((error) => `${page.__label}:${error}`)),
    ...unclassified403
  ];
  if (failures.length) {
    const diagnostics = pages.flatMap((page) => (page.__forbiddenResponses || []).map((entry) => entry));
    const consoles = pages.flatMap((page) => (page.__forbiddenConsoles || []).map((entry) => entry));
    throw new Error(`browser errors:\n${failures.join("\n")}\nHTTP_403_DIAGNOSTICS=${JSON.stringify(diagnostics)}\nCONSOLE_403_DIAGNOSTICS=${JSON.stringify(consoles)}`);
  }
}

function isExpectedDeviceSessionProbe(page, consoleEntry) {
  const phase = String(consoleEntry?.phase || "");
  if (!isExpectedDeviceSessionProbePhase(phase)) return false;
  return (page.__forbiddenResponses || []).some((entry) => (
    entry.phase === phase &&
    entry.method === "POST" &&
    entry.status === 403 &&
    (entry.path === "/api/staff-rpc" || entry.path === "/api/security") &&
    (entry.reason === "DEVICE_SESSION_REQUIRED" || entry.reason === "MFA_REQUIRED")
  ));
}

function isExpectedDeviceSessionProbePhase(phase) {
  return /^auth-gate:login:ADMIN$/.test(String(phase || "")) ||
    /^owner-bootstrap:(enroll-totp|device)$/.test(String(phase || ""));
}

function isExpectedForbiddenConsoleText(text) {
  return /^Failed to load resource: the server responded with a status of 403(?: \((?:Forbidden)?\))?$/.test(String(text || ""));
}

function safeResponseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return { origin: sanitize(url.origin), path: sanitize(url.pathname) };
  } catch {
    return { origin: "", path: sanitize(String(value || "").split("?")[0].slice(0, 120)) };
  }
}

async function safeResponseReason(response) {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    return sanitize(row?.reason || row?.message || row?.code || row?.category || "");
  } catch {
    return "";
  }
}

function safeStatus(value = {}) {
  return {
    ok: value.ok === true,
    isOwner: value.isOwner === true,
    profile: value.profile ? {
      id: value.profile.id,
      username: value.profile.username,
      active: value.profile.active,
      provisioningStatus: value.profile.provisioning_status
    } : null,
    device: value.device ? {
      active: value.device.active === true,
      reason: value.device.reason,
      deviceId: value.device.deviceId,
      locationId: value.device.locationId,
      workstationMode: value.device.workstationMode
    } : null
  };
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

function sanitize(value) {
  let out = String(value || "")
    .replace(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "Bearer [JWT_REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .replace(/x-vercel-protection-bypass\s*[:=]\s*[^\s,;]+/gi, "x-vercel-protection-bypass=[REDACTED]");
  for (const secret of secrets.filter(Boolean)) out = out.split(secret).join("[SECRET_REDACTED]");
  return out.slice(0, 1200);
}
async function waitFor(fn, label, timeout = 20_000) { const started = Date.now(); let last; while (Date.now() - started < timeout) { try { if (await fn()) return; } catch (error) { last = error; } await sleep(200); } throw new Error(`Timeout waiting for ${label}${last ? `: ${sanitize(last?.message || last)}` : ""}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function requireEnv(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
