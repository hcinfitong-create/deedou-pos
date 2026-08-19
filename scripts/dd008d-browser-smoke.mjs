import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const LOCATION_ID = "deedou-demo";
const BASE_URL = "http://127.0.0.1:8099";
const DB_URL = process.env.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY;
const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY || statusEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!anonKey || !serviceRoleKey) throw new Error("Supabase local keys unavailable");

const runId = `dd008d_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const qrTokens = {
  A01: `${runId}_a01_token`,
  A02: `${runId}_a02_token`
};
const accounts = {
  staff: account("staff", "FLOOR_STAFF", "STAFF"),
  kitchen: account("kitchen", "KITCHEN", "KDS_KITCHEN"),
  bar: account("bar", "BAR", "KDS_BAR"),
  cashier: account("cashier", "CASHIER", "CASHIER"),
  admin: account("admin", "ADMIN_MENU", "ADMIN")
};

const adminClient = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const publicClient = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const createdUserIds = [];
let server;
let browser;
const contexts = [];
const pages = [];

try {
  await provisionUsers();
  provisionDatabase();

  const runtimeClients = {};
  for (const [name, spec] of Object.entries(accounts)) runtimeClients[name] = await loginNode(spec);

  server = await startStaticServer();
  browser = await chromium.launch({ headless: true });

  const customerContext = await createBrowserContext({ timezoneId: "Asia/Ho_Chi_Minh" });
  const staffContext = await createBrowserContext(accounts.staff);
  const kitchenContext = await createBrowserContext(accounts.kitchen);
  const barContext = await createBrowserContext(accounts.bar);
  const cashierContext = await createBrowserContext(accounts.cashier);
  const adminContext = await createBrowserContext(accounts.admin);
  contexts.push(customerContext, staffContext, kitchenContext, barContext, cashierContext, adminContext);

  const customerPage = await trackedPage(customerContext, "customer");
  const staffPage = await trackedPage(staffContext, "staff");
  const kitchenPage = await trackedPage(kitchenContext, "kitchen");
  const barPage = await trackedPage(barContext, "bar");
  const cashierPage = await trackedPage(cashierContext, "cashier");
  const adminPage = await trackedPage(adminContext, "admin");

  await Promise.all([
    loginRoute(staffPage, "staff", accounts.staff),
    loginRoute(kitchenPage, "kitchen", accounts.kitchen),
    loginRoute(barPage, "bar", accounts.bar),
    loginRoute(cashierPage, "cashier", accounts.cashier),
    loginAdmin(adminPage, accounts.admin)
  ]);

  await Promise.all([
    waitConnectivityOnline(staffPage),
    waitConnectivityOnline(kitchenPage),
    waitConnectivityOnline(barPage),
    waitConnectivityOnline(cashierPage),
    waitConnectivityOnline(adminPage)
  ]);

  // Admin authority: PostgreSQL availability must immediately control the public QR catalog.
  await adminPage.locator("[data-dd008d-admin-refresh]").click();
  const adminFriedRice = adminPage.locator('[data-dd008d-admin-product="fried-rice"]');
  await adminFriedRice.waitFor({ timeout: 20_000 });
  assert(await adminFriedRice.getAttribute("data-available") === "true", "fried-rice should start available");
  await adminFriedRice.locator('[data-dd008d-set-availability="false"]').click();
  await waitFor(async () => (await adminFriedRice.getAttribute("data-available")) === "false", "admin UI disable fried-rice");

  await openCustomer(customerPage, qrTokens.A01);
  assert(await customerPage.locator('[data-add="fried-rice"]').count() === 0, "public QR exposed authoritative unavailable fried-rice");
  assert(await customerPage.locator("[data-dd008d-connectivity]").count() === 0, "customer route must not render staff connectivity diagnostics");

  await adminFriedRice.locator('[data-dd008d-set-availability="true"]').click();
  await waitFor(async () => (await adminFriedRice.getAttribute("data-available")) === "true", "admin UI re-enable fried-rice");
  await customerPage.reload();
  await customerPage.locator('[data-add="fried-rice"]').waitFor({ timeout: 20_000 });

  // Direct tamper with a legitimate CASHIER session/device must still fail server-side menu.manage.
  const tamper = await rpc(runtimeClients.cashier, "dd008d_set_product_availability", {
    p_location_id: LOCATION_ID,
    p_product_id: "fried-rice",
    p_available: false,
    p_expected_updated_at: null,
    p_idempotency_key: `${runId}_cashier_tamper`,
    p_workstation_mode: "CASHIER",
    p_device_credential: accounts.cashier.deviceSecret
  });
  assert(tamper.ok === false && tamper.category === "FORBIDDEN", `cashier menu tamper not denied: ${JSON.stringify(tamper)}`);

  // Migration UI is explicit: import stays locked until exact server preview of the local export.
  const importButton = adminPage.locator("[data-dd008d-import]");
  assert(await importButton.isDisabled(), "legacy import should be locked initially");
  await adminPage.locator("[data-dd008d-build-export]").click();
  await adminPage.locator("[data-dd008d-import-key]").fill(`${runId}_preview_only`);
  await adminPage.locator("[data-dd008d-server-preview]").click();
  await waitForBody(adminPage, "SERVER PREVIEW OK");
  assert(!(await adminPage.locator("[data-dd008d-import]").isDisabled()), "server preview did not unlock exact previewed payload");
  await adminPage.locator("[data-dd008d-readiness]").click();
  await waitForBody(adminPage, "READINESS REPORT");
  await waitForBody(adminPage, '"blockingChecksOk": true');

  // First QR batch: configured mango tea + fried rice. Fill note before second add to regression-test note preservation.
  const note1 = `${runId} configured hold-fire batch`;
  await customerPage.locator('[data-add-config="mango-tea"]').click();
  await customerPage.locator("#note").fill(note1);
  await customerPage.locator('[data-add="fried-rice"]').click();
  assert(await customerPage.locator("#note").inputValue() === note1, "customer note was lost after cart rerender");
  await customerPage.locator("[data-submit]").click();
  await waitForBody(customerPage, "DeeDou đang kiểm tra order của bạn.");

  const firstPublic = await publicSnapshot(qrTokens.A01);
  const sessionId = firstPublic.tableSession?.id;
  assert(sessionId, "first QR order did not open authoritative table session");
  const firstOrder = firstPublic.orders.find((order) => order.note === note1);
  assert(firstOrder, "first authoritative order missing from public snapshot");
  const mangoLine = firstOrder.items.find((line) => line.id === "mango-tea" && !line.isComponent);
  const riceLine = firstOrder.items.find((line) => line.id === "fried-rice" && !line.isComponent);
  assert(mangoLine?.configuredKey?.includes("v:regular"), "configured mango tea snapshot missing default variant");
  assert(Array.isArray(mangoLine?.optionSnapshot?.modifierGroups) && mangoLine.optionSnapshot.modifierGroups.length > 0, "configured mango tea modifier snapshot missing");
  assert(riceLine?.lineId, "fried-rice line missing");

  const staffCard = staffPage.locator(".order-card").filter({ hasText: note1 }).first();
  await staffCard.waitFor({ timeout: 30_000 });
  const riceFamily = staffCard.locator(".course-family").filter({ hasText: /Seafood Fried Rice|Cơm chiên hải sản/ }).first();
  await riceFamily.locator("[data-course-value]").fill("1");
  await riceFamily.locator("[data-course-assign]").click();
  await waitForBody(staffPage, "Course 1");
  const riceFamilyAfterCourse = staffPage.locator(".order-card").filter({ hasText: note1 }).first().locator(".course-family").filter({ hasText: /Seafood Fried Rice|Cơm chiên hải sản/ }).first();
  await riceFamilyAfterCourse.locator("[data-line-hold]").click();
  await waitForBody(staffPage, "HELD");
  await staffPage.locator(".order-card").filter({ hasText: note1 }).first().locator('button[data-status="ACCEPTED"]').click();

  // Bar line is fired and can progress; held kitchen line must not surface until explicit Fire.
  await progressTicket(barPage, note1, ["ACKNOWLEDGED", "PREPARING", "READY"]);
  await sleep(400);
  assert(await kitchenPage.locator(".ticket").filter({ hasText: note1 }).count() === 0, "held kitchen line leaked to KDS before Fire");

  const heldFamily = staffPage.locator(".order-card").filter({ hasText: note1 }).first().locator(".course-family").filter({ hasText: /Seafood Fried Rice|Cơm chiên hải sản/ }).first();
  await heldFamily.locator("[data-line-fire]").click();
  const kitchenTicket = kitchenPage.locator(".ticket").filter({ hasText: note1 }).first();
  await kitchenTicket.waitFor({ timeout: 30_000 });
  await expectText(kitchenTicket, "Course 1", "kitchen ticket missing assigned course after Fire");
  await progressTicket(kitchenPage, note1, ["ACKNOWLEDGED", "PREPARING", "READY"]);

  await serveAllReadyForNote(staffPage, note1, 2);
  await waitOrderStatus(runtimeClients.cashier, firstOrder.id, "SERVED", accounts.cashier);

  // Second order batch must reuse the same active visit.
  const note2 = `${runId} second visit batch`;
  await customerPage.locator('[data-add="espresso"]').click();
  await customerPage.locator("#note").fill(note2);
  await customerPage.locator("[data-submit]").click();
  await waitForBody(customerPage, note2);
  const secondPublic = await publicSnapshot(qrTokens.A01);
  assert(secondPublic.tableSession?.id === sessionId, "second QR order created a different table visit");
  const secondOrder = secondPublic.orders.find((order) => order.note === note2);
  assert(secondOrder, "second order batch missing");

  const secondStaffCard = staffPage.locator(".order-card").filter({ hasText: note2 }).first();
  await secondStaffCard.waitFor({ timeout: 30_000 });
  await secondStaffCard.locator('button[data-status="ACCEPTED"]').click();
  await progressTicket(barPage, note2, ["ACKNOWLEDGED", "PREPARING", "READY"]);
  await serveAllReadyForNote(staffPage, note2, 1);
  await waitOrderStatus(runtimeClients.cashier, secondOrder.id, "SERVED", accounts.cashier);

  // Transfer the open visit A01 -> A02 through actual cashier UI.
  await cashierPage.locator('[data-select-table="A01"]').click();
  const transfer = cashierPage.locator(`[data-transfer-session="${sessionId}"][data-transfer-to="A02"]`);
  await transfer.waitFor({ timeout: 20_000 });
  await transfer.click();
  await waitFor(async () => {
    const snapshot = await staffSnapshot(runtimeClients.cashier, accounts.cashier);
    return snapshot.tableSessions.some((session) => session.id === sessionId && session.tableCode === "A02" && session.status === "OPEN");
  }, "table transfer A01 to A02", 30_000);

  await cashierPage.locator('[data-select-table="A02"]').click();
  const tableAmount = cashierPage.locator('[data-payment-amount="A02"]');
  await tableAmount.waitFor({ timeout: 20_000 });
  const beforePayment = await tableOutstanding(runtimeClients.cashier, accounts.cashier, sessionId);
  assert(beforePayment > 1000, `unexpected outstanding before mixed tender: ${beforePayment}`);
  await tableAmount.fill("1000");
  await cashierPage.locator('[data-table-pay="A02"][data-method="CASH"]').click();
  await waitFor(async () => (await tableOutstanding(runtimeClients.cashier, accounts.cashier, sessionId)) === beforePayment - 1000, "partial cash tender");
  const remaining = await tableOutstanding(runtimeClients.cashier, accounts.cashier, sessionId);
  await cashierPage.locator('[data-payment-amount="A02"]').fill(String(remaining));
  await cashierPage.locator('[data-table-pay="A02"][data-method="CARD_EXTERNAL_TERMINAL"]').click();
  await waitFor(async () => (await tableOutstanding(runtimeClients.cashier, accounts.cashier, sessionId)) === 0, "final card tender");

  // Closing a fully served/settled visit is authoritative.
  const closeButton = cashierPage.locator(`[data-close-session="${sessionId}"]`);
  await closeButton.waitFor({ timeout: 20_000 });
  await closeButton.click();
  await waitFor(async () => psqlScalar(`select status from public.table_sessions where id='${sql(sessionId)}'`) === "CLOSED", "table visit closed");
  await waitConnectivityOnline(cashierPage);

  // Targeted refund after close must not reopen visit or KDS workflow.
  const settled = await staffSnapshot(runtimeClients.cashier, accounts.cashier);
  const settledFirst = settled.orders.find((order) => order.id === firstOrder.id);
  const originalPayment = settledFirst?.payments?.find((payment) => payment.type === "PAYMENT");
  assert(originalPayment?.id, "settled first order has no refundable payment");
  const closedCard = cashierPage.locator(".closed-payment-card").filter({ hasText: settledFirst.orderNo }).first();
  await closedCard.waitFor({ timeout: 20_000 });
  const refundButton = closedCard.locator(`[data-payment-refund="${firstOrder.id}"][data-payment-id="${originalPayment.id}"]`);
  const refundRow = refundButton.locator("xpath=ancestor::*[contains(@class,'status-pill')]");
  await refundRow.locator("[data-payment-amount]").fill("1000");
  await refundButton.click();
  await waitFor(async () => {
    const snapshot = await staffSnapshot(runtimeClients.cashier, accounts.cashier);
    const refundedOrder = snapshot.orders.find((order) => order.id === firstOrder.id);
    return refundedOrder?.payments?.some((payment) => (
      payment.type === "REFUND"
      && payment.relatedPaymentId === originalPayment.id
      && Number(payment.amountVnd) === 1000
    ));
  }, "targeted refund ledger projection");
  assert(psqlScalar(`select status from public.table_sessions where id='${sql(sessionId)}'`) === "CLOSED", "refund reopened closed table visit");
  assert(await kitchenPage.locator(".ticket").filter({ hasText: note1 }).count() === 0, "refund reopened kitchen workflow");
  assert(await barPage.locator(".ticket").filter({ hasText: note1 }).count() === 0, "refund reopened bar workflow");

  // Duplicate idempotency key must produce one authoritative availability mutation.
  const adminMenu = await rpc(runtimeClients.admin, "dd008d_get_admin_menu_snapshot", {
    p_location_id: LOCATION_ID,
    p_workstation_mode: "ADMIN",
    p_device_credential: accounts.admin.deviceSecret
  });
  const espresso = adminMenu.payload.products.find((product) => product.id === "espresso");
  assert(espresso?.updatedAt, "admin snapshot missing espresso optimistic token");
  const idemKey = `${runId}_availability_idempotency`;
  const disable1 = await rpc(runtimeClients.admin, "dd008d_set_product_availability", {
    p_location_id: LOCATION_ID,
    p_product_id: "espresso",
    p_available: false,
    p_expected_updated_at: espresso.updatedAt,
    p_idempotency_key: idemKey,
    p_workstation_mode: "ADMIN",
    p_device_credential: accounts.admin.deviceSecret
  });
  const disable2 = await rpc(runtimeClients.admin, "dd008d_set_product_availability", {
    p_location_id: LOCATION_ID,
    p_product_id: "espresso",
    p_available: false,
    p_expected_updated_at: espresso.updatedAt,
    p_idempotency_key: idemKey,
    p_workstation_mode: "ADMIN",
    p_device_credential: accounts.admin.deviceSecret
  });
  assert(disable1.ok && disable2.ok, "availability idempotency replay failed");
  assert(disable1.payload.product.updatedAt === disable2.payload.product.updatedAt, "availability replay changed authoritative timestamp");
  assert(Number(psqlScalar(`select count(*) from public.command_deduplication where location_id='${LOCATION_ID}' and command='dd008d_set_product_availability' and command_key='${sql(idemKey)}'`)) === 1, "duplicate idempotency created more than one dedup record");
  await rpc(runtimeClients.admin, "dd008d_set_product_availability", {
    p_location_id: LOCATION_ID,
    p_product_id: "espresso",
    p_available: true,
    p_expected_updated_at: disable1.payload.product.updatedAt,
    p_idempotency_key: `${idemKey}_restore`,
    p_workstation_mode: "ADMIN",
    p_device_credential: accounts.admin.deviceSecret
  });

  // Disconnect staff and keep exercising the existing business-signal path until a real authoritative refetch observes the offline transport.
  await staffContext.setOffline(true);
  await waitFor(async () => {
    await staffPage.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "deedou_products_full" })));
    const state = await staffPage.locator("[data-dd008d-connectivity]").getAttribute("data-state").catch(() => "");
    return ["OFFLINE", "DEGRADED"].includes(state);
  }, "connectivity OFFLINE/DEGRADED after authoritative offline refetch", 20_000);
  const requestIdempotency = `${runId}_offline_service_request`;
  const request = await rpc(publicClient, "create_service_request", {
    p_qr_token: qrTokens.A01,
    p_type: "CALL_STAFF",
    p_idempotency_key: requestIdempotency
  });
  assert(request.ok === true, `service request while staff offline failed: ${JSON.stringify(request)}`);
  await staffContext.setOffline(false);
  await staffPage.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitConnectivityOnline(staffPage, 30_000);
  await waitForBody(staffPage, "CALL STAFF");
  await waitForBody(staffPage, "A01");

  assertNoPageErrors();
  console.log("DD-008D browser smoke passed: migration preview, admin authority, configured QR order, Hold/Fire, KDS, second batch, transfer, mixed tender, close/refund, idempotency, and reconnect convergence.");
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise((resolveClose) => server?.close?.(resolveClose) || resolveClose());
  for (const userId of createdUserIds) await adminClient.auth.admin.deleteUser(userId).catch(() => {});
}

function account(name, role, mode) {
  return {
    name,
    role,
    mode,
    staffId: `${runId}_staff_${name}`,
    deviceId: `${runId}_device_${name}`,
    deviceSecret: `${runId}_${name}_device_secret`,
    email: `${runId}.${name}@example.invalid`,
    password: `Dd8d!${randomUUID().slice(0, 8)}Aa1`
  };
}

async function provisionUsers() {
  for (const spec of Object.values(accounts)) {
    const { data, error } = await adminClient.auth.admin.createUser({ email: spec.email, password: spec.password, email_confirm: true });
    if (error || !data?.user?.id) throw new Error(`createUser ${spec.name}: ${error?.message || "missing user"}`);
    spec.userId = data.user.id;
    createdUserIds.push(data.user.id);
  }
}

function provisionDatabase() {
  const roleRows = Object.values(accounts).map((spec) => `('${sql(spec.staffId)}','${LOCATION_ID}','${sql(spec.role)}',true)`).join(",\n");
  const profileRows = Object.values(accounts).map((spec) => `('${sql(spec.staffId)}','${sql(spec.userId)}','DD-008D ${sql(spec.name)}',true)`).join(",\n");
  const locationRows = Object.values(accounts).map((spec) => `('${sql(spec.staffId)}','${LOCATION_ID}',true)`).join(",\n");
  const deviceRows = Object.values(accounts).map((spec) => `('${sql(spec.deviceId)}','${LOCATION_ID}','DD-008D ${sql(spec.name)}','${sql(spec.mode)}',public.hash_device_credential('${sql(spec.deviceSecret)}'),true,'${sql(spec.staffId)}')`).join(",\n");
  psql(`
    update public.physical_tables set qr_token='${sql(qrTokens.A01)}', is_active=true where location_id='${LOCATION_ID}' and code='A01';
    update public.physical_tables set qr_token='${sql(qrTokens.A02)}', is_active=true where location_id='${LOCATION_ID}' and code='A02';
    do $$ begin
      if not exists (select 1 from public.physical_tables where location_id='${LOCATION_ID}' and code='A01')
         or not exists (select 1 from public.physical_tables where location_id='${LOCATION_ID}' and code='A02') then
        raise exception 'A01/A02 fixtures missing';
      end if;
    end $$;
    update public.products set available=true, periods=array['morning','afternoon','evening']::text[] where location_id='${LOCATION_ID}' and id in ('fried-rice','mango-tea','espresso');
    insert into public.staff_profiles (id, auth_user_id, display_name, active) values ${profileRows} on conflict (id) do update set active=true;
    insert into public.staff_location_assignments (staff_profile_id, location_id, active) values ${locationRows} on conflict (staff_profile_id,location_id) do update set active=true;
    insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active) values ${roleRows} on conflict (staff_profile_id,location_id,role_id) do update set active=true;
    insert into public.workstation_devices (id,location_id,label,mode,credential_hash,active,registered_by_staff_profile_id) values ${deviceRows} on conflict (id) do update set active=true, mode=excluded.mode, credential_hash=excluded.credential_hash;
  `);
}

async function loginNode(spec) {
  const client = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: spec.email, password: spec.password });
  if (error) throw new Error(`node login ${spec.name}: ${error.message}`);
  return client;
}

async function createBrowserContext(spec = {}) {
  const context = await browser.newContext({ timezoneId: spec.timezoneId || "Asia/Ho_Chi_Minh" });
  await context.addInitScript(({ backendConfig, deviceSecret, mode }) => {
    window.DEEDOU_BACKEND_CONFIG = backendConfig;
    window.__DEEDOU_BACKEND_CONFIG__ = backendConfig;
    if (deviceSecret) localStorage.setItem("deedou_device_credential", deviceSecret);
    if (mode) localStorage.setItem("deedou_workstation_mode", mode);
    localStorage.setItem("deedou_staff_location_id", "deedou-demo");
  }, {
    backendConfig: { mode: "SUPABASE", supabaseUrl: apiUrl, supabasePublishableKey: anonKey },
    deviceSecret: spec.deviceSecret || "",
    mode: spec.mode || ""
  });
  return context;
}

async function trackedPage(context, label) {
  const page = await context.newPage();
  page.__label = label;
  page.__errors = [];
  page.on("pageerror", (error) => page.__errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") page.__errors.push(`console:${message.text()}`);
  });
  pages.push(page);
  return page;
}

async function loginRoute(page, route, spec) {
  await page.goto(`${BASE_URL}/#/${route}`, { waitUntil: "domcontentloaded" });
  const form = page.locator("[data-auth-login]");
  await form.waitFor({ timeout: 20_000 });
  await waitForAuthGateReady(page, `login gate ${spec.mode}`);
  await form.locator('input[name="email"]').fill(spec.email);
  await form.locator('input[name="password"]').fill(spec.password);
  await form.locator('input[name="locationId"]').fill(LOCATION_ID);
  await form.locator('select[name="workstationMode"]').selectOption(spec.mode);
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("[data-auth-login]"), null, { timeout: 30_000 });
}

async function loginAdmin(page, spec) {
  await page.goto(`${BASE_URL}/#/admin`, { waitUntil: "domcontentloaded" });
  const form = page.locator("[data-auth-login]");
  await form.waitFor({ timeout: 20_000 });
  await waitForAuthGateReady(page, "login gate ADMIN");
  await form.locator('input[name="email"]').fill(spec.email);
  await form.locator('input[name="password"]').fill(spec.password);
  await form.locator('input[name="locationId"]').fill(LOCATION_ID);
  await form.locator('select[name="workstationMode"]').selectOption(spec.mode);
  await form.locator('button[type="submit"]').click();
  await page.locator("[data-dd008d-admin-menu]").waitFor({ timeout: 30_000 });
  await page.locator("[data-dd008d-migration-panel]").waitFor({ timeout: 30_000 });
}

async function waitForAuthGateReady(page, label) {
  const checkingText = "Đang kiểm tra quyền truy cập.";
  await page.waitForFunction((text) => !document.body.innerText.includes(text), checkingText, { timeout: 25_000 });
  await page.locator("#app").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const text = document.querySelector("#app")?.innerText || "";
    return text.trim().length > 20;
  }, null, { timeout: 15_000 });
  const body = await page.locator("body").innerText();
  assert(!body.includes("Cannot GET"), `${label}: app route failed to render`);
}

async function openCustomer(page, token) {
  await page.goto(`${BASE_URL}/#/t/${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-menu]").waitFor({ timeout: 20_000 }).catch(() => {});
  await page.locator('[data-add-config="mango-tea"], [data-add="espresso"], [data-add="fried-rice"]').first().waitFor({ timeout: 20_000 });
}

async function waitConnectivityOnline(page, timeout = 25_000) {
  await page.locator('[data-dd008d-connectivity][data-state="ONLINE"]').waitFor({ timeout });
}

async function waitForConnectivity(page, states, timeout = 20_000) {
  await waitFor(async () => {
    const state = await page.locator("[data-dd008d-connectivity]").getAttribute("data-state").catch(() => "");
    return states.includes(state);
  }, `connectivity ${states.join("/")}`, timeout);
}

async function progressTicket(page, note, statuses) {
  for (const status of statuses) {
    const ticket = page.locator(".ticket").filter({ hasText: note }).first();
    await ticket.waitFor({ timeout: 30_000 });
    const action = ticket.locator(`[data-station-status="${status}"]`).first();
    await action.waitFor({ timeout: 30_000 });
    await action.click();
    await sleep(100);
  }
}

async function serveAllReadyForNote(page, note, expectedCount) {
  let served = 0;
  while (served < expectedCount) {
    const card = page.locator(".order-card").filter({ hasText: note }).first();
    await card.waitFor({ timeout: 30_000 });
    const button = card.locator("[data-serve-line]").first();
    await button.waitFor({ timeout: 30_000 });
    await button.click();
    served += 1;
    await sleep(100);
  }
}

async function publicSnapshot(token) {
  const result = await rpc(publicClient, "dd008c_get_public_table_snapshot", { p_qr_token: token });
  assert(result.ok === true, `public snapshot failed: ${JSON.stringify(result)}`);
  return result.payload;
}

async function staffSnapshot(client, spec) {
  const result = await rpc(client, "dd008c_get_location_snapshot", {
    p_location_id: LOCATION_ID,
    p_workstation_mode: spec.mode,
    p_device_credential: spec.deviceSecret
  });
  assert(result.ok === true, `staff snapshot failed for ${spec.name}: ${JSON.stringify(result)}`);
  return result.payload;
}

async function waitOrderStatus(client, orderId, status, spec) {
  await waitFor(async () => {
    const snapshot = await staffSnapshot(client, spec);
    return snapshot.orders.find((order) => order.id === orderId)?.status === status;
  }, `${orderId} => ${status}`, 30_000);
}

async function tableOutstanding(client, spec, sessionId) {
  const snapshot = await staffSnapshot(client, spec);
  return snapshot.orders
    .filter((order) => order.tableSessionId === sessionId && !["REJECTED", "VOIDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(order.status))
    .reduce((sum, order) => sum + Math.max(0, Number(order.total || 0) - Number(order.paidVnd || 0)), 0);
}

async function rpc(client, functionName, params) {
  const { data, error } = await client.rpc(functionName, params);
  if (error) return { ok: false, category: classifyError(error), reason: sanitize(error.message || error.code), payload: {} };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return { ok: false, category: "BACKEND_UNAVAILABLE", reason: "EMPTY_RPC_RESULT", payload: {} };
  return {
    ...row,
    entityType: row.entity_type || row.entityType || "",
    entityId: row.entity_id || row.entityId || "",
    payload: row.payload || {}
  };
}

function classifyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (text.includes("jwt") || text.includes("auth")) return "UNAUTHENTICATED";
  if (text.includes("permission") || text.includes("forbidden") || text.includes("42501")) return "FORBIDDEN";
  return "BACKEND_UNAVAILABLE";
}

function psql(statement) {
  return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function psqlScalar(statement) {
  return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-Atc", statement], { encoding: "utf8" }).trim();
}

async function startStaticServer() {
  const root = resolve(process.cwd());
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
  const active = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, BASE_URL).pathname;
      const filePath = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
      if (!filePath.startsWith(root)) throw new Error("invalid path");
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      try {
        const body = await readFile(resolve(root, "index.html"));
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    }
  });
  await new Promise((resolveListen, reject) => {
    active.once("error", reject);
    active.listen(8099, "127.0.0.1", resolveListen);
  });
  return active;
}

async function waitFor(predicate, label, timeout = 20_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForBody(page, text, timeout = 30_000) {
  await page.waitForFunction((expected) => document.body?.innerText?.includes(expected), text, { timeout });
}

async function expectText(locator, text, message) {
  const content = await locator.innerText();
  assert(content.includes(text), `${message}: ${content}`);
}

function assertNoPageErrors() {
  const failures = pages.flatMap((page) => page.__errors.map((error) => `${page.__label}:${error}`));
  if (failures.length) throw new Error(`browser errors:\n${failures.join("\n")}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseEnvOutput(output) {
  return Object.fromEntries(String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    if (index < 0) return [line, ""];
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [key, value];
  }));
}

function sanitize(value) {
  return String(value || "").replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer_[REDACTED]").replace(/[^A-Za-z0-9:_-]+/g, "_").slice(0, 160);
}

function sql(value) {
  return String(value || "").replaceAll("'", "''");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
