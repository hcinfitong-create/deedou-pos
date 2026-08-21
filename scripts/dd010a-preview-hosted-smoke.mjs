import { randomUUID } from "node:crypto";
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

if (prNumber !== 35) throw new Error(`DD-010A hosted gate must run on PR #35, got #${prNumber}`);
const previewUrl = await discoverReadyVercelPreview();
await waitForPreviewRuntimeConfig(previewUrl);

const runId = `dd010a_hosted_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const locationId = `dd010a-hosted-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const accounts = {
  admin: account("admin", "ADMIN_MENU", "ADMIN"),
  staff: account("staff", "FLOOR_STAFF", "STAFF"),
  cashier: account("cashier", "CASHIER", "CASHIER")
};

const publicClient = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
let browser;
const contexts = [];
let setupComplete = false;

try {
  await callBootstrap("setup", { runId, locationId, accounts: Object.values(accounts) });
  setupComplete = true;
  const clients = {};
  for (const [name, spec] of Object.entries(accounts)) clients[name] = await loginNode(spec);

  const rawInsert = await clients.admin.from("physical_tables").insert({
    id: `${runId}_raw_denied`,
    location_id: locationId,
    code: "RAW1",
    zone: "Denied",
    qr_token: `${runId}_raw_token`
  });
  assert(rawInsert.error, "authenticated Admin direct Data API INSERT unexpectedly succeeded");
  console.log("DD010A_PREVIEW_DIRECT_TABLE_WRITE=DENIED");

  const staffCreate = await rpc(clients.staff, "dd010a_create_physical_table", createParams({
    code: "S95", zone: "Beach", idempotencyKey: `${runId}_staff_create`, spec: accounts.staff
  }));
  assert(staffCreate.ok === false && staffCreate.category === "FORBIDDEN", `Staff table create not forbidden: ${JSON.stringify(staffCreate)}`);
  const cashierCreate = await rpc(clients.cashier, "dd010a_create_physical_table", createParams({
    code: "C95", zone: "Beach", idempotencyKey: `${runId}_cashier_create`, spec: accounts.cashier
  }));
  assert(cashierCreate.ok === false && cashierCreate.category === "FORBIDDEN", `Cashier table create not forbidden: ${JSON.stringify(cashierCreate)}`);
  console.log("DD010A_PREVIEW_NON_ADMIN_MUTATION=DENIED");

  browser = await chromium.launch({ headless: true });
  const adminContext = await createPreviewContext(accounts.admin);
  const customerContext = await createPreviewContext();
  contexts.push(adminContext, customerContext);
  const adminPage = await adminContext.newPage();
  const customerPage = await customerContext.newPage();
  trackErrors(adminPage, "admin");
  trackErrors(customerPage, "customer");

  await loginAdmin(adminPage, accounts.admin);
  await adminPage.locator("[data-dd010a-admin-tables]").waitFor({ timeout: 30_000 });
  await waitFor(async () => {
    const text = await adminPage.locator("[data-dd010a-admin-tables]").innerText().catch(() => "");
    return /Loaded\s+0\s+tables from PostgreSQL\./i.test(text) || /Chưa có bàn/i.test(text);
  }, "clean hosted table layout", 30_000);

  const a95Id = await createTableViaUi(adminPage, { code: "A95", zone: "Beach", seats: 6, shape: "ROUND" });
  const b95Id = await createTableViaUi(adminPage, { code: "B95", zone: "Indoor", seats: 4, shape: "RECTANGLE" });
  assert(a95Id && b95Id && a95Id !== b95Id, "UI did not create distinct physical tables");
  console.log(`DD010A_PREVIEW_CREATED_TABLES=${a95Id},${b95Id}`);

  await openManage(adminPage, "A95");
  let a95Article = tableArticle(adminPage, "A95");
  const oldCustomerUrl = String(await a95Article.locator(".dd010a-qr-meta code").textContent() || "").trim();
  assert(oldCustomerUrl.startsWith(`${previewUrl}/#/t/`), `QR URL not bound to Vercel Preview origin: ${oldCustomerUrl}`);
  const oldToken = tokenFromCustomerUrl(oldCustomerUrl);
  const initialResolve = await resolveToken(oldToken);
  assert(initialResolve.length === 1 && initialResolve[0].code === "A95" && initialResolve[0].zone === "Beach", `new table QR did not resolve: ${JSON.stringify(initialResolve)}`);
  console.log("DD010A_PREVIEW_QR_INITIAL_RESOLVE=PASS");

  await customerPage.goto(oldCustomerUrl, { waitUntil: "domcontentloaded" });
  await waitForAppRender(customerPage);
  const customerBody = await customerPage.locator("body").innerText();
  assert(customerBody.includes("A95"), `Vercel Preview customer QR route did not render table A95: ${customerBody.slice(0, 300)}`);
  console.log("DD010A_PREVIEW_CUSTOMER_ROUTE=PASS");

  const source = adminPage.locator(`[data-dd010a-drag-table="${cssEscape(a95Id)}"]`);
  const target = adminPage.locator('[data-dd010a-drop-zone="Indoor"]');
  await source.waitFor({ timeout: 20_000 });
  await target.waitFor({ timeout: 20_000 });
  await source.dragTo(target, { targetPosition: { x: 180, y: 140 } });
  await waitFor(async () => (await tableArticle(adminPage, "A95").innerText().catch(() => "")).includes("Indoor"), "A95 drag to Indoor", 30_000);
  const adminSnapshotAfterDrag = await adminLayout(clients.admin, accounts.admin);
  const dragged = adminSnapshotAfterDrag.tables.find((table) => table.id === a95Id);
  assert(dragged?.zone === "Indoor" && Number(dragged.layoutX) >= 0 && Number(dragged.layoutY) >= 0, `drag not persisted authoritatively: ${JSON.stringify(dragged)}`);
  console.log(`DD010A_PREVIEW_DRAG_PERSISTED=${dragged.layoutX},${dragged.layoutY},${dragged.zone}`);

  await openManage(adminPage, "A95");
  a95Article = tableArticle(adminPage, "A95");
  const preRotateUrl = String(await a95Article.locator(".dd010a-qr-meta code").textContent() || "").trim();
  const preRotateToken = tokenFromCustomerUrl(preRotateUrl);
  adminPage.once("dialog", (dialog) => dialog.accept());
  await a95Article.locator("[data-dd010a-rotate-qr]").click();
  await waitFor(async () => {
    const article = tableArticle(adminPage, "A95");
    const url = String(await article.locator(".dd010a-qr-meta code").textContent().catch(() => "") || "").trim();
    return url && url !== preRotateUrl;
  }, "A95 QR rotation", 30_000);
  a95Article = tableArticle(adminPage, "A95");
  const newCustomerUrl = String(await a95Article.locator(".dd010a-qr-meta code").textContent() || "").trim();
  const newToken = tokenFromCustomerUrl(newCustomerUrl);
  assert((await resolveToken(preRotateToken)).length === 0, "old QR token still resolves after rotation");
  const rotatedResolve = await resolveToken(newToken);
  assert(rotatedResolve.length === 1 && rotatedResolve[0].code === "A95", `rotated QR does not resolve: ${JSON.stringify(rotatedResolve)}`);
  await customerPage.goto(newCustomerUrl, { waitUntil: "domcontentloaded" });
  await waitForAppRender(customerPage);
  assert((await customerPage.locator("body").innerText()).includes("A95"), "rotated QR customer route did not render A95");
  console.log("DD010A_PREVIEW_QR_ROTATION=PASS");

  await openManage(adminPage, "A95");
  a95Article = tableArticle(adminPage, "A95");
  await a95Article.locator('[data-dd010a-toggle-active][data-next-active="false"]').click();
  await waitFor(async () => (await tableArticle(adminPage, "A95").innerText().catch(() => "")).includes("INACTIVE"), "A95 deactivate", 30_000);
  assert((await resolveToken(newToken)).length === 0, "inactive table QR still resolves");
  console.log("DD010A_PREVIEW_DEACTIVATE=PASS");

  const diag = await callBootstrap("diagnose", { runId, locationId });
  const commands = new Set((diag?.diagnostic?.auditCommands || []).map((entry) => entry.command));
  for (const expected of [
    "dd010a_create_physical_table",
    "dd010a_update_physical_table",
    "dd010a_rotate_physical_table_qr",
    "dd010a_set_physical_table_active"
  ]) assert(commands.has(expected), `missing hosted audit evidence for ${expected}`);
  assert(Number(diag?.diagnostic?.tables || 0) === 2, `unexpected hosted table count before cleanup: ${JSON.stringify(diag?.diagnostic || {})}`);
  console.log("DD010A_PREVIEW_AUDIT=PASS");

  assertNoPageErrors(adminPage, customerPage);
  console.log(`DD010A_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD010A_HOSTED_RUN_ID=${runId}`);
  console.log("DD-010A Vercel Preview hosted acceptance passed: Admin create, floor drag, QR customer route, QR rotation, deactivate, RBAC denial, audit, and direct-write denial.");
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (setupComplete) {
    const cleanup = await callBootstrap("cleanup", { runId, locationId }).catch((error) => ({ ok: false, reason: safeMessage(error) }));
    console.log(`DD010A_PREVIEW_CLEANUP=${JSON.stringify({ ok: cleanup?.ok === true, diagnostic: cleanup?.diagnostic || {}, reason: cleanup?.reason || "" })}`);
    if (!cleanup?.ok && !process.exitCode) process.exitCode = 1;
  }
}

function account(name, role, mode) {
  return {
    name,
    role,
    mode,
    email: `deedou.smoke.${Date.now()}.${randomUUID().slice(0, 8)}.${name}@gmail.com`,
    password: `Dd10a!${randomUUID().replace(/-/g, "").slice(0, 18)}Aa1`,
    deviceSecret: `${runIdSafeSeed()}_${name}_${randomUUID().replace(/-/g, "")}`
  };
}

function runIdSafeSeed() {
  return `dd010a_${Date.now().toString(36)}`;
}

function createParams({ code, zone, idempotencyKey, spec }) {
  return {
    p_location_id: locationId,
    p_code: code,
    p_zone: zone,
    p_seat_count: 4,
    p_shape: "RECTANGLE",
    p_layout_x: 0,
    p_layout_y: 0,
    p_layout_width: 2,
    p_layout_height: 2,
    p_display_order: 0,
    p_idempotency_key: idempotencyKey,
    p_workstation_mode: spec.mode,
    p_device_credential: spec.deviceSecret
  };
}

async function discoverReadyVercelPreview() {
  const [owner, name] = repo.split("/");
  const started = Date.now();
  let last = "not attempted";
  while (Date.now() - started < 180_000) {
    try {
      const statusResponse = await githubFetch(`https://api.github.com/repos/${owner}/${name}/commits/${headSha}/status`);
      const statuses = Array.isArray(statusResponse.statuses) ? statusResponse.statuses : [];
      const vercel = statuses.find((entry) => entry.context === "Vercel");
      if (vercel?.state !== "success") {
        last = `Vercel status=${vercel?.state || "missing"}`;
      } else {
        const comments = await githubFetch(`https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`);
        const vercelComment = [...comments].reverse().find((comment) => comment?.user?.login === "vercel[bot]" && /\[Preview\]\(https:\/\//.test(comment.body || ""));
        const match = vercelComment?.body?.match(/\[Preview\]\((https:\/\/[^)]+\.vercel\.app)\)/);
        if (match?.[1]) {
          console.log("DD010A_PREVIEW_DISCOVERY=PASS");
          return match[1].replace(/\/+$/, "");
        }
        last = "Vercel success but Preview URL missing from bot comment";
      }
    } catch (error) {
      last = safeMessage(error);
    }
    await sleep(2_000);
  }
  throw new Error(`Unable to discover Ready Vercel Preview for head ${headSha}: ${last}`);
}

async function waitForPreviewRuntimeConfig(previewUrl) {
  const started = Date.now();
  let last = "not attempted";
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch(`${previewUrl}/api/runtime-config`, { headers: bypassHeaders() });
      const body = await response.text();
      const safe = !/service_role|sb_secret_|SUPABASE_SECRET|DATABASE_URL|DB_PASSWORD|JWT_SECRET|PRIVATE KEY/i.test(body);
      const expected = body.includes('"mode":"SUPABASE"') && body.includes(apiUrl) && body.includes(publishableKey);
      if (response.ok && safe && expected) {
        console.log("DD010A_PREVIEW_RUNTIME_CONFIG=PASS");
        return;
      }
      last = `status=${response.status} safe=${safe} expected=${expected}`;
    } catch (error) {
      last = safeMessage(error);
    }
    await sleep(2_000);
  }
  throw new Error(`Preview runtime config did not become ready: ${last}`);
}

async function loginNode(spec) {
  const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: spec.email, password: spec.password });
  if (error) throw new Error(`node login ${spec.name}: ${safeMessage(error)}`);
  return client;
}

async function createPreviewContext(spec = {}) {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.route(`${previewUrl}/**`, async (route) => {
    await route.continue({ headers: { ...route.request().headers(), ...bypassHeaders() } });
  });
  await context.addInitScript(({ deviceSecret, mode, locationId }) => {
    if (deviceSecret) localStorage.setItem("deedou_device_credential", deviceSecret);
    if (mode) localStorage.setItem("deedou_workstation_mode", mode);
    if (locationId) localStorage.setItem("deedou_staff_location_id", locationId);
  }, { deviceSecret: spec.deviceSecret || "", mode: spec.mode || "", locationId });
  return context;
}

async function loginAdmin(page, spec) {
  await page.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  const form = page.locator("[data-auth-login]");
  await form.waitFor({ timeout: 30_000 });
  await waitFor(async () => !(await page.locator("body").innerText()).includes("Đang kiểm tra quyền truy cập."), "Admin auth gate ready", 30_000);
  await form.locator('input[name="email"]').fill(spec.email);
  await form.locator('input[name="password"]').fill(spec.password);
  await form.locator('input[name="locationId"]').fill(locationId);
  await form.locator('select[name="workstationMode"]').selectOption("ADMIN");
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("[data-auth-login]"), null, { timeout: 30_000 });
}

async function createTableViaUi(page, { code, zone, seats, shape }) {
  const panel = page.locator("[data-dd010a-admin-tables]");
  await panel.locator('[data-dd010a-create="code"]').fill(code);
  await panel.locator('[data-dd010a-create="zone"]').fill(zone);
  await panel.locator('[data-dd010a-create="seatCount"]').fill(String(seats));
  await panel.locator('[data-dd010a-create="shape"]').selectOption(shape);
  await panel.locator("[data-dd010a-create-table]").click();
  const article = tableArticle(page, code);
  await article.waitFor({ timeout: 30_000 });
  const id = await article.getAttribute("data-dd010a-table");
  assert(id, `${code} UI article missing table id`);
  return id;
}

async function openManage(page, code) {
  const article = tableArticle(page, code);
  await article.waitFor({ timeout: 20_000 });
  if (await article.locator(".dd010a-qr-meta code").count()) return;
  await article.locator("[data-dd010a-edit-table]").click();
  await article.locator(".dd010a-qr-meta code").waitFor({ timeout: 20_000 });
}

function tableArticle(page, code) {
  return page.locator("[data-dd010a-table]").filter({ has: page.locator("strong", { hasText: code }) }).first();
}

async function adminLayout(client, spec) {
  const result = await rpc(client, "dd010a_get_admin_table_layout", {
    p_location_id: locationId,
    p_workstation_mode: spec.mode,
    p_device_credential: spec.deviceSecret
  });
  assert(result.ok === true, `admin layout failed: ${JSON.stringify(result)}`);
  return result.payload || { tables: [] };
}

async function resolveToken(token) {
  const { data, error } = await publicClient.rpc("resolve_table_token", { p_qr_token: token });
  if (error) throw new Error(`resolve_table_token: ${safeMessage(error)}`);
  return Array.isArray(data) ? data : [];
}

function tokenFromCustomerUrl(url) {
  const parsed = new URL(url);
  const match = parsed.hash.match(/^#\/t\/(.+)$/);
  assert(match?.[1], `customer URL missing table token: ${url}`);
  return decodeURIComponent(match[1]);
}

async function waitForAppRender(page) {
  await page.locator("#app").waitFor({ timeout: 20_000 });
  await waitFor(async () => (await page.locator("#app").innerText().catch(() => "")).trim().length > 20, "customer app render", 20_000);
  const body = await page.locator("body").innerText();
  assert(!body.includes("Cannot GET"), "Preview route returned Cannot GET");
}

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) return { ok: false, category: classifyError(error), reason: safeMessage(error), payload: {} };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return { ok: false, category: "BACKEND_UNAVAILABLE", reason: "EMPTY_RPC_RESULT", payload: {} };
  return { ...row, payload: row.payload || {} };
}

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
  const requestUrl = requireEnv("ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = requireEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const url = new URL(requestUrl);
  url.searchParams.set("audience", "deedou-hosted-smoke");
  const response = await fetch(url, { headers: { authorization: `Bearer ${requestToken}` } });
  if (!response.ok) throw new Error(`GitHub OIDC request failed: ${response.status}`);
  const body = await response.json();
  if (!body?.value) throw new Error("GitHub OIDC token missing");
  return body.value;
}

async function githubFetch(url) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

function bypassHeaders() {
  return { "x-vercel-protection-bypass": vercelBypassSecret, "cache-control": "no-cache" };
}

function trackErrors(page, label) {
  page.__dd010aLabel = label;
  page.__dd010aErrors = [];
  page.on("pageerror", (error) => page.__dd010aErrors.push(`pageerror:${safeMessage(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") page.__dd010aErrors.push(`console:${message.text()}`);
  });
}

function assertNoPageErrors(...pages) {
  const failures = pages.flatMap((page) => (page.__dd010aErrors || []).map((error) => `${page.__dd010aLabel}:${error}`));
  if (failures.length) throw new Error(`browser errors:\n${failures.join("\n")}`);
}

function classifyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (text.includes("jwt") || text.includes("auth")) return "UNAUTHENTICATED";
  if (text.includes("permission") || text.includes("forbidden") || text.includes("42501")) return "FORBIDDEN";
  return "BACKEND_UNAVAILABLE";
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function safeMessage(error) {
  return String(error?.message || error || "UNKNOWN")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .replace(/x-vercel-protection-bypass\s*[:=]\s*[^\s,;]+/gi, "x-vercel-protection-bypass=[REDACTED]")
    .slice(0, 300);
}

async function waitFor(fn, label, timeout = 20_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      if (await fn()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${label}${lastError ? `: ${safeMessage(lastError)}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
