import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
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
const failureArtifactDir = resolve(repoRoot, "artifacts", "dd008c-browser-smoke");
const failureScreenshotPath = resolve(failureArtifactDir, "failure.png");

if (!anonKey || !serviceRoleKey) {
  throw new Error("Supabase local anon/service-role keys were not available from `supabase status -o env`.");
}

const backendConfig = Object.freeze({
  mode: "SUPABASE",
  supabaseUrl: apiUrl,
  supabasePublishableKey: anonKey
});

const runId = `dd008c_browser_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const ids = Object.freeze({
  locationA: "deedou-demo",
  locationB: `${runId}_loc_b`,
  owner: `${runId}_owner`,
  cashier: `${runId}_cashier`,
  staff: `${runId}_staff`,
  kitchen: `${runId}_kitchen`,
  manager: `${runId}_manager`,
  inactive: `${runId}_inactive`,
  adminDevice: `${runId}_dev_admin`,
  cashierDevice: `${runId}_dev_cashier`,
  staffDevice: `${runId}_dev_staff`,
  kitchenDevice: `${runId}_dev_kitchen`,
  managerDevice: `${runId}_dev_manager`,
  managerBDevice: `${runId}_dev_manager_b`,
  cashierBDevice: `${runId}_dev_cashier_b`,
  revokedDevice: `${runId}_dev_revoked`
});
const deviceSecrets = Object.freeze({
  admin: secret("admin-device"),
  cashier: secret("cashier-device"),
  staff: secret("staff-device"),
  kitchen: secret("kitchen-device"),
  manager: secret("manager-device"),
  managerB: secret("manager-b-device"),
  cashierB: secret("cashier-b-device"),
  revoked: secret("revoked-device")
});
const diagnosticSecrets = [
  anonKey,
  serviceRoleKey,
  ...Object.values(deviceSecrets)
];

const adminClient = createClient(apiUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
const publicClient = createClient(apiUrl, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const server = await startStaticServer(repoRoot);
const browser = await chromium.launch();
const consoleErrors = [];
const networkRecords = [];
let failureReported = false;

try {
  const users = await provisionRuntimeFixture();
  await runLocalDemoSmoke(browser, server.url, consoleErrors);
  await runSupabaseSmoke(browser, server.url, users, consoleErrors);
  if (consoleErrors.length) {
    throw new Error(`Browser smoke captured app console errors:\n${consoleErrors.join("\n")}`);
  }

  console.log("DD-008C browser smoke passed");
  console.log("LOCAL_DEMO routes: customer, cashier, staff, bar, kitchen, dessert, admin");
  console.log("SUPABASE browser: signed-out QR, sign-in gate, cashier authoritative allow/admin deny, kitchen authoritative allow/cashier/payment/admin deny");
  console.log("SUPABASE browser: manager Location A staff allow, manager Location B denied");
  console.log("SUPABASE browser: cashier Location B denied, inactive denied, wrong/revoked workstation denied, local logout returned to sign-in gate");
  console.log("SUPABASE browser: authoritative route left legacy localStorage business state unchanged");
  console.log("SUPABASE browser: PostgreSQL catalog price/availability rendered in customer QR and cashier counter menu");
  console.log("SUPABASE browser: multi-context realtime customer QR -> staff accept -> KDS prep/ready -> staff serve -> cashier partial/final payment -> authoritative void -> staff reconnect convergence");
  console.log("zero app console errors");
} catch (error) {
  printCollectedDiagnostics(consoleErrors);
  throw error;
} finally {
  await browser.close();
  await server.close();
}

async function provisionRuntimeFixture() {
  const users = {
    owner: await createRuntimeUser("owner"),
    cashier: await createRuntimeUser("cashier"),
    staff: await createRuntimeUser("staff"),
    kitchen: await createRuntimeUser("kitchen"),
    manager: await createRuntimeUser("manager"),
    inactive: await createRuntimeUser("inactive")
  };

  runPsql(`
begin;

insert into public.locations (id, name, timezone, currency)
values (${lit(ids.locationB)}, 'DD-008C Browser Smoke B', 'Asia/Saigon', 'VND')
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  (${lit(ids.owner)}, ${lit(users.owner.id)}::uuid, 'Browser Smoke Owner', true),
  (${lit(ids.cashier)}, ${lit(users.cashier.id)}::uuid, 'Browser Smoke Cashier', true),
  (${lit(ids.staff)}, ${lit(users.staff.id)}::uuid, 'Browser Smoke Staff', true),
  (${lit(ids.kitchen)}, ${lit(users.kitchen.id)}::uuid, 'Browser Smoke Kitchen', true),
  (${lit(ids.manager)}, ${lit(users.manager.id)}::uuid, 'Browser Smoke Manager', true),
  (${lit(ids.inactive)}, ${lit(users.inactive.id)}::uuid, 'Browser Smoke Inactive', false)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  (${lit(ids.owner)}, ${lit(ids.locationA)}, true),
  (${lit(ids.cashier)}, ${lit(ids.locationA)}, true),
  (${lit(ids.staff)}, ${lit(ids.locationA)}, true),
  (${lit(ids.kitchen)}, ${lit(ids.locationA)}, true),
  (${lit(ids.manager)}, ${lit(ids.locationA)}, true),
  (${lit(ids.inactive)}, ${lit(ids.locationA)}, true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  (${lit(ids.owner)}, ${lit(ids.locationA)}, 'OWNER', true),
  (${lit(ids.cashier)}, ${lit(ids.locationA)}, 'CASHIER', true),
  (${lit(ids.staff)}, ${lit(ids.locationA)}, 'FLOOR_STAFF', true),
  (${lit(ids.kitchen)}, ${lit(ids.locationA)}, 'KITCHEN', true),
  (${lit(ids.manager)}, ${lit(ids.locationA)}, 'MANAGER', true),
  (${lit(ids.inactive)}, ${lit(ids.locationA)}, 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  (${lit(ids.adminDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Admin', 'ADMIN', public.hash_device_credential(${lit(deviceSecrets.admin)}), true, ${lit(ids.owner)}),
  (${lit(ids.cashierDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Cashier', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashier)}), true, ${lit(ids.owner)}),
  (${lit(ids.staffDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Staff', 'STAFF', public.hash_device_credential(${lit(deviceSecrets.staff)}), true, ${lit(ids.owner)}),
  (${lit(ids.kitchenDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Kitchen', 'KDS_KITCHEN', public.hash_device_credential(${lit(deviceSecrets.kitchen)}), true, ${lit(ids.owner)}),
  (${lit(ids.managerDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Manager Staff', 'STAFF', public.hash_device_credential(${lit(deviceSecrets.manager)}), true, ${lit(ids.owner)}),
  (${lit(ids.managerBDevice)}, ${lit(ids.locationB)}, 'Browser Smoke Manager B Staff', 'STAFF', public.hash_device_credential(${lit(deviceSecrets.managerB)}), true, ${lit(ids.owner)}),
  (${lit(ids.cashierBDevice)}, ${lit(ids.locationB)}, 'Browser Smoke Cashier B', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashierB)}), true, ${lit(ids.owner)}),
  (${lit(ids.revokedDevice)}, ${lit(ids.locationA)}, 'Browser Smoke Revoked', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.revoked)}), false, ${lit(ids.owner)})
on conflict (id) do nothing;

update public.products
set periods = array['morning','afternoon','evening']::text[],
    price_vnd = case when id = 'espresso' then 41000 else price_vnd end,
    available = case when id = 'coconut-coffee' then false else available end
where location_id = ${lit(ids.locationA)}
  and id in ('fried-rice', 'espresso', 'mango-tea', 'coconut-coffee');

update public.product_variants
set available = false
where product_id = 'mango-tea'
  and variant_key = 'large';

update public.modifier_options
set available = false
where option_key = 'aloe-vera'
  and modifier_group_id in (
    select id
    from public.modifier_groups
    where location_id = ${lit(ids.locationA)}
  );

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
      await withFailureDiagnostics(page, `LOCAL_DEMO ${label}`, errorSink, async () => {
        await page.goto(`${baseUrl}/index.html?v=dd008b-local-smoke${hashRoute}`, { waitUntil: "domcontentloaded" });
        await assertAppReady(page, `LOCAL_DEMO ${label}`);
        assert.equal(await page.locator(".auth-gate").count(), 0, `LOCAL_DEMO ${label} should not show Supabase auth gate`);
        assertNotContains(await bodyText(page), "Cannot GET", `LOCAL_DEMO ${label}`);
        await settle();
      });
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
    await withFailureDiagnostics(cashierPage, "SUPABASE cashier allow/authoritative", errorSink, async () => {
      await verifySignedOutGateNoFlash(cashierPage, `${baseUrl}/index.html?v=dd008c-supabase#/cashier`, "Cashier POS");
      await loginThroughGate(cashierPage, users.cashier, ids.locationA, "CASHIER");
      await expectAuthoritativeAuthorized(cashierPage, "Cashier");
      await cashierPage.locator("[data-counter-open]").first().click();
      await waitForBodyIncludes(cashierPage, "41.000 đ", "cashier PostgreSQL catalog price");
      assertNotContains(await bodyText(cashierPage), "Cà phê dừa", "cashier PostgreSQL catalog availability");
      assertNotContains(await bodyText(cashierPage), "Coconut Coffee", "cashier PostgreSQL catalog availability");
      await expectLegacyBusinessStateUnchanged(cashierPage, "Cashier");
    });

    await withFailureDiagnostics(cashierPage, "SUPABASE cashier denied admin", errorSink, async () => {
      await cashierPage.goto(`${baseUrl}/index.html?v=dd008c-supabase#/admin`, { waitUntil: "domcontentloaded" });
      await expectDeniedGate(cashierPage, "cashier denied admin", ["DeeDou POS setup"]);
    });

    await withFailureDiagnostics(cashierPage, "SUPABASE cashier logout", errorSink, async () => {
      await cashierPage.goto(`${baseUrl}/index.html?v=dd008c-supabase#/cashier`, { waitUntil: "domcontentloaded" });
      await expectAuthoritativeAuthorized(cashierPage, "Cashier");
      await cashierPage.locator("[data-auth-logout]").first().click();
      await expectSignedOutGate(cashierPage, "cashier logout");
    });
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
    await withFailureDiagnostics(kitchenPage, "SUPABASE kitchen allow/authoritative", errorSink, async () => {
      await kitchenPage.goto(`${baseUrl}/index.html?v=dd008c-supabase#/kitchen`, { waitUntil: "domcontentloaded" });
      await loginThroughGate(kitchenPage, users.kitchen, ids.locationA, "KDS_KITCHEN");
      await expectAuthoritativeAuthorized(kitchenPage, "Kitchen KDS");
    });

    for (const [routeName, forbidden] of [
      ["cashier", ["Cashier POS"]],
      ["bar", ["Bar drinks queue"]],
      ["admin", ["DeeDou POS setup"]]
    ]) {
      await withFailureDiagnostics(kitchenPage, `SUPABASE kitchen denied ${routeName}`, errorSink, async () => {
        await kitchenPage.goto(`${baseUrl}/index.html?v=dd008c-supabase#/${routeName}`, { waitUntil: "domcontentloaded" });
        await expectDeniedGate(kitchenPage, `kitchen denied ${routeName}`, forbidden);
      });
    }
  } finally {
    await kitchenContext.close();
  }

  const managerContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE manager",
    deviceCredential: deviceSecrets.manager,
    workstationMode: "STAFF",
    locationId: ids.locationA
  });
  try {
    const managerPage = await newObservedPage(managerContext, "SUPABASE manager", errorSink);
    await withFailureDiagnostics(managerPage, "SUPABASE manager Location A staff allow/authoritative", errorSink, async () => {
      await managerPage.goto(`${baseUrl}/index.html?v=dd008c-supabase#/staff`, { waitUntil: "domcontentloaded" });
      await loginThroughGate(managerPage, users.manager, ids.locationA, "STAFF");
      await expectAuthoritativeAuthorized(managerPage, "Staff");
    });
  } finally {
    await managerContext.close();
  }

  await expectDeniedLogin(activeBrowser, baseUrl, errorSink, {
    label: "SUPABASE manager Location B denied",
    user: users.manager,
    locationId: ids.locationB,
    workstationMode: "STAFF",
    deviceCredential: deviceSecrets.managerB,
    routeName: "staff",
    forbidden: ["Staff đã xác thực"]
  });

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

  await runOperationalRealtimeE2E(activeBrowser, baseUrl, users, errorSink);
}

async function runOperationalRealtimeE2E(activeBrowser, baseUrl, users, errorSink) {
  const note = `DD-008C browser operational E2E ${runId}`;
  const customerContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE E2E customer",
    deviceCredential: "",
    workstationMode: "",
    locationId: ids.locationA,
    timezoneId: "Asia/Ho_Chi_Minh"
  });
  const staffContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE E2E staff",
    deviceCredential: deviceSecrets.staff,
    workstationMode: "STAFF",
    locationId: ids.locationA
  });
  const kitchenContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE E2E kitchen",
    deviceCredential: deviceSecrets.kitchen,
    workstationMode: "KDS_KITCHEN",
    locationId: ids.locationA
  });
  const cashierContext = await createSupabaseContext(activeBrowser, {
    label: "SUPABASE E2E cashier",
    deviceCredential: deviceSecrets.cashier,
    workstationMode: "CASHIER",
    locationId: ids.locationA
  });

  let staffClosedForReconnect = false;
  try {
    const customerPage = await newObservedPage(customerContext, "SUPABASE E2E customer", errorSink);
    const staffPage = await newObservedPage(staffContext, "SUPABASE E2E staff", errorSink);
    const kitchenPage = await newObservedPage(kitchenContext, "SUPABASE E2E kitchen", errorSink);
    const cashierPage = await newObservedPage(cashierContext, "SUPABASE E2E cashier", errorSink);
    const realtimeTicketBaseline = await activeRealtimeTicketCount();

    await withFailureDiagnostics(staffPage, "SUPABASE operational realtime E2E", errorSink, async () => {
      await staffPage.goto(`${baseUrl}/index.html?v=dd008c-operational-e2e#/staff`, { waitUntil: "domcontentloaded" });
      await loginThroughGate(staffPage, users.staff, ids.locationA, "STAFF");
      await expectAuthoritativeAuthorized(staffPage, "Staff operational E2E");

      await kitchenPage.goto(`${baseUrl}/index.html?v=dd008c-operational-e2e#/kitchen`, { waitUntil: "domcontentloaded" });
      await loginThroughGate(kitchenPage, users.kitchen, ids.locationA, "KDS_KITCHEN");
      await expectAuthoritativeAuthorized(kitchenPage, "Kitchen operational E2E");

      await cashierPage.goto(`${baseUrl}/index.html?v=dd008c-operational-e2e#/cashier`, { waitUntil: "domcontentloaded" });
      await loginThroughGate(cashierPage, users.cashier, ids.locationA, "CASHIER");
      await expectAuthoritativeAuthorized(cashierPage, "Cashier operational E2E");
      await cashierPage.locator('[data-select-table="A01"]').click().catch(() => {});

      await waitForCondition(
        async () => await activeRealtimeTicketCount() >= realtimeTicketBaseline + 4,
        "separate browser contexts issued ops/cashier realtime tickets"
      );

      await withFailureDiagnostics(customerPage, "SUPABASE operational realtime E2E customer menu", errorSink, async () => {
        await customerPage.clock.setFixedTime(new Date("2026-08-15T20:00:00+07:00"));
        await customerPage.goto(`${baseUrl}/index.html?v=dd008c-operational-e2e#/t/beach-a01-47VLmz`, { waitUntil: "domcontentloaded" });
        await assertAppReady(customerPage, "SUPABASE E2E customer");
        await customerPage.locator("#note").fill(note);
        const friedRiceAdd = customerPage.locator('[data-add="fried-rice"]').first();
        try {
          await friedRiceAdd.waitFor({ state: "visible", timeout: 10000 });
        } catch (error) {
          const renderedText = await bodyText(customerPage).catch(() => "");
          throw new Error(`evening kitchen fixture missing: fried-rice was not visible under deterministic Asia/Ho_Chi_Minh evening clock. ${error?.message || ""} Body: ${sanitizeDiagnosticText(renderedText).slice(0, 500)}`);
        }
        await friedRiceAdd.click();
        await customerPage.locator("[data-submit]").first().click();
        const customerPendingOrder = customerPage.locator(".status-strip .status-pill").first();
        await customerPendingOrder.waitFor({ state: "visible", timeout: 30000 });
        const pendingText = await customerPendingOrder.innerText();
        assertContains(pendingText, "DeeDou đang kiểm tra order của bạn.", "customer QR authoritative pending order");
        assertContains(pendingText, "99.000 đ", "customer QR authoritative total");
      });

      const staffCard = staffPage.locator(".order-card").filter({ hasText: note }).first();
      await staffCard.waitFor({ timeout: 30000 });
      const orderNoText = await staffCard.locator(".order-head strong").first().innerText();
      const orderNo = orderNoText.split(" - ")[0].trim();
      assert(orderNo, "operational E2E order number was not rendered on staff page");

      await staffCard.locator('button[data-status="ACCEPTED"]').click();
      const kitchenTicket = kitchenPage.locator(".ticket").filter({ hasText: note }).first();
      await kitchenTicket.locator('[data-station-status="ACKNOWLEDGED"]').waitFor({ timeout: 30000 });
      assertContains(await kitchenTicket.innerText(), "Immediate", "KDS ticket fired-course display");

      await clickStationAction(kitchenPage, note, "ACKNOWLEDGED");
      await waitForBodyIncludes(staffPage, "ACKNOWLEDGED", "staff sees KDS acknowledged update");
      await clickStationAction(kitchenPage, note, "PREPARING");
      await waitForBodyIncludes(staffPage, "PREPARING", "staff sees KDS preparing update");
      await clickStationAction(kitchenPage, note, "READY");

      const readyStaffCard = staffPage.locator(".order-card").filter({ hasText: note }).first();
      await readyStaffCard.locator("[data-serve-line]").first().waitFor({ timeout: 30000 });
      await readyStaffCard.locator("[data-serve-line]").first().click();

      await waitForBodyIncludes(cashierPage, orderNo, "cashier sees served order after staff action");
      await cashierPage.waitForFunction(() => document.body.innerText.includes("1/1 món"), null, { timeout: 30000 });

      await cashierPage.locator('input[data-payment-amount="A01"]').fill("39000");
      await cashierPage.locator('button[data-table-pay="A01"][data-method="CASH"]').click();
      await waitForBodyIncludes(cashierPage, "60.000", "cashier sees partial payment outstanding");
      assertNotContains(await bodyText(staffPage), "PAY-", "staff page should not expose cashier payment ledger");

      await cashierPage.locator('input[data-payment-amount="A01"]').fill("60000");
      await cashierPage.locator('button[data-table-pay="A01"][data-method="CASH"]').click();
      await waitForBodyIncludes(cashierPage, "PAID", "cashier sees final payment");
      await waitForBodyIncludes(staffPage, orderNo, "staff remains operational after cashier payment");

      const voidNote = `DD-008C browser void order ${runId}`;
      const { data: voidData, error: voidError } = await publicClient.rpc("submit_qr_order", {
        p_qr_token: "beach-a01-47VLmz",
        p_items: [{ productId: "espresso", qty: 1 }],
        p_note: voidNote,
        p_idempotency_key: `${runId}_browser_void_order_submit`
      });
      const voidSubmit = Array.isArray(voidData) ? voidData[0] : voidData;
      if (voidError || voidSubmit?.ok !== true) {
        throw new Error(`public QR order for cashier void failed: ${voidError?.message || JSON.stringify(voidSubmit)}`);
      }
      const voidOrderNo = voidSubmit.payload?.order?.orderNo || voidSubmit.entity_id;
      await cashierPage.locator('[data-select-table="A01"]').click().catch(() => {});
      await waitForBodyIncludes(cashierPage, voidOrderNo, "cashier sees unpaid QR order before void");
      const voidCard = cashierPage.locator(".order-card").filter({ hasText: voidOrderNo }).first();
      await voidCard.locator("[data-void]").first().click();
      await cashierPage.locator(`[data-void-reason="${voidSubmit.entity_id}"]`).fill("browser smoke void unpaid");
      await cashierPage.locator(`[data-void-confirm="${voidSubmit.entity_id}"]`).click();
      await waitForBodyIncludes(cashierPage, "VOIDED", "cashier sees authoritative voided order");
      await waitForBodyIncludes(cashierPage, voidOrderNo, "cashier sees voided order in closed history");
      assertNotContains(await bodyText(kitchenPage), voidOrderNo, "KDS should not show cashier-voided pending order");

      await staffContext.close();
      staffClosedForReconnect = true;
      const { data, error } = await publicClient.rpc("create_service_request", {
        p_qr_token: "beach-a01-47VLmz",
        p_type: "CALL_STAFF",
        p_idempotency_key: `${runId}_browser_reconnect_request`
      });
      const requestResult = Array.isArray(data) ? data[0] : data;
      if (error || requestResult?.ok !== true) {
        throw new Error(`public service request for reconnect failed: ${error?.message || JSON.stringify(requestResult)}`);
      }

      const reconnectContext = await createSupabaseContext(activeBrowser, {
        label: "SUPABASE E2E staff reconnect",
        deviceCredential: deviceSecrets.staff,
        workstationMode: "STAFF",
        locationId: ids.locationA
      });
      try {
        const reconnectPage = await newObservedPage(reconnectContext, "SUPABASE E2E staff reconnect", errorSink);
        await reconnectPage.goto(`${baseUrl}/index.html?v=dd008c-operational-e2e#/staff`, { waitUntil: "domcontentloaded" });
        await loginThroughGate(reconnectPage, users.staff, ids.locationA, "STAFF");
        await expectAuthoritativeAuthorized(reconnectPage, "Staff reconnect operational E2E");
        await waitForBodyIncludes(reconnectPage, "CALL STAFF - Table A01", "reconnected staff authoritative refetch converged");
      } finally {
        await reconnectContext.close();
      }
    });
  } finally {
    await customerContext.close();
    if (!staffClosedForReconnect) await staffContext.close();
    await kitchenContext.close();
    await cashierContext.close();
  }
}

async function clickStationAction(page, note, status) {
  const ticket = page.locator(".ticket").filter({ hasText: note }).first();
  await ticket.locator(`[data-station-status="${status}"]`).first().click();
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
    await withFailureDiagnostics(page, "SUPABASE public QR", errorSink, async () => {
      await page.goto(`${baseUrl}/index.html?v=dd008c-supabase#/t/beach-a01-47VLmz`, { waitUntil: "domcontentloaded" });
      await assertAppReady(page, "SUPABASE public QR");
      assert.equal(await page.locator(".auth-gate").count(), 0, "public QR should not require staff sign-in");
      assertContains(await bodyText(page), "DeeDou", "public QR");
      await waitForBodyIncludes(page, "41.000 đ", "public QR PostgreSQL catalog price");
      assertNotContains(await bodyText(page), "Cà phê dừa", "public QR PostgreSQL catalog availability");
      assertNotContains(await bodyText(page), "Coconut Coffee", "public QR PostgreSQL catalog availability");
    });
  } finally {
    await context.close();
  }
}

async function expectDeniedLogin(activeBrowser, baseUrl, errorSink, options) {
  const context = await createSupabaseContext(activeBrowser, options);
  try {
    const page = await newObservedPage(context, options.label, errorSink);
    await withFailureDiagnostics(page, options.label, errorSink, async () => {
      await page.goto(`${baseUrl}/index.html?v=dd008c-supabase#/${options.routeName}`, { waitUntil: "domcontentloaded" });
      await loginThroughGate(page, options.user, options.locationId, options.workstationMode);
      await expectDeniedGate(page, options.label, options.forbidden || []);
    });
  } finally {
    await context.close();
  }
}

async function createSupabaseContext(activeBrowser, options) {
  const context = await activeBrowser.newContext(options.timezoneId ? { timezoneId: options.timezoneId } : {});
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
  page.on("requestfailed", (request) => {
    if (!isRelevantNetworkUrl(request.url())) return;
    networkRecords.push({
      label,
      type: "requestfailed",
      url: safeNetworkUrl(request.url()),
      error: sanitizeDiagnosticText(request.failure()?.errorText || "unknown")
    });
  });
  page.on("response", (response) => {
    if (!isRelevantNetworkUrl(response.url())) return;
    networkRecords.push({
      label,
      type: "response",
      url: safeNetworkUrl(response.url()),
      status: response.status()
    });
  });
  return page;
}

async function withFailureDiagnostics(page, label, errorSink, operation) {
  try {
    return await operation();
  } catch (error) {
    await reportFailureDiagnostics({ page, label, error, errorSink });
    throw error;
  }
}

async function reportFailureDiagnostics({ page, label, error, errorSink }) {
  if (failureReported) return;
  failureReported = true;

  console.error("DD-008C BROWSER-SMOKE DIAGNOSTIC FAILURE");
  console.error(`phase: ${sanitizeDiagnosticText(label)}`);
  console.error(`error: ${sanitizeDiagnosticText(error?.stack || error?.message || String(error))}`);

  try {
    const diagnostics = await collectSafePageDiagnostics(page);
    console.error(`safe page diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  } catch (diagnosticError) {
    console.error(`safe page diagnostics failed: ${sanitizeDiagnosticText(diagnosticError?.message || String(diagnosticError))}`);
  }

  await writeFailureScreenshot(page);
  printCollectedDiagnostics(errorSink);
}

async function collectSafePageDiagnostics(page) {
  return page.evaluate(() => {
    const textLimit = 5000;
    const authGate = document.querySelector(".auth-gate");
    const bodyText = document.body?.innerText || "";
    const authGateText = authGate?.innerText || "";
    return {
      currentUrl: location.href,
      hash: location.hash,
      bodyText: bodyText.slice(0, textLimit),
      bodyTextTruncated: bodyText.length > textLimit,
      authGate: {
        exists: Boolean(authGate),
        text: authGateText.slice(0, textLimit),
        textTruncated: authGateText.length > textLimit
      },
      loginFormExists: Boolean(document.querySelector("form[data-auth-login]")),
      logoutExists: document.querySelectorAll("[data-auth-logout]").length > 0,
      supabaseCommandExists: Boolean(document.querySelector("[data-supabase-command]")),
      storedLocationId: localStorage.getItem("deedou_staff_location_id") || "",
      storedWorkstationMode: localStorage.getItem("deedou_workstation_mode") || "",
      hasDeviceCredential: Boolean(localStorage.getItem("deedou_device_credential"))
    };
  }).then((diagnostics) => sanitizeDiagnosticValue(diagnostics));
}

async function writeFailureScreenshot(page) {
  try {
    await mkdir(failureArtifactDir, { recursive: true });
    await page.screenshot({ path: failureScreenshotPath, fullPage: true });
    console.error(`failure screenshot: ${failureScreenshotPath}`);
  } catch (screenshotError) {
    console.error(`failure screenshot failed: ${sanitizeDiagnosticText(screenshotError?.message || String(screenshotError))}`);
  }
}

function printCollectedDiagnostics(errorSink = []) {
  const safeConsoleErrors = (errorSink || []).map(sanitizeDiagnosticText);
  const safeNetworkRecords = networkRecords.map(sanitizeDiagnosticValue);
  console.error(`browser console/page errors: ${JSON.stringify(safeConsoleErrors, null, 2)}`);
  console.error(`filtered network diagnostics: ${JSON.stringify(safeNetworkRecords, null, 2)}`);
}

function isRelevantNetworkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;
    return (url.hostname === "cdn.jsdelivr.net" && path.includes("/@supabase/supabase-js@"))
      || path.includes("/auth/v1/")
      || path === "/rest/v1/rpc/authorize_staff_access"
      || path === "/rest/v1/rpc/get_my_staff_context"
      || path === "/rest/v1/rpc/dd008c_issue_realtime_ticket"
      || path === "/rest/v1/rpc/dd008c_get_location_snapshot"
      || path === "/rest/v1/rpc/submit_qr_order"
      || path === "/rest/v1/rpc/dd008c_get_public_table_snapshot"
      || path === "/rest/v1/rpc/void_order";
  } catch {
    return false;
  }
}

function safeNetworkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "cdn.jsdelivr.net") return `${url.hostname}${url.pathname}`;
    return url.pathname;
  } catch {
    return sanitizeDiagnosticText(rawUrl);
  }
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
  assert.equal(await page.locator("[data-supabase-command]").count(), 0, `${label} should not expose obsolete fail-closed command surface`);
}

async function loginThroughGate(page, user, locationId, workstationMode) {
  await page.locator("form[data-auth-login]").waitFor({ timeout: 20000 });
  await waitForNotChecking(page);
  await assertAppReady(page, `login gate ${workstationMode}`);
  await page.locator('form[data-auth-login] input[name="email"]').fill(user.email);
  await page.locator('form[data-auth-login] input[name="password"]').fill(user.password);
  await page.locator('form[data-auth-login] input[name="locationId"]').fill(locationId);
  await page.locator('form[data-auth-login] select[name="workstationMode"]').selectOption(workstationMode);
  await page.locator('form[data-auth-login] button[type="submit"]').click();
}

async function expectAuthoritativeAuthorized(page, routeLabel) {
  await waitForNotChecking(page);
  await page.waitForFunction(() => {
    const text = document.body.innerText || "";
    return !text.includes("Đang tải dữ liệu Supabase") && !text.includes("Không tải được dữ liệu Supabase") && !document.querySelector("form[data-auth-login]");
  }, null, { timeout: 25000 }).catch(async () => {
    await page.waitForFunction(() => !document.querySelector("form[data-auth-login]"), null, { timeout: 25000 });
  });
  await assertAppReady(page, `authorized ${routeLabel}`);
  assert.equal(await page.locator("form[data-auth-login]").count(), 0, `authorized ${routeLabel} should not remain on login form`);
  assert.equal(await page.locator(".auth-gate").count(), 0, `authorized ${routeLabel} should not show auth gate`);
  assert.equal(await page.locator("[data-supabase-command]").count(), 0, `authorized ${routeLabel} should not show obsolete fail-closed command surface`);
}

async function expectDeniedGate(page, label, forbiddenTexts = []) {
  await page.locator(".auth-gate").waitFor({ timeout: 25000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-auth-logout]").length > 0, null, { timeout: 25000 });
  await waitForNotChecking(page);
  await assertAppReady(page, label);
  assert.equal(await page.locator("[data-supabase-command]").count(), 0, `${label} should not expose obsolete fail-closed command button`);
  assert.ok(await page.locator("form[data-auth-login]").count() > 0, `${label} should show a signed-in permission review form`);
  const text = await bodyText(page);
  forbiddenTexts.forEach((forbidden) => assertNotContains(text, forbidden, label));
}

async function waitForNotChecking(page) {
  const checkingText = "\u0110ang ki\u1ec3m tra quy\u1ec1n truy c\u1eadp.";
  await page.waitForFunction((text) => !document.body.innerText.includes(text), checkingText, { timeout: 25000 });
}

async function expectLegacyBusinessStateUnchanged(page, routeLabel) {
  const storageKey = "deedou_state";
  const sentinelState = JSON.stringify({
    cart: [{ id: "legacy-sentinel", qty: 1 }],
    orders: [{
      id: "legacy-sentinel-order",
      orderNo: "LEGACY-SENTINEL",
      table: "A01",
      zone: "Beach",
      status: "ACCEPTED",
      total: 12345,
      items: [{ id: "legacy-sentinel-item", lineId: "legacy-sentinel:item", nameVi: "LEGACY SENTINEL ITEM", nameEn: "LEGACY SENTINEL ITEM", qty: 1, price: 12345, status: "QUEUED" }],
      serviceMode: "TABLE_SERVICE",
      fulfillmentType: "DINE_IN",
      orderSource: "STAFF"
    }],
    events: [],
    audit: [],
    sequence: 987,
    tableSessions: []
  });
  await page.evaluate(([key, value]) => {
    window.localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: window.localStorage }));
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel("deedou-pos");
      channel.postMessage({ type: "sync", at: Date.now() });
      channel.close();
    }
  }, [storageKey, sentinelState]);
  await expectAuthoritativeAuthorized(page, routeLabel);
  assertNotContains(await bodyText(page), "LEGACY-SENTINEL", `${routeLabel} storage event should not replace authoritative state`);
  assertNotContains(await bodyText(page), "LEGACY SENTINEL ITEM", `${routeLabel} broadcast should not replace authoritative state`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectAuthoritativeAuthorized(page, routeLabel);
  assertNotContains(await bodyText(page), "LEGACY-SENTINEL", `${routeLabel} reload should not use legacy business state`);
  const stored = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
  assert.equal(stored, sentinelState, "SUPABASE authoritative route must not mutate legacy localStorage business state");
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

async function waitForBodyIncludes(page, expected, label, timeout = 30000) {
  await page.waitForFunction((text) => document.body.innerText.includes(text), expected, { timeout });
  assertContains(await bodyText(page), expected, label);
}

async function waitForCondition(predicate, label, timeout = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function activeRealtimeTicketCount() {
  const output = execFileSync("psql", [
    dbUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-X",
    "-A",
    "-t",
    "-c",
    `select count(*) from public.dd008c_realtime_subscription_tickets where location_id = ${lit(ids.locationA)} and expires_at > now();`
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const count = Number.parseInt(output.trim(), 10);
  if (!Number.isFinite(count)) throw new Error("Could not count active realtime tickets from trusted DB connection");
  return count;
}

async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/api/runtime-config") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end("/* DD-008P local smoke runtime config no-op */");
        return;
      }
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
  diagnosticSecrets.push(password);
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { dd008c_browser_smoke: runId, kind }
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

function sanitizeDiagnosticValue(value) {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDiagnosticValue(item)]));
}

function sanitizeDiagnosticText(value) {
  let text = String(value || "")
    .replace(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "Bearer [JWT_REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .replace(/(authorization|apikey|password|refresh_token|access_token)=([^&\s]+)/gi, "$1=[SECRET_REDACTED]");
  diagnosticSecrets.filter(Boolean).forEach((secretValue) => {
    text = text.split(secretValue).join("[SECRET_REDACTED]");
  });
  return text;
}

function settle() {
  return new Promise((resolveSettle) => setTimeout(resolveSettle, 250));
}
