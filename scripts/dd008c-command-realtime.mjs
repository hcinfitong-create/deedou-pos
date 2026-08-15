import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const AUTH_PASSWORD_MAX_BYTES = 64;
const LOCATION_ID = "deedou-demo";
const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY;
const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY || statusEnv.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.DB_URL || statusEnv.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!anonKey || !serviceRoleKey) {
  throw new Error("Supabase local anon/service-role keys were not available from `supabase status -o env`.");
}

const runId = `dd008c_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const ids = {
  qrTable: `${runId}_table_qr`,
  openTable: `${runId}_table_open`,
  paymentRaceTable: `${runId}_table_payment_race`,
  transferA: `${runId}_table_transfer_a`,
  transferB: `${runId}_table_transfer_b`,
  transferDest: `${runId}_table_transfer_dest`,
  cashier: `${runId}_cashier`,
  staff: `${runId}_staff`,
  kitchen: `${runId}_kitchen`,
  cashierDevice: `${runId}_dev_cashier`,
  staffDevice: `${runId}_dev_staff`,
  kitchenDevice: `${runId}_dev_kitchen`
};
const codes = {
  qrTable: `Q${runId.slice(-5).toUpperCase()}`,
  openTable: `O${runId.slice(-5).toUpperCase()}`,
  paymentRaceTable: `R${runId.slice(-5).toUpperCase()}`,
  transferA: `A${runId.slice(-5).toUpperCase()}`,
  transferB: `B${runId.slice(-5).toUpperCase()}`,
  transferDest: `C${runId.slice(-5).toUpperCase()}`
};
const qrToken = `${runId}_qr_token`;
const deviceSecrets = {
  cashier: secret("cashier-device"),
  staff: secret("staff-device"),
  kitchen: secret("kitchen-device")
};

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

const users = {
  cashier: await createRuntimeUser("cashier"),
  staff: await createRuntimeUser("staff"),
  kitchen: await createRuntimeUser("kitchen")
};

provisionRuntimeData();

const cashierClient = await loginRuntimeUser("cashier");
const staffClient = await loginRuntimeUser("staff");
const kitchenClient = await loginRuntimeUser("kitchen");
const staffRefresh = await subscribeRefreshHints(staffClient, { label: "staff", audiences: ["ops"] });
const cashierRefresh = await subscribeRefreshHints(cashierClient, { label: "cashier", audiences: ["ops", "cashier"] });
await Promise.all([
  assertRefreshStreamReady(staffRefresh.events, "staff ops"),
  assertRefreshStreamReady(cashierRefresh.events, "cashier ops/cashier")
]);

const concurrentOrders = await Promise.all([
  command(publicClient, "submit_qr_order", {
    p_qr_token: qrToken,
    p_items: [{ productId: "fried-rice", qty: 1, price: 1 }],
    p_note: "DD-008C concurrent QR order A",
    p_idempotency_key: `${runId}_qr_same_key`
  }),
  command(publicClient, "submit_qr_order", {
    p_qr_token: qrToken,
    p_items: [{ productId: "fried-rice", qty: 1, price: 1 }],
    p_note: "DD-008C concurrent QR order A",
    p_idempotency_key: `${runId}_qr_same_key`
  })
]);
assert(concurrentOrders[0].ok === true && concurrentOrders[1].ok === true, "same QR idempotency key should replay successfully");
assert(concurrentOrders[0].entity_id === concurrentOrders[1].entity_id, "same QR idempotency key returned different orders");
const orderId = concurrentOrders[0].entity_id;
await Promise.all([
  waitForRefresh(staffRefresh.events, (event) => refreshEntityId(event) === orderId, "staff customer submit refresh hint"),
  waitForRefresh(cashierRefresh.events, (event) => refreshEntityId(event) === orderId, "cashier customer submit refresh hint")
]);
assertDedupCount("submit_qr_order", `${runId}_qr_same_key`, 1);

let snapshot = await locationSnapshot(staffClient, "STAFF", deviceSecrets.staff);
assert(snapshot.orders.some((order) => order.id === orderId), "staff snapshot did not include submitted order after refresh/refetch");
let cashierSnapshot = await locationSnapshot(cashierClient, "CASHIER", deviceSecrets.cashier);
assert(cashierSnapshot.orders.some((order) => order.id === orderId), "cashier snapshot did not converge to submitted order after independent refresh/refetch");

const accepted = await command(staffClient, "set_order_status", {
  p_location_id: LOCATION_ID,
  p_order_id: orderId,
  p_status: "ACCEPTED",
  p_expected_version: concurrentOrders[0].version,
  p_idempotency_key: `${runId}_accept`,
  p_workstation_mode: "STAFF",
  p_device_credential: deviceSecrets.staff
});
assertCommand(accepted, true, "", "staff accepted QR order");

const stale = await command(staffClient, "set_order_status", {
  p_location_id: LOCATION_ID,
  p_order_id: orderId,
  p_status: "READY",
  p_expected_version: 1,
  p_idempotency_key: `${runId}_stale_ready`,
  p_workstation_mode: "STAFF",
  p_device_credential: deviceSecrets.staff
});
assertCommand(stale, false, "STALE_VERSION", "stale expectedVersion rejected");
assertOrderField(orderId, "status", "ACCEPTED", "stale command mutated order status");

const lineId = "fried-rice:1:item";
let version = accepted.version;
const courseConflicts = await Promise.all([
  command(staffClient, "assign_order_family_course", {
    p_location_id: LOCATION_ID,
    p_order_id: orderId,
    p_family_line_id: lineId,
    p_course: "1",
    p_idempotency_key: `${runId}_course_conflict_a`,
    p_workstation_mode: "STAFF",
    p_device_credential: deviceSecrets.staff,
    p_expected_version: version
  }),
  command(staffClient, "assign_order_family_course", {
    p_location_id: LOCATION_ID,
    p_order_id: orderId,
    p_family_line_id: lineId,
    p_course: "2",
    p_idempotency_key: `${runId}_course_conflict_b`,
    p_workstation_mode: "STAFF",
    p_device_credential: deviceSecrets.staff,
    p_expected_version: version
  })
]);
const courseSuccesses = courseConflicts.filter((result) => result.ok === true);
const courseStale = courseConflicts.filter((result) => result.ok === false && result.reason === "STALE_VERSION");
assert(courseSuccesses.length === 1 && courseStale.length === 1, "conflicting course assignments should produce one success and one stale-version conflict");
version = courseSuccesses[0].version;
for (const nextPrepStatus of ["ACKNOWLEDGED", "PREPARING", "READY"]) {
  const result = await command(kitchenClient, "update_kds_line_prep", {
    p_location_id: LOCATION_ID,
    p_order_id: orderId,
    p_line_ids: [lineId],
    p_next_prep_status: nextPrepStatus,
    p_expected_version: version,
    p_idempotency_key: `${runId}_kds_${nextPrepStatus.toLowerCase()}`,
    p_workstation_mode: "KDS_KITCHEN",
    p_device_credential: deviceSecrets.kitchen
  });
  assertCommand(result, true, "", `KDS ${nextPrepStatus}`);
  version = result.version;
}

snapshot = await locationSnapshot(kitchenClient, "KDS_KITCHEN", deviceSecrets.kitchen);
assert(snapshot.orders.some((order) => order.id === orderId && order.status === "READY"), "KDS/client refetch did not converge to READY order");

const served = await command(staffClient, "serve_order_line", {
  p_location_id: LOCATION_ID,
  p_order_id: orderId,
  p_line_id: lineId,
  p_qty: 1,
  p_expected_version: version,
  p_idempotency_key: `${runId}_serve_line`,
  p_workstation_mode: "STAFF",
  p_device_credential: deviceSecrets.staff
});
assertCommand(served, true, "", "staff served exact ready line");
version = served.version;

const concurrentPayments = await Promise.all([
  command(cashierClient, "record_order_payment", {
    p_location_id: LOCATION_ID,
    p_order_id: orderId,
    p_method: "CASH",
    p_amount_vnd: 99000,
    p_tender_group_id: "",
    p_idempotency_key: `${runId}_payment_same_key`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  }),
  command(cashierClient, "record_order_payment", {
    p_location_id: LOCATION_ID,
    p_order_id: orderId,
    p_method: "CASH",
    p_amount_vnd: 99000,
    p_tender_group_id: "",
    p_idempotency_key: `${runId}_payment_same_key`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  })
]);
assert(concurrentPayments[0].ok === true && concurrentPayments[1].ok === true, "same payment idempotency key should replay successfully");
assert(concurrentPayments[0].entity_id === concurrentPayments[1].entity_id, "same payment idempotency key returned different payments");
assertDedupCount("record_order_payment", `${runId}_payment_same_key`, 1);
assertPaymentCount(orderId, 1);
await waitForRefresh(cashierRefresh.events, (event) => refreshReason(event) === "PAYMENT_RECORDED", "cashier payment refresh hint");
assertNoRefreshReason(staffRefresh.events, "PAYMENT_RECORDED", "staff ops subscriber should not receive cashier payment refresh");
cashierSnapshot = await locationSnapshot(cashierClient, "CASHIER", deviceSecrets.cashier);
snapshot = await locationSnapshot(staffClient, "STAFF", deviceSecrets.staff);
assert(cashierSnapshot.orders.some((order) => order.id === orderId && Array.isArray(order.payments) && order.payments.length === 1), "cashier authoritative refetch did not include payment detail");
assert(snapshot.orders.some((order) => order.id === orderId && (!Array.isArray(order.payments) || order.payments.length === 0)), "staff authoritative refetch leaked cashier payment detail");

const raceOrder = await command(cashierClient, "create_staff_order", {
  p_location_id: LOCATION_ID,
  p_items: [{ productId: "fried-rice", qty: 1 }],
  p_table_code: codes.paymentRaceTable,
  p_fulfillment_type: "DINE_IN",
  p_note: "DD-008C table tender/direct payment race",
  p_idempotency_key: `${runId}_payment_race_order`,
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashier
});
assertCommand(raceOrder, true, "", "payment race staff order");
const raceSummary = orderLedgerSummary(raceOrder.entity_id);
const paymentRace = await Promise.all([
  command(cashierClient, "record_table_tender", {
    p_location_id: LOCATION_ID,
    p_table_session_id: raceSummary.tableSessionId,
    p_method: "CASH",
    p_amount_vnd: raceSummary.totalVnd,
    p_idempotency_key: `${runId}_payment_race_table`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  }),
  command(cashierClient, "record_order_payment", {
    p_location_id: LOCATION_ID,
    p_order_id: raceOrder.entity_id,
    p_method: "CARD_EXTERNAL_TERMINAL",
    p_amount_vnd: raceSummary.totalVnd,
    p_tender_group_id: "",
    p_idempotency_key: `${runId}_payment_race_direct`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  })
]);
const paymentRaceSuccesses = paymentRace.filter((result) => result.ok === true);
const paymentRaceFailures = paymentRace.filter((result) => result.ok === false && ["PAYMENT_EXCEEDS_OUTSTANDING", "TENDER_EXCEEDS_OUTSTANDING", "NO_OUTSTANDING_BALANCE"].includes(result.reason));
assert(paymentRaceSuccesses.length === 1 && paymentRaceFailures.length === 1, "table tender vs direct payment should serialize to one success and one outstanding-balance failure");
const settledRaceSummary = orderLedgerSummary(raceOrder.entity_id);
assert(settledRaceSummary.paymentCount === 1, `payment race created ${settledRaceSummary.paymentCount} payment rows, expected 1`);
assert(settledRaceSummary.effectivePaidVnd === settledRaceSummary.totalVnd, "payment race did not settle exactly one order total");

const opened = await Promise.all([
  command(cashierClient, "open_table_visit", {
    p_location_id: LOCATION_ID,
    p_table_code: codes.openTable,
    p_idempotency_key: `${runId}_open_a`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  }),
  command(cashierClient, "open_table_visit", {
    p_location_id: LOCATION_ID,
    p_table_code: codes.openTable,
    p_idempotency_key: `${runId}_open_b`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  })
]);
assert(opened.every((result) => result.ok === true), "concurrent open/reuse should succeed");
assert(opened[0].entity_id === opened[1].entity_id, "concurrent open/reuse returned multiple sessions");
assertOpenSessionCount(ids.openTable, 1);

const transferA = await command(cashierClient, "open_table_visit", {
  p_location_id: LOCATION_ID,
  p_table_code: codes.transferA,
  p_idempotency_key: `${runId}_transfer_open_a`,
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashier
});
const transferB = await command(cashierClient, "open_table_visit", {
  p_location_id: LOCATION_ID,
  p_table_code: codes.transferB,
  p_idempotency_key: `${runId}_transfer_open_b`,
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashier
});
const transferResults = await Promise.all([
  command(cashierClient, "transfer_table_visit", {
    p_location_id: LOCATION_ID,
    p_table_session_id: transferA.entity_id,
    p_to_table_code: codes.transferDest,
    p_expected_version: transferA.version,
    p_idempotency_key: `${runId}_transfer_a_dest`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  }),
  command(cashierClient, "transfer_table_visit", {
    p_location_id: LOCATION_ID,
    p_table_session_id: transferB.entity_id,
    p_to_table_code: codes.transferDest,
    p_expected_version: transferB.version,
    p_idempotency_key: `${runId}_transfer_b_dest`,
    p_workstation_mode: "CASHIER",
    p_device_credential: deviceSecrets.cashier
  })
]);
const transferOk = transferResults.filter((result) => result.ok === true);
const transferConflicts = transferResults.filter((result) => result.ok === false && result.reason === "DESTINATION_OCCUPIED");
assert(transferOk.length === 1 && transferConflicts.length === 1, "concurrent transfer should produce one success and one occupied conflict");
assertOpenSessionCount(ids.transferDest, 1);

await Promise.allSettled([staffRefresh.unsubscribe(), cashierRefresh.unsubscribe()]);
await command(publicClient, "create_service_request", {
  p_qr_token: qrToken,
  p_type: "REQUEST_BILL",
  p_idempotency_key: `${runId}_request_bill_after_disconnect`
});
const reconnectedSnapshot = await locationSnapshot(staffClient, "STAFF", deviceSecrets.staff);
assert(
  reconnectedSnapshot.serviceRequests.some((request) => request.type === "REQUEST_BILL" && request.done === false),
  "reconnect/refetch did not converge unresolved service request"
);

console.log("DD-008C command/realtime integration passed");
console.log("concurrency: QR idempotency, payment idempotency, course conflict, table tender/direct payment race, one-open-table, transfer conflict, stale version");
console.log("realtime: two independent private broadcast subscribers and authoritative refetch convergence verified");
console.log("security: commands used real anon/authenticated Supabase clients and server-side workstation credentials");

async function createRuntimeUser(kind) {
  const email = `${runId}_${kind}@example.invalid`;
  const password = runtimeAuthPassword(`${kind}-password`);
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { dd008c_runtime: runId, kind }
  });
  if (error || !data.user?.id) {
    throw new Error(`Failed to create runtime auth user ${kind}: ${error?.message || "missing user"}`);
  }
  return { id: data.user.id, email, password, storage: memoryStorage() };
}

function provisionRuntimeData() {
  runPsql(`
begin;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values
  (${lit(ids.qrTable)}, ${lit(LOCATION_ID)}, ${lit(codes.qrTable)}, 'DD-008C', ${lit(qrToken)}, 8101),
  (${lit(ids.openTable)}, ${lit(LOCATION_ID)}, ${lit(codes.openTable)}, 'DD-008C', ${lit(`${runId}_open_token`)}, 8102),
  (${lit(ids.paymentRaceTable)}, ${lit(LOCATION_ID)}, ${lit(codes.paymentRaceTable)}, 'DD-008C', ${lit(`${runId}_payment_race_token`)}, 8103),
  (${lit(ids.transferA)}, ${lit(LOCATION_ID)}, ${lit(codes.transferA)}, 'DD-008C', ${lit(`${runId}_transfer_a_token`)}, 8104),
  (${lit(ids.transferB)}, ${lit(LOCATION_ID)}, ${lit(codes.transferB)}, 'DD-008C', ${lit(`${runId}_transfer_b_token`)}, 8105),
  (${lit(ids.transferDest)}, ${lit(LOCATION_ID)}, ${lit(codes.transferDest)}, 'DD-008C', ${lit(`${runId}_transfer_dest_token`)}, 8106)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  (${lit(ids.cashier)}, ${lit(users.cashier.id)}::uuid, 'DD-008C Cashier', true),
  (${lit(ids.staff)}, ${lit(users.staff.id)}::uuid, 'DD-008C Floor Staff', true),
  (${lit(ids.kitchen)}, ${lit(users.kitchen.id)}::uuid, 'DD-008C Kitchen', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  (${lit(ids.cashier)}, ${lit(LOCATION_ID)}, true),
  (${lit(ids.staff)}, ${lit(LOCATION_ID)}, true),
  (${lit(ids.kitchen)}, ${lit(LOCATION_ID)}, true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  (${lit(ids.cashier)}, ${lit(LOCATION_ID)}, 'CASHIER', true),
  (${lit(ids.staff)}, ${lit(LOCATION_ID)}, 'FLOOR_STAFF', true),
  (${lit(ids.kitchen)}, ${lit(LOCATION_ID)}, 'KITCHEN', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  (${lit(ids.cashierDevice)}, ${lit(LOCATION_ID)}, 'DD-008C Cashier', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashier)}), true, ${lit(ids.cashier)}),
  (${lit(ids.staffDevice)}, ${lit(LOCATION_ID)}, 'DD-008C Floor Staff', 'STAFF', public.hash_device_credential(${lit(deviceSecrets.staff)}), true, ${lit(ids.staff)}),
  (${lit(ids.kitchenDevice)}, ${lit(LOCATION_ID)}, 'DD-008C Kitchen KDS', 'KDS_KITCHEN', public.hash_device_credential(${lit(deviceSecrets.kitchen)}), true, ${lit(ids.kitchen)})
on conflict (id) do nothing;

commit;
`);
}

async function loginRuntimeUser(kind) {
  const user = users[kind];
  const client = createClient(apiUrl, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: user.storage
    }
  });
  const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error || !data.session?.access_token) {
    throw new Error(`Real password login failed for ${kind}: ${error?.message || "missing session"}`);
  }
  return client;
}

async function command(client, functionName, params) {
  const { data, error } = await client.rpc(functionName, params);
  if (error) throw new Error(`${functionName} transport failed: ${error.message}`);
  return firstRow(data);
}

async function locationSnapshot(client, mode, deviceCredential) {
  const row = await command(client, "dd008c_get_location_snapshot", {
    p_location_id: LOCATION_ID,
    p_workstation_mode: mode,
    p_device_credential: deviceCredential
  });
  assertCommand(row, true, "", "location snapshot");
  const payload = row.payload || {};
  return {
    orders: Array.isArray(payload.orders) ? payload.orders : [],
    tableSessions: Array.isArray(payload.tableSessions) ? payload.tableSessions : [],
    serviceRequests: Array.isArray(payload.serviceRequests)
      ? payload.serviceRequests
      : Array.isArray(payload.events)
        ? payload.events
        : []
  };
}

async function subscribeRefreshHints(client, { label = "client", audiences = ["ops"] } = {}) {
  const events = [];
  const channels = audiences.map((audience) => client
    .channel(`location:${LOCATION_ID}:${audience}`, { config: { private: true } })
    .on("broadcast", { event: "refresh" }, (payload) => {
      const eventPayload = payload?.payload || {};
      events.push({
        broadcast: true,
        audience,
        new: {
          audience,
          entity_id: eventPayload.entityId || "",
          payload: eventPayload
        }
      });
    }));

  await Promise.all(channels.map((channel) => subscribeChannel(channel, `DD-008C ${label} private refresh broadcast`)));

  return {
    events,
    unsubscribe: async () => {
      await Promise.allSettled(channels.map((channel) => channel.unsubscribe()));
    }
  };
}

async function assertRefreshStreamReady(events, label) {
  const probeId = `${runId}_refresh_probe`;
  runPsql(`
select public.dd008c_emit_refresh(
  ${lit(LOCATION_ID)},
  'ops',
  'probe',
  ${lit(probeId)},
  jsonb_build_object('reason', 'SUBSCRIPTION_READY')
);
`);
  await waitForRefresh(
    events,
    (event) => refreshEntityId(event) === probeId && refreshReason(event) === "SUBSCRIPTION_READY",
    `${label} refresh subscription readiness`
  );
}

async function subscribeChannel(channel, label) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out subscribing to DD-008C refresh hints")), 15000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timeout);
        reject(new Error(`${label} subscription failed with status ${status}`));
      }
    });
  });
}

async function waitForRefresh(events, predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (events.some(predicate)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function refreshEntityId(event) {
  return event?.new?.entity_id || event?.new?.payload?.entityId || "";
}

function refreshReason(event) {
  return event?.new?.payload?.reason || "";
}

function assertCommand(row, expectedOk, expectedReason, label) {
  assert(row && row.ok === expectedOk, `${label}: expected ok=${expectedOk}, got ${JSON.stringify(row)}`);
  if (expectedReason) {
    assert(row.reason === expectedReason, `${label}: expected reason=${expectedReason}, got ${row.reason}`);
  }
}

function assertDedupCount(commandName, commandKey, expectedCount) {
  const row = queryPsqlJson(`
    select json_build_object('count', count(*))::text
    from public.command_deduplication
    where command = ${lit(commandName)}
      and command_key = ${lit(commandKey)};
  `);
  assert(row.count === expectedCount, `${commandName}/${commandKey} dedup count ${row.count}, expected ${expectedCount}`);
}

function assertPaymentCount(orderId, expectedCount) {
  const row = queryPsqlJson(`
    select json_build_object('count', count(*))::text
    from public.payment_transactions
    where order_id = ${lit(orderId)}
      and type = 'PAYMENT';
  `);
  assert(row.count === expectedCount, `payment count ${row.count}, expected ${expectedCount}`);
}

function assertNoRefreshReason(events, reason, label) {
  assert(!events.some((event) => refreshReason(event) === reason), label);
}

function orderLedgerSummary(orderId) {
  return queryPsqlJson(`
    select json_build_object(
      'tableSessionId', public.orders.table_session_id,
      'totalVnd', public.orders.total_vnd,
      'effectivePaidVnd', payment_status.effective_paid_vnd,
      'paymentCount', (
        select count(*)
        from public.payment_transactions
        where public.payment_transactions.order_id = public.orders.id
          and public.payment_transactions.type = 'PAYMENT'
      )
    )::text
    from public.orders
    cross join lateral public.dd008c_payment_status_for_order(public.orders.id) as payment_status
    where public.orders.id = ${lit(orderId)};
  `);
}

function assertOpenSessionCount(physicalTableId, expectedCount) {
  const row = queryPsqlJson(`
    select json_build_object('count', count(*))::text
    from public.table_sessions
    where physical_table_id = ${lit(physicalTableId)}
      and status = 'OPEN';
  `);
  assert(row.count === expectedCount, `open session count ${row.count}, expected ${expectedCount}`);
}

function assertOrderField(orderId, fieldName, expectedValue, message) {
  const row = queryPsqlJson(`
    select json_build_object('value', ${fieldName})::text
    from public.orders
    where id = ${lit(orderId)};
  `);
  assert(row.value === expectedValue, `${message}: got ${row.value}, expected ${expectedValue}`);
}

function runPsql(sql) {
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function queryPsqlJson(sql) {
  const output = execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-q", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  return output ? JSON.parse(output.split(/\r?\n/).find(Boolean)) : null;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
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
  const password = `Dd008C-${label}-${randomBytes(24).toString("base64url")}`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
