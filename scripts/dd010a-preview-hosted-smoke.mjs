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
await waitForPreviewRuntimeConfig();

const runId = `dd010a_hosted_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const locationId = `dd010a-hosted-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const accounts = {
  admin: account("admin", "ADMIN_MENU", "ADMIN"),
  staff: account("staff", "FLOOR_STAFF", "STAFF"),
  cashier: account("cashier", "CASHIER", "CASHIER")
};
const publicClient = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
let browser;
let setupComplete = false;
const contexts = [];

try {
  await callBootstrap("setup", { runId, locationId, accounts: Object.values(accounts) });
  setupComplete = true;

  const clients = {};
  for (const [name, spec] of Object.entries(accounts)) clients[name] = await loginNode(spec);

  const rawInsert = await clients.admin.from("physical_tables").insert({
    id: `${runId}_raw_denied`, location_id: locationId, code: "RAW1", zone: "Denied", qr_token: `${runId}_raw_token`
  });
  assert(rawInsert.error, "authenticated Admin direct physical_tables INSERT unexpectedly succeeded");
  console.log("DD010A_PREVIEW_DIRECT_TABLE_WRITE=DENIED");

  for (const spec of [accounts.staff, accounts.cashier]) {
    const result = await rpc(clients[spec.name], "dd010a_create_physical_table", createRpcParams(spec, `${spec.name.toUpperCase()}95`));
    assert(result.ok === false && result.category === "FORBIDDEN", `${spec.name} table create not forbidden: ${JSON.stringify(result)}`);
  }
  console.log("DD010A_PREVIEW_NON_ADMIN_MUTATION=DENIED");

  browser = await chromium.launch({ headless: true });
  const adminContext = await previewContext(accounts.admin);
  const customerContext = await previewContext();
  contexts.push(adminContext, customerContext);
  const adminPage = await adminContext.newPage();
  const customerPage = await customerContext.newPage();
  trackErrors(adminPage, "admin");
  trackErrors(customerPage, "customer");

  await loginAdmin(adminPage, accounts.admin);
  const panel = adminPage.locator("[data-dd010a-admin-tables]");
  await panel.waitFor({ timeout: 30_000 });
  await waitFor(async () => {
    const text = await panel.innerText().catch(() => "");
    return /Loaded\s+0\s+tables from PostgreSQL\./i.test(text) || /Chưa có bàn/i.test(text);
  }, "clean DD-010A layout", 30_000);
  console.log("DD010A_PREVIEW_ADMIN_LAYOUT=PASS");

  const a95 = await createTableViaUi(adminPage, { code: "A95", zone: "Beach", seats: 6, shape: "ROUND" });
  const b95 = await createTableViaUi(adminPage, { code: "B95", zone: "Indoor", seats: 4, shape: "RECTANGLE" });
  assert(a95.id && b95.id && a95.id !== b95.id, "UI did not create two distinct tables");
  console.log(`DD010A_PREVIEW_CREATE=PASS:${a95.id},${b95.id}`);

  await openManage(adminPage, "A95");
  let a95Article = tableArticle(adminPage, "A95");
  const initialUrl = await qrUrl(a95Article);
  assert(initialUrl.startsWith(`${previewUrl}/#/t/`), `QR not bound to Vercel Preview origin: ${initialUrl}`);
  const initialToken = tokenFromUrl(initialUrl);
  const initialResolve = await resolveToken(initialToken);
  assert(initialResolve.length === 1 && initialResolve[0].code === "A95" && initialResolve[0].zone === "Beach", `initial QR resolve failed: ${JSON.stringify(initialResolve)}`);

  await customerPage.goto(initialUrl, { waitUntil: "domcontentloaded" });
  await waitForAppRender(customerPage);
  assert((await customerPage.locator("body").innerText()).includes("A95"), "customer QR route did not render A95");
  console.log("DD010A_PREVIEW_CUSTOMER_ROUTE=PASS");

  const source = adminPage.locator(`[data-dd010a-drag-table="${cssEscape(a95.id)}"]`);
  const target = adminPage.locator('[data-dd010a-drop-zone="Indoor"]');
  await source.waitFor({ timeout: 20_000 });
  await target.waitFor({ timeout: 20_000 });
  const updateResponse = waitRpcResponse(adminPage, "dd010a_update_physical_table", 12_000);
  await source.dragTo(target, { targetPosition: { x: 180, y: 140 } });
  const dragRpc = await requireRpcResponse(updateResponse, adminPage, "drag A95");
  assert(dragRpc.ok === true, `drag RPC rejected: ${JSON.stringify(dragRpc)}`);
  await waitFor(async () => (await tableArticle(adminPage, "A95").innerText().catch(() => "")).includes("Indoor"), "A95 UI zone Indoor", 30_000);
  const dragSnapshot = await adminLayout(clients.admin, accounts.admin);
  const dragged = dragSnapshot.tables.find((table) => table.id === a95.id);
  assert(dragged?.zone === "Indoor", `drag not persisted: ${JSON.stringify(dragged)}`);
  console.log(`DD010A_PREVIEW_DRAG=PASS:${dragged.layoutX},${dragged.layoutY},${dragged.zone}`);

  await openManage(adminPage, "A95");
  a95Article = tableArticle(adminPage, "A95");
  const beforeRotateUrl = await qrUrl(a95Article);
  const beforeRotateToken = tokenFromUrl(beforeRotateUrl);
  adminPage.once("dialog", (dialog) => dialog.accept());
  const rotateResponse = waitRpcResponse(adminPage, "dd010a_rotate_physical_table_qr", 12_000);
  await a95Article.locator("[data-dd010a-rotate-qr]").click();
  const rotateRpc = await requireRpcResponse(rotateResponse, adminPage, "rotate A95 QR");
  assert(rotateRpc.ok === true, `rotate RPC rejected: ${JSON.stringify(rotateRpc)}`);
  await waitFor(async () => (await qrUrl(tableArticle(adminPage, "A95")).catch(() => "")) !== beforeRotateUrl, "rotated QR URL", 30_000);
  const rotatedUrl = await qrUrl(tableArticle(adminPage, "A95"));
  const rotatedToken = tokenFromUrl(rotatedUrl);
  assert((await resolveToken(beforeRotateToken)).length === 0, "old QR still resolves after rotation");
  const rotatedResolve = await resolveToken(rotatedToken);
  assert(rotatedResolve.length === 1 && rotatedResolve[0].code === "A95", "new QR does not resolve after rotation");
  await customerPage.goto(rotatedUrl, { waitUntil: "domcontentloaded" });
  await waitForAppRender(customerPage);
  assert((await customerPage.locator("body").innerText()).includes("A95"), "rotated QR route did not render A95");
  console.log("DD010A_PREVIEW_ROTATE_QR=PASS");

  await openManage(adminPage, "A95");
  a95Article = tableArticle(adminPage, "A95");
  const activeResponse = waitRpcResponse(adminPage, "dd010a_set_physical_table_active", 12_000);
  await a95Article.locator('[data-dd010a-toggle-active][data-next-active="false"]').click();
  const activeRpc = await requireRpcResponse(activeResponse, adminPage, "deactivate A95");
  assert(activeRpc.ok === true, `deactivate RPC rejected: ${JSON.stringify(activeRpc)}`);
  await waitFor(async () => (await tableArticle(adminPage, "A95").innerText().catch(() => "")).includes("INACTIVE"), "A95 inactive UI", 30_000);
  assert((await resolveToken(rotatedToken)).length === 0, "inactive table QR still resolves");
  console.log("DD010A_PREVIEW_DEACTIVATE=PASS");

  const diag = await callBootstrap("diagnose", { runId, locationId });
  const commands = new Set((diag?.diagnostic?.auditCommands || []).map((entry) => entry.command));
  for (const expected of ["dd010a_create_physical_table", "dd010a_update_physical_table", "dd010a_rotate_physical_table_qr", "dd010a_set_physical_table_active"]) {
    assert(commands.has(expected), `missing audit evidence for ${expected}`);
  }
  assert(Number(diag?.diagnostic?.tables || 0) === 2, `unexpected pre-cleanup table count: ${JSON.stringify(diag?.diagnostic || {})}`);
  console.log("DD010A_PREVIEW_AUDIT=PASS");
  assertNoPageErrors(adminPage, customerPage);
  console.log(`DD010A_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD010A_HOSTED_RUN_ID=${runId}`);
  console.log("DD-010A Vercel Preview hosted acceptance passed: Admin create, floor drag, QR route/rotation, deactivate, RBAC denial, audit and direct-write denial.");
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (setupComplete) {
    const cleanup = await callBootstrap("cleanup", { runId, locationId }).catch((error) => ({ ok: false, reason: safeMessage(error) }));
    console.log(`DD010A_PREVIEW_CLEANUP=${JSON.stringify({ ok: cleanup?.ok === true, diagnostic: cleanup?.diagnostic || {}, reason: cleanup?.reason || "" })}`);
    if (!cleanup?.ok && !process.exitCode) process.exitCode = 1;
  }
}

async function createTableViaUi(page, spec) {
  const panel = page.locator("[data-dd010a-admin-tables]");
  await panel.waitFor({ timeout: 20_000 });
  await panel.locator('[data-dd010a-create="code"]').fill(spec.code);
  await panel.locator('[data-dd010a-create="zone"]').fill(spec.zone);
  await panel.locator('[data-dd010a-create="seatCount"]').fill(String(spec.seats));
  await panel.locator('[data-dd010a-create="shape"]').selectOption(spec.shape);
  const values = await readCreateValues(panel);
  console.log(`DD010A_PREVIEW_CREATE_FORM=${JSON.stringify(values)}`);
  const responsePromise = waitRpcResponse(page, "dd010a_create_physical_table", 10_000);
  await panel.locator("[data-dd010a-create-table]").click();
  const result = await requireRpcResponse(responsePromise, page, `create ${spec.code}`);
  assert(result.ok === true, `create ${spec.code} RPC rejected: ${JSON.stringify(result)}`);
  const article = tableArticle(page, spec.code);
  await article.waitFor({ timeout: 30_000 });
  const id = await article.getAttribute("data-dd010a-table");
  assert(id, `${spec.code} article missing id`);
  return { id, result };
}

function waitRpcResponse(page, functionName, timeout) {
  return page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/rest/v1/rpc/${functionName}`), { timeout }).catch(() => null);
}

async function requireRpcResponse(responsePromise, page, label) {
  const response = await responsePromise;
  if (!response) {
    const panel = page.locator("[data-dd010a-admin-tables]");
    const diagnostic = {
      label,
      message: await panel.locator("[data-dd010a-message]").innerText().catch(() => ""),
      form: await readCreateValues(panel).catch(() => ({})),
      panel: String(await panel.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 700)
    };
    console.log(`DD010A_PREVIEW_UI_NO_RPC=${JSON.stringify(diagnostic)}`);
    throw new Error(`${label}: browser UI emitted no authoritative RPC`);
  }
  const body = await response.json().catch(() => null);
  const row = Array.isArray(body) ? body[0] : body;
  const safe = { httpStatus: response.status(), ok: typeof row?.ok === "boolean" ? row.ok : null, category: String(row?.category || ""), reason: String(row?.reason || "") };
  console.log(`DD010A_PREVIEW_RPC=${JSON.stringify({ label, ...safe })}`);
  return safe;
}

async function readCreateValues(panel) {
  return {
    code: await panel.locator('[data-dd010a-create="code"]').inputValue().catch(() => ""),
    zone: await panel.locator('[data-dd010a-create="zone"]').inputValue().catch(() => ""),
    seatCount: await panel.locator('[data-dd010a-create="seatCount"]').inputValue().catch(() => ""),
    shape: await panel.locator('[data-dd010a-create="shape"]').inputValue().catch(() => "")
  };
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

async function openManage(page, code) {
  const article = tableArticle(page, code);
  await article.waitFor({ timeout: 20_000 });
  if (await article.locator(".dd010a-qr-meta code").count()) return;
  await article.locator("[data-dd010a-edit-table]").click();
  await article.locator(".dd010a-qr-meta code").waitFor({ timeout: 20_000 });
}

function tableArticle(page, code) {
  return page.locator("[data-dd010a-table]").filter({ hasText: code }).first();
}

async function qrUrl(article) {
  return String(await article.locator(".dd010a-qr-meta code").textContent() || "").trim();
}

async function adminLayout(client, spec) {
  const result = await rpc(client, "dd010a_get_admin_table_layout", { p_location_id: locationId, p_workstation_mode: spec.mode, p_device_credential: spec.deviceSecret });
  assert(result.ok === true, `admin layout failed: ${JSON.stringify(result)}`);
  return result.payload || { tables: [] };
}

async function resolveToken(token) {
  const { data, error } = await publicClient.rpc("resolve_table_token", { p_qr_token: token });
  if (error) throw new Error(`resolve_table_token: ${safeMessage(error)}`);
  return Array.isArray(data) ? data : [];
}

function tokenFromUrl(url) {
  const match = new URL(url).hash.match(/^#\/t\/(.+)$/);
  assert(match?.[1], `customer URL missing token: ${url}`);
  return decodeURIComponent(match[1]);
}

async function waitForAppRender(page) {
  await page.locator("#app").waitFor({ timeout: 20_000 });
  await waitFor(async () => (await page.locator("#app").innerText().catch(() => "")).trim().length > 20, "customer app render", 20_000);
  assert(!(await page.locator("body").innerText()).includes("Cannot GET"), "Preview returned Cannot GET");
}

async function previewContext(spec = {}) {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.route(`${previewUrl}/**`, async (route) => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders() } }));
  await context.addInitScript(({ deviceSecret, mode, locationId }) => {
    if (deviceSecret) localStorage.setItem("deedou_device_credential", deviceSecret);
    if (mode) localStorage.setItem("deedou_workstation_mode", mode);
    if (locationId) localStorage.setItem("deedou_staff_location_id", locationId);
  }, { deviceSecret: spec.deviceSecret || "", mode: spec.mode || "", locationId });
  return context;
}

function createRpcParams(spec, code) {
  return { p_location_id: locationId, p_code: code, p_zone: "Beach", p_seat_count: 4, p_shape: "RECTANGLE", p_layout_x: 0, p_layout_y: 0, p_layout_width: 2, p_layout_height: 2, p_display_order: 0, p_idempotency_key: `${runId}_${spec.name}_create`, p_workstation_mode: spec.mode, p_device_credential: spec.deviceSecret };
}

async function loginNode(spec) {
  const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: spec.email, password: spec.password });
  if (error) throw new Error(`node login ${spec.name}: ${safeMessage(error)}`);
  return client;
}

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) return { ok: false, category: classifyError(error), reason: safeMessage(error), payload: {} };
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? { ...row, payload: row.payload || {} } : { ok: false, category: "BACKEND_UNAVAILABLE", reason: "EMPTY_RPC_RESULT", payload: {} };
}

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
        if (match?.[1]) { console.log("DD010A_PREVIEW_DISCOVERY=PASS"); return match[1].replace(/\/+$/, ""); }
        last = "Vercel success but Preview URL missing";
      } else last = `Vercel status=${vercel?.state || "missing"}`;
    } catch (error) { last = safeMessage(error); }
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
      if (response.ok && safe && expected) { console.log("DD010A_PREVIEW_RUNTIME_CONFIG=PASS"); return; }
      last = `status=${response.status} safe=${safe} expected=${expected}`;
    } catch (error) { last = safeMessage(error); }
    await sleep(2_000);
  }
  throw new Error(`Preview runtime config not ready: ${last}`);
}

async function githubFetch(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

function account(name, role, mode) {
  return { name, role, mode, email: `deedou.smoke.${Date.now()}.${randomUUID().slice(0, 8)}.${name}@gmail.com`, password: `Dd10a!${randomUUID().replace(/-/g, "").slice(0, 18)}Aa1`, deviceSecret: `dd010a_${Date.now().toString(36)}_${name}_${randomUUID().replace(/-/g, "")}` };
}

function bypassHeaders() { return { "x-vercel-protection-bypass": vercelBypassSecret, "cache-control": "no-cache" }; }
function cssEscape(value) { return String(value).replace(/["\\]/g, "\\$&"); }
function classifyError(error) { const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase(); return text.includes("jwt") || text.includes("auth") ? "UNAUTHENTICATED" : text.includes("permission") || text.includes("forbidden") || text.includes("42501") ? "FORBIDDEN" : "BACKEND_UNAVAILABLE"; }
function trackErrors(page, label) { page.__label = label; page.__errors = []; page.on("pageerror", (e) => page.__errors.push(`pageerror:${safeMessage(e)}`)); page.on("console", (m) => { if (m.type() === "error") page.__errors.push(`console:${m.text()}`); }); }
function assertNoPageErrors(...pages) { const failures = pages.flatMap((page) => (page.__errors || []).map((error) => `${page.__label}:${error}`)); if (failures.length) throw new Error(`browser errors:\n${failures.join("\n")}`); }
function safeMessage(error) { return String(error?.message || error || "UNKNOWN").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]").replace(/x-vercel-protection-bypass\s*[:=]\s*[^\s,;]+/gi, "x-vercel-protection-bypass=[REDACTED]").slice(0, 300); }
async function waitFor(fn, label, timeout = 20_000) { const started = Date.now(); let last; while (Date.now() - started < timeout) { try { if (await fn()) return; } catch (error) { last = error; } await sleep(200); } throw new Error(`Timeout waiting for ${label}${last ? `: ${safeMessage(last)}` : ""}`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function requireEnv(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
