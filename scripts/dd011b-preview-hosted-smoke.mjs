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
if (prNumber !== 48) throw new Error(`DD-011B hosted gate must run on PR #48, got #${prNumber}`);

const previewUrl = await discoverReadyVercelPreview();
await waitForPreviewRuntimeConfig();

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
const runId = `dd011b_hosted_${suffix}`.replace(/-/g, "_");
const locationId = `dd011b-hosted-${suffix}`;
const tableId = `${runId}_table`;
const qrToken = `dd011b_${randomBytes(24).toString("base64url")}`;
const staffUsername = `dd011b_${randomBytes(6).toString("hex")}`.slice(0, 31);
const ownerAccount = {
  email: `deedou.smoke.${runId}.owner@gmail.com`,
  password: `Dd011b!${randomBytes(20).toString("base64url")}Aa1`,
  deviceSecret: `${runId}_legacy_admin_device_${randomUUID().replace(/-/g, "")}`
};
const staffAccount = {
  username: staffUsername,
  password: `Dd011bStaff!${randomBytes(20).toString("base64url")}Aa1`,
  displayName: "DD011B Hosted Cashier"
};
const secrets = [ownerAccount.password, ownerAccount.deviceSecret, staffAccount.password, qrToken];
const publicClient = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
let browser;
let setupComplete = false;
const contexts = [];

try {
  const setup = await callBootstrap("setup", {
    runId,
    locationId,
    account: ownerAccount,
    table: { id: tableId, code: "B48", zone: "DD011B", qrToken }
  });
  assert(setup.ok === true, `bootstrap setup failed: ${JSON.stringify(setup)}`);
  assert(Number(setup.diagnostic?.locations || 0) === 1, "bootstrap did not create one location");
  assert(Number(setup.diagnostic?.authUsers || 0) === 1, "bootstrap did not create one Owner auth user");
  assert(Number(setup.diagnostic?.tables || 0) === 1, "bootstrap did not create one public QR table");
  setupComplete = true;
  console.log("DD011B_PREVIEW_BOOTSTRAP=PASS");

  await assertPublicQrUnaffected();

  const ownerClient = runtimeClient(memoryStorage());
  await login(ownerClient, ownerAccount.email, ownerAccount.password, "owner AAL1 node login");
  const aal1Token = await accessToken(ownerClient);
  const aal1Bootstrap = await postHostedSecurity(aal1Token, { action: "bootstrapOwnerDevice", deviceLabel: "AAL1 denied" });
  assert(aal1Bootstrap.status === 403 && aal1Bootstrap.body?.reason === "MFA_REQUIRED", `Owner AAL1 bootstrap must be denied: ${JSON.stringify(aal1Bootstrap)}`);
  console.log("DD011B_PREVIEW_OWNER_AAL2_REQUIRED=PASS");

  browser = await chromium.launch({ headless: true });
  const ownerContext = await previewContext();
  contexts.push(ownerContext);
  const ownerPage = await ownerContext.newPage();
  trackErrors(ownerPage, "owner-admin");

  await ownerPage.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  await loginThroughGate(ownerPage, ownerAccount.email, ownerAccount.password, "ADMIN");
  await enrollOwnerTotpThroughUi(ownerPage);
  await bootstrapOwnerDeviceThroughUi(ownerPage);
  await assertBackendDeviceSessionCookie(ownerContext, "Owner");
  await assertNoBrowserDeviceCredential(ownerPage, "Owner");
  console.log("DD011B_PREVIEW_OWNER_BOOTSTRAP_HTTPONLY=PASS");

  const ownerStatus = await securityStatusFromPage(ownerPage);
  assert(ownerStatus.ok === true && ownerStatus.isOwner === true && ownerStatus.device?.active === true, `Owner status/device not active: ${JSON.stringify(safeStatus(ownerStatus))}`);

  await assertSingleOwnerInvariant(ownerPage);
  console.log("DD011B_PREVIEW_SINGLE_OWNER_INVARIANT=PASS");

  const securityPanel = ownerPage.locator("[data-dd011b-security-admin]");
  await securityPanel.waitFor({ timeout: 30_000 });
  await createPendingStaffThroughUi(ownerPage);
  console.log("DD011B_PREVIEW_CREATE_PENDING_STAFF=PASS");

  const staffContextA = await previewContext();
  contexts.push(staffContextA);
  const staffPageA = await staffContextA.newPage();
  trackErrors(staffPageA, "staff-a");
  await staffPageA.goto(`${previewUrl}/#/cashier`, { waitUntil: "domcontentloaded" });
  await loginThroughGate(staffPageA, staffAccount.username, staffAccount.password, "CASHIER");
  console.log("DD011B_PREVIEW_USERNAME_LOGIN=PASS");

  const codeA = await requestActivationThroughUi(staffPageA, "Hosted Cashier A", "CASHIER");
  const deviceA = await approveActivationAndWaitForDevice({ ownerPage, staffPage: staffPageA, staffContext: staffContextA, code: codeA, label: "staff A" });
  console.log("DD011B_PREVIEW_FIRST_LOGIN_ACTIVATION=PASS");

  const staffContextB = await previewContext();
  contexts.push(staffContextB);
  const staffPageB = await staffContextB.newPage();
  trackErrors(staffPageB, "staff-b");
  await staffPageB.goto(`${previewUrl}/#/cashier`, { waitUntil: "domcontentloaded" });
  await loginThroughGate(staffPageB, staffAccount.username, staffAccount.password, "CASHIER");
  const codeB = await requestActivationThroughUi(staffPageB, "Hosted Cashier B", "CASHIER");
  const deviceB = await approveActivationAndWaitForDevice({ ownerPage, staffPage: staffPageB, staffContext: staffContextB, code: codeB, label: "staff B" });
  assert(deviceA.deviceId !== deviceB.deviceId, "two staff browser contexts must receive distinct backend devices");
  console.log("DD011B_PREVIEW_NEW_DEVICE_ACTIVATION=PASS");

  await assertStaffRpcAllowed(staffPageA, "staff A before revoke");
  await assertStaffRpcAllowed(staffPageB, "staff B before revoke");

  await revokeDeviceThroughOwnerUi(ownerPage, deviceA.deviceId);
  await assertStaffRpcDenied(staffPageA, "DEVICE_SESSION_REQUIRED", "revoked staff A device");
  await assertStaffRpcAllowed(staffPageB, "staff B remains active after A revoke");
  console.log("DD011B_PREVIEW_REVOKE_DEVICE_NEXT_REQUEST_DENIED=PASS");

  await disableStaffThroughOwnerUi(ownerPage, deviceB.staffProfileId);
  await assertStaffRpcDenied(staffPageB, "DEVICE_SESSION_REQUIRED", "disabled staff B device");
  await assertStaffRpcDenied(staffPageA, "DEVICE_SESSION_REQUIRED", "disabled staff A revoked device remains denied");
  console.log("DD011B_PREVIEW_DISABLE_STAFF_ALL_DEVICES_DENIED=PASS");

  await assertPublicQrUnaffected();
  console.log("DD011B_PREVIEW_PUBLIC_QR_UNAFFECTED=PASS");

  assertNoPageErrors(ownerPage, staffPageA, staffPageB);
  const diag = await callBootstrap("diagnose", { runId, locationId });
  assert(diag.ok === true, "bootstrap diagnose failed");
  assert(Number(diag.diagnostic?.locations || 0) === 1, `expected one location before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.tables || 0) === 1, `expected one QR table before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.staffProfiles || 0) >= 2, `expected Owner and created staff before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  assert(Number(diag.diagnostic?.devices || 0) >= 3, `expected Owner plus staff devices before cleanup: ${JSON.stringify(diag.diagnostic || {})}`);
  console.log("DD011B_PREVIEW_PREFLIGHT_DIAGNOSE=PASS");
  console.log(`DD011B_PREVIEW_TARGET=${previewUrl}`);
  console.log(`DD011B_HOSTED_RUN_ID=${runId}`);
} catch (error) {
  console.error(sanitize(String(error?.stack || error)));
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (setupComplete) {
    const cleanup = await callBootstrap("cleanup", { runId, locationId }).catch((error) => ({ ok: false, reason: sanitize(error?.message || error) }));
    const d = cleanup?.diagnostic || {};
    console.log(`DD011B_PREVIEW_CLEANUP=${JSON.stringify({ ok: cleanup?.ok === true, diagnostic: d, reason: cleanup?.reason || "" })}`);
    const mustBeZero = [
      d.locations,
      d.tables,
      d.staffProfiles,
      d.staffLocations,
      d.staffRoles,
      d.activations,
      d.devices,
      d.deviceSessions,
      d.audits,
      d.dedupe,
      d.refreshHints,
      d.authUsers
    ];
    if (!cleanup?.ok || mustBeZero.some((value) => Number(value || 0) !== 0)) process.exitCode = 1;
    else console.log("DD011B_PREVIEW_CLEANUP_BASELINE=PASS");
  }
}

if (!process.exitCode) {
  console.log("DD-011B Vercel Preview hosted security acceptance passed.");
}

async function assertPublicQrUnaffected() {
  const snapshot = firstRow(await rpc(publicClient, "dd008c_get_public_table_snapshot", { p_qr_token: qrToken }));
  assert(snapshot?.ok === true, `public QR snapshot failed: ${snapshot?.reason || "unknown"}`);
  assert(snapshot.payload?.table?.code === "B48", `public QR resolved wrong table: ${JSON.stringify(snapshot.payload?.table || {})}`);

  if (!browser) return;
  const context = await previewContext();
  contexts.push(context);
  const page = await context.newPage();
  trackErrors(page, "public-qr");
  await page.goto(`${previewUrl}/#/t/${encodeURIComponent(qrToken)}`, { waitUntil: "domcontentloaded" });
  await waitForAppRender(page);
  assert(await page.locator("[data-auth-login]").count() === 0, "public QR route was intercepted by staff auth gate");
  assertNoPageErrors(page);
}

async function createPendingStaffThroughUi(page) {
  const panel = page.locator("[data-dd011b-security-admin]");
  await panel.locator("[data-dd011b-create-staff]").waitFor({ timeout: 30_000 });
  const form = panel.locator("[data-dd011b-create-staff]");
  await form.locator('input[name="displayName"]').fill(staffAccount.displayName);
  await form.locator('input[name="username"]').fill(staffAccount.username);
  await form.locator('input[name="password"]').fill(staffAccount.password);
  await form.locator('select[name="roleId"]').selectOption("CASHIER");
  await form.locator('button[type="submit"]').click();
  await waitFor(async () => {
    const text = await panel.innerText().catch(() => "");
    return text.includes(`@${staffAccount.username}`) && text.includes("PENDING_FIRST_LOGIN");
  }, "pending staff visible in Owner security panel", 30_000);
}

async function requestActivationThroughUi(page, deviceLabel, mode) {
  const panel = page.locator("[data-dd011b-bootstrap]");
  await panel.locator("[data-dd011b-request-activation]").waitFor({ timeout: 30_000 });
  const form = panel.locator("[data-dd011b-request-activation]");
  await form.locator('input[name="deviceLabel"]').fill(deviceLabel);
  await form.locator('select[name="workstationMode"]').selectOption(mode);
  await form.locator('button[type="submit"]').click();
  const codeLocator = panel.locator(".dd011b-code");
  await codeLocator.waitFor({ timeout: 30_000 });
  const code = String(await codeLocator.textContent() || "").replace(/\D/g, "");
  assert(/^[0-9]{6}$/.test(code), `activation code malformed: ${code}`);
  return code;
}

async function approveActivationAndWaitForDevice({ ownerPage, staffPage, staffContext, code, label }) {
  const panel = ownerPage.locator("[data-dd011b-security-admin]");
  await panel.locator("[data-dd011b-admin-refresh]").click();
  await waitFor(async () => {
    const text = await panel.innerText().catch(() => "");
    return text.replace(/\D/g, "").includes(code);
  }, `${label} activation code visible to Owner`, 30_000);
  const card = panel.locator(".dd011-card").filter({ hasText: formatCode(code) }).first();
  await card.locator("[data-dd011b-approve]").click();
  await waitFor(async () => !(await panel.innerText().catch(() => "")).replace(/\D/g, "").includes(code), `${label} activation removed after approval`, 30_000);

  await staffPage.locator("[data-dd011b-refresh]").click().catch(() => {});
  const status = await waitForSecurityStatus(staffPage, (body) => body.device?.active === true, `${label} backend device active`);
  await assertBackendDeviceSessionCookie(staffContext, label);
  await assertNoBrowserDeviceCredential(staffPage, label);
  return {
    deviceId: String(status.device.deviceId || ""),
    staffProfileId: String(status.profile?.id || ""),
    locationId: String(status.device.locationId || ""),
    workstationMode: String(status.device.workstationMode || "")
  };
}

async function assertSingleOwnerInvariant(page) {
  const result = await securityAdminPostFromPage(page, {
    action: "createStaff",
    displayName: "Invalid Second Owner",
    username: `${staffAccount.username}_owner`.slice(0, 31),
    password: staffAccount.password,
    roleId: "OWNER",
    locationId
  });
  assert(result.status === 403 && result.body?.reason === "SINGLE_OWNER_ENFORCED", `second OWNER create was not denied: ${JSON.stringify(result)}`);
}

async function revokeDeviceThroughOwnerUi(page, deviceId) {
  const panel = page.locator("[data-dd011b-security-admin]");
  await panel.locator("[data-dd011b-admin-refresh]").click();
  const button = panel.locator(`[data-dd011b-revoke-device][data-device-id="${cssAttr(deviceId)}"]`);
  await button.waitFor({ timeout: 30_000 });
  await button.click();
  await waitFor(async () => {
    const text = await panel.innerText().catch(() => "");
    return text.includes(deviceId) && text.includes("REVOKED");
  }, `device ${deviceId} revoked in Owner panel`, 30_000);
}

async function disableStaffThroughOwnerUi(page, staffProfileId) {
  const panel = page.locator("[data-dd011b-security-admin]");
  await panel.locator("[data-dd011b-admin-refresh]").click();
  const button = panel.locator(`[data-dd011b-toggle-staff][data-staff-id="${cssAttr(staffProfileId)}"][data-active="false"]`);
  await button.waitFor({ timeout: 30_000 });
  await button.click();
  await waitFor(async () => {
    const text = await panel.innerText().catch(() => "");
    return text.includes(`@${staffAccount.username}`) && text.includes("DISABLED");
  }, `staff ${staffProfileId} disabled in Owner panel`, 30_000);
}

async function loginThroughGate(page, identifier, password, mode) {
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
  console.log("DD011B_PREVIEW_OWNER_BROWSER_AAL2=PASS");
}

async function bootstrapOwnerDeviceThroughUi(page) {
  const panel = page.locator("[data-dd011b-bootstrap]");
  await panel.locator("[data-dd011b-owner-bootstrap]").waitFor({ timeout: 30_000 });
  const form = panel.locator("[data-dd011b-owner-bootstrap]");
  await form.locator('input[name="deviceLabel"]').fill("DD011B Hosted Owner Admin");
  await form.locator('button[type="submit"]').click();
  await waitFor(async () => {
    const status = await securityStatusFromPage(page).catch(() => null);
    return status?.device?.active === true && status?.device?.workstationMode === "ADMIN";
  }, "Owner HttpOnly device session", 30_000);
  await page.goto(`${previewUrl}/#/admin`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-dd011b-security-admin]").waitFor({ timeout: 30_000 });
}

async function assertStaffRpcAllowed(page, label) {
  const result = await staffRpcFromPage(page, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: ""
  });
  assert(result.status === 200 && result.row?.ok === true, `${label} should be authorized: ${JSON.stringify(safeRpc(result))}`);
}

async function assertStaffRpcDenied(page, expectedReason, label) {
  const result = await staffRpcFromPage(page, "authorize_staff_access", {
    p_location_id: locationId,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: ""
  });
  const reason = String(result.body?.message || result.row?.reason || "");
  assert(result.status === 403 || result.row?.ok === false, `${label} should be denied: ${JSON.stringify(safeRpc(result))}`);
  assert(reason === expectedReason, `${label} expected ${expectedReason}, got ${reason || "NO_REASON"}`);
}

async function securityStatusFromPage(page) {
  return securityPostFromPage(page, "/api/security", { action: "status" }).then((result) => result.body);
}

async function waitForSecurityStatus(page, predicate, label) {
  let last = null;
  await waitFor(async () => {
    last = await securityStatusFromPage(page).catch((error) => ({ ok: false, reason: sanitize(error?.message || error) }));
    return predicate(last);
  }, label, 35_000);
  return last;
}

async function securityAdminPostFromPage(page, payload) {
  return securityPostFromPage(page, "/api/security-admin", payload);
}

async function staffRpcFromPage(page, functionName, params) {
  return page.evaluate(async ({ functionName, params }) => {
    const token = JSON.parse(localStorage.getItem("deedou_supabase_auth_session") || "{}")?.access_token || "";
    const response = await fetch("/api/staff-rpc", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ functionName, params })
    });
    const body = await response.json().catch(() => ({}));
    const row = Array.isArray(body) ? body[0] : body;
    return { status: response.status, body, row };
  }, { functionName, params });
}

async function securityPostFromPage(page, path, payload) {
  return page.evaluate(async ({ path, payload }) => {
    const token = JSON.parse(localStorage.getItem("deedou_supabase_auth_session") || "{}")?.access_token || "";
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { path, payload });
}

async function postHostedSecurity(token, payload) {
  const response = await fetch(`${previewUrl}/api/security`, {
    method: "POST",
    headers: { ...bypassHeaders(), "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
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
}

async function waitForAppRender(page) {
  await page.locator("#app").waitFor({ timeout: 20_000 });
  await waitFor(async () => {
    const text = await page.locator("#app").innerText().catch(() => "");
    return text.trim().length > 20 && !text.includes("Cannot GET");
  }, "public QR app render", 20_000);
}

async function login(client, email, password, label) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) throw new Error(`${label}: ${error?.message || "missing session"}`);
}

async function accessToken(client) {
  const { data, error } = await client.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error(`access token unavailable: ${error?.message || "missing session"}`);
  return data.session.access_token;
}

function runtimeClient(storage) {
  return createClient(apiUrl, publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage } });
}

async function rpc(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) throw new Error(`${name}: ${sanitize(error.message || error.code)}`);
  return data;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

async function previewContext() {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  await context.route(`${previewUrl}/**`, async (route) => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders() } }));
  return context;
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
        if (match?.[1]) {
          console.log("DD011B_PREVIEW_DISCOVERY=PASS");
          return match[1].replace(/\/+$/, "");
        }
        last = "Vercel success but Preview URL missing";
      } else last = `Vercel status=${vercel?.state || "missing"}`;
    } catch (error) {
      last = sanitize(error?.message || error);
    }
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
      if (response.ok && safe && expected) {
        console.log("DD011B_PREVIEW_RUNTIME_CONFIG=PASS");
        return;
      }
      last = `status=${response.status} safe=${safe} expected=${expected}`;
    } catch (error) {
      last = sanitize(error?.message || error);
    }
    await sleep(2_000);
  }
  throw new Error(`Preview runtime config not ready: ${last}`);
}

async function githubFetch(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
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

function formatCode(value) {
  const code = String(value || "").replace(/\D/g, "").slice(0, 6);
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function memoryStorage() {
  const store = new Map();
  return { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
}

function bypassHeaders() {
  return { "x-vercel-protection-bypass": vercelBypassSecret, "cache-control": "no-cache" };
}

function trackErrors(page, label) {
  page.__label = label;
  page.__errors = [];
  page.on("pageerror", (error) => page.__errors.push(`pageerror:${sanitize(error?.message || error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") page.__errors.push(`console:${sanitize(message.text())}`);
  });
}

function assertNoPageErrors(...pages) {
  const failures = pages.flatMap((page) => (page.__errors || []).map((error) => `${page.__label}:${error}`));
  if (failures.length) throw new Error(`browser errors:\n${failures.join("\n")}`);
}

function safeStatus(value = {}) {
  return {
    ok: value.ok === true,
    isOwner: value.isOwner === true,
    profile: value.profile ? { id: value.profile.id, username: value.profile.username, active: value.profile.active, provisioningStatus: value.profile.provisioning_status } : null,
    device: value.device ? { active: value.device.active === true, reason: value.device.reason, deviceId: value.device.deviceId, locationId: value.device.locationId, workstationMode: value.device.workstationMode } : null,
    activation: value.activation ? { status: value.activation.status, activationKind: value.activation.activationKind } : null
  };
}

function safeRpc(result = {}) {
  return {
    status: result.status,
    ok: result.row?.ok,
    reason: result.body?.message || result.row?.reason || "",
    deviceId: result.row?.device_id || result.row?.deviceId || ""
  };
}

function cssAttr(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sanitize(value) {
  let out = String(value || "")
    .replace(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "Bearer [JWT_REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .replace(/x-vercel-protection-bypass\s*[:=]\s*[^\s,;]+/gi, "x-vercel-protection-bypass=[REDACTED]");
  for (const secret of secrets.filter(Boolean)) out = out.split(secret).join("[SECRET_REDACTED]");
  return out.slice(0, 1000);
}

async function waitFor(fn, label, timeout = 20_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      if (await fn()) return;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${label}${last ? `: ${sanitize(last?.message || last)}` : ""}`);
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
