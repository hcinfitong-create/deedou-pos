import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY;
const dbUrl = process.env.DB_URL || statusEnv.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!anonKey) {
  throw new Error("Supabase local anon key was not available from `supabase status -o env`.");
}

const runId = `dd008b_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const ids = {
  locationA: `${runId}_loc_a`,
  locationB: `${runId}_loc_b`,
  tableA: `${runId}_table_a`,
  tableB: `${runId}_table_b`,
  owner: `${runId}_owner`,
  cashier: `${runId}_cashier`,
  kitchen: `${runId}_kitchen`,
  managerB: `${runId}_manager_b`,
  inactive: `${runId}_inactive`,
  target: `${runId}_target`,
  adminDevice: `${runId}_dev_admin`,
  cashierDevice: `${runId}_dev_cashier`,
  kitchenDevice: `${runId}_dev_kitchen`,
  cashierBDevice: `${runId}_dev_cashier_b`
};
const deviceSecrets = {
  admin: secret("admin-device"),
  cashier: secret("cashier-device"),
  kitchen: secret("kitchen-device"),
  cashierB: secret("cashier-b-device")
};

await waitForAuthReady();

const users = {
  owner: createRuntimeUser("owner"),
  cashier: createRuntimeUser("cashier"),
  kitchen: createRuntimeUser("kitchen"),
  managerB: createRuntimeUser("manager-b"),
  inactive: createRuntimeUser("inactive"),
  target: createRuntimeUser("target")
};

runPsql(`
begin;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin
)
values
  ${Object.values(users).map((user) => `(
    '00000000-0000-0000-0000-000000000000',
    ${lit(user.id)}::uuid,
    'authenticated',
    'authenticated',
    ${lit(user.email)},
    extensions.crypt(${lit(user.password)}, extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('dd008b_runtime', ${lit(runId)}, 'kind', ${lit(user.kind)}),
    false
  )`).join(",\n  ")}
on conflict (id) do update set
  email = excluded.email,
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = excluded.email_confirmed_at,
  updated_at = excluded.updated_at,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data;

insert into auth.identities (
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  ${Object.values(users).map((user) => `(
    ${lit(user.id)},
    ${lit(user.id)}::uuid,
    jsonb_build_object('sub', ${lit(user.id)}, 'email', ${lit(user.email)}, 'email_verified', true, 'phone_verified', false),
    'email',
    now(),
    now(),
    now()
  )`).join(",\n  ")}
on conflict (provider_id, provider) do update set
  user_id = excluded.user_id,
  identity_data = excluded.identity_data,
  updated_at = excluded.updated_at;

insert into public.locations (id, name, timezone, currency)
values
  (${lit(ids.locationA)}, 'DD-008B Auth Integration A', 'Asia/Saigon', 'VND'),
  (${lit(ids.locationB)}, 'DD-008B Auth Integration B', 'Asia/Saigon', 'VND')
on conflict (id) do nothing;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values
  (${lit(ids.tableA)}, ${lit(ids.locationA)}, 'A01', 'Indoor', ${lit(`${runId}_qr_a`)}, 1),
  (${lit(ids.tableB)}, ${lit(ids.locationB)}, 'B01', 'Indoor', ${lit(`${runId}_qr_b`)}, 1)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  (${lit(ids.owner)}, ${lit(users.owner.id)}::uuid, 'Runtime Owner', true),
  (${lit(ids.cashier)}, ${lit(users.cashier.id)}::uuid, 'Runtime Cashier', true),
  (${lit(ids.kitchen)}, ${lit(users.kitchen.id)}::uuid, 'Runtime Kitchen', true),
  (${lit(ids.managerB)}, ${lit(users.managerB.id)}::uuid, 'Runtime Manager B', true),
  (${lit(ids.inactive)}, ${lit(users.inactive.id)}::uuid, 'Runtime Inactive', false),
  (${lit(ids.target)}, ${lit(users.target.id)}::uuid, 'Runtime Target', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  (${lit(ids.owner)}, ${lit(ids.locationA)}, true),
  (${lit(ids.cashier)}, ${lit(ids.locationA)}, true),
  (${lit(ids.kitchen)}, ${lit(ids.locationA)}, true),
  (${lit(ids.managerB)}, ${lit(ids.locationB)}, true),
  (${lit(ids.inactive)}, ${lit(ids.locationA)}, true),
  (${lit(ids.target)}, ${lit(ids.locationA)}, true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  (${lit(ids.owner)}, ${lit(ids.locationA)}, 'OWNER', true),
  (${lit(ids.cashier)}, ${lit(ids.locationA)}, 'CASHIER', true),
  (${lit(ids.kitchen)}, ${lit(ids.locationA)}, 'KITCHEN', true),
  (${lit(ids.managerB)}, ${lit(ids.locationB)}, 'MANAGER', true),
  (${lit(ids.inactive)}, ${lit(ids.locationA)}, 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  (${lit(ids.adminDevice)}, ${lit(ids.locationA)}, 'Runtime Admin', 'ADMIN', public.hash_device_credential(${lit(deviceSecrets.admin)}), true, ${lit(ids.owner)}),
  (${lit(ids.cashierDevice)}, ${lit(ids.locationA)}, 'Runtime Cashier', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashier)}), true, ${lit(ids.owner)}),
  (${lit(ids.kitchenDevice)}, ${lit(ids.locationA)}, 'Runtime Kitchen', 'KDS_KITCHEN', public.hash_device_credential(${lit(deviceSecrets.kitchen)}), true, ${lit(ids.owner)}),
  (${lit(ids.cashierBDevice)}, ${lit(ids.locationB)}, 'Runtime Cashier B', 'CASHIER', public.hash_device_credential(${lit(deviceSecrets.cashierB)}), true, ${lit(ids.managerB)})
on conflict (id) do nothing;

commit;
`);

const cashierClient = await loginRuntimeUser("cashier");
const cashierAuthz = await rpc(cashierClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "payments.record",
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashier
});
assertAuthz(cashierAuthz, true, "", "cashier allowed payment on registered cashier workstation");

const cashierDeniedKitchen = await rpc(cashierClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "kds.kitchen",
  p_workstation_mode: "KDS_KITCHEN",
  p_device_credential: deviceSecrets.kitchen
});
assertAuthz(cashierDeniedKitchen, false, "PERMISSION_DENIED", "cashier denied kitchen permission");

const cashierDeniedB = await rpc(cashierClient, "authorize_staff_access", {
  p_location_id: ids.locationB,
  p_permission_key: "payments.record",
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashierB
});
assertAuthz(cashierDeniedB, false, "LOCATION_DENIED", "cashier denied location B");

const restoredCashier = createRuntimeClient(users.cashier.storage);
const restoredSession = await restoredCashier.auth.getSession();
assert(restoredSession.data.session?.user?.email === users.cashier.email, "session restore returned cashier user");

const refreshed = await restoredCashier.auth.refreshSession();
assert(!refreshed.error && refreshed.data.session?.access_token, "refreshSession returned a fresh JWT");

await restoredCashier.auth.signOut({ scope: "local" });
const afterLogout = await restoredCashier.auth.getSession();
assert(afterLogout.data.session === null, "local/current-session logout removed only the current client session");

const kitchenClient = await loginRuntimeUser("kitchen");
const kitchenAllowed = await rpc(kitchenClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "kds.kitchen",
  p_workstation_mode: "KDS_KITCHEN",
  p_device_credential: deviceSecrets.kitchen
});
assertAuthz(kitchenAllowed, true, "", "kitchen allowed kitchen KDS");

const kitchenDeniedPay = await rpc(kitchenClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "payments.record",
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashier
});
assertAuthz(kitchenDeniedPay, false, "PERMISSION_DENIED", "kitchen denied payment");

const inactiveClient = await loginRuntimeUser("inactive");
const inactiveDenied = await rpc(inactiveClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "payments.record",
  p_workstation_mode: "CASHIER",
  p_device_credential: deviceSecrets.cashier
});
assertAuthz(inactiveDenied, false, "STAFF_INACTIVE", "inactive staff denied");

const ownerClient = await loginRuntimeUser("owner");
const directBypassDenied = await rpc(ownerClient, "assign_staff_to_location", {
  p_target_staff_profile_id: ids.target,
  p_location_id: ids.locationA,
  p_current_workstation_mode: "CASHIER",
  p_current_device_credential: deviceSecrets.cashier
});
assertRow(directBypassDenied, false, "DEVICE_MODE_DENIED", "direct privileged RPC denied on cashier workstation");

const registered = await rpc(ownerClient, "register_workstation_device", {
  p_location_id: ids.locationA,
  p_label: "Runtime Server Issued Cashier",
  p_mode: "CASHIER",
  p_current_workstation_mode: "ADMIN",
  p_current_device_credential: deviceSecrets.admin
});
const registeredRow = firstRow(registered);
assert(registeredRow.ok === true, `expected server-issued device registration, got ${registeredRow.reason}`);
assert(typeof registeredRow.device_id === "string" && registeredRow.device_id.startsWith("DEV-"), "server generated device id");
assert(typeof registeredRow.device_credential === "string" && registeredRow.device_credential.length >= 32, "server returned one-time credential");

runPsql(`
do $$
begin
  if not exists (
    select 1
    from public.workstation_devices
    where public.workstation_devices.id = ${lit(registeredRow.device_id)}
      and public.workstation_devices.credential_hash = public.hash_device_credential(${lit(registeredRow.device_credential)})
      and public.workstation_devices.active = true
  ) then
    raise exception 'server-issued device credential was not stored as expected hash';
  end if;
end $$;
`);

const newDeviceAllowed = await rpc(ownerClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "payments.record",
  p_workstation_mode: "CASHIER",
  p_device_credential: registeredRow.device_credential
});
assertAuthz(newDeviceAllowed, true, "", "registered server-issued device is usable");

const revoked = await rpc(ownerClient, "revoke_workstation_device", {
  p_location_id: ids.locationA,
  p_device_id: registeredRow.device_id,
  p_current_workstation_mode: "ADMIN",
  p_current_device_credential: deviceSecrets.admin
});
assertRow(revoked, true, "", "owner revoked server-issued device");

const revokedDenied = await rpc(ownerClient, "authorize_staff_access", {
  p_location_id: ids.locationA,
  p_permission_key: "payments.record",
  p_workstation_mode: "CASHIER",
  p_device_credential: registeredRow.device_credential
});
assertAuthz(revokedDenied, false, "DEVICE_UNREGISTERED", "revoked workstation denied without JWT refresh");

const audit = await rpc(ownerClient, "prepare_audit_context", {
  p_location_id: ids.locationA,
  p_device_credential: deviceSecrets.admin,
  p_workstation_mode: "CASHIER",
  p_command: "DD008B_TEST",
  p_target_type: "staff_profile",
  p_target_id: ids.cashier,
  p_outcome: "DENIED",
  p_client_actor_id: ids.cashier
});
const auditRow = firstRow(audit);
assert(auditRow.staff_profile_id === ids.owner, "audit derives staff profile from JWT");
assert(auditRow.device_id === ids.adminDevice, "audit derives device id from credential");
assert(auditRow.workstation_mode === "ADMIN", "audit ignores spoofed expected workstation mode");
assert(auditRow.client_actor_ignored === true, "audit reports spoofed client actor ignored");

console.log("DD-008B real Auth integration passed");
console.log(`runtime users: ${Object.keys(users).length}`);
console.log("real password login/JWT, restore, refresh, local logout, server-issued device, direct RPC device enforcement, and audit anti-spoof verified");

function createRuntimeUser(kind) {
  const id = randomUUID();
  const email = `${runId}_${kind}@example.invalid`;
  const password = secret(`${kind}-password`);
  return { id, email, password, kind, storage: memoryStorage() };
}

async function loginRuntimeUser(kind) {
  const user = users[kind];
  const client = createRuntimeClient(user.storage);
  const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error || !data.session?.access_token) throw new Error(`Real password login failed for ${kind}: ${error?.message || "missing session"}`);
  return client;
}

function createRuntimeClient(storage) {
  return createClient(apiUrl, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage
    }
  });
}

async function waitForAuthReady() {
  await retryAuthCall(
    async () => {
      const response = await fetch(`${apiUrl}/auth/v1/health`, {
        headers: { apikey: anonKey }
      });
      return response.ok ? { data: true } : { error: new Error(`HTTP ${response.status}`) };
    },
    "wait for local Supabase Auth"
  );
}

async function retryAuthCall(operation, label, attempts = 20) {
  let lastErrorMessage = "unknown auth error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation();
      if (!result.error) return result;
      lastErrorMessage = result.error.message || lastErrorMessage;
    } catch (error) {
      lastErrorMessage = error?.message || String(error);
    }
    await sleep(Math.min(500 * attempt, 3000));
  }
  throw new Error(`Failed to ${label}: ${lastErrorMessage}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(client, functionName, params) {
  const { data, error } = await client.rpc(functionName, params);
  if (error) throw new Error(`${functionName} failed: ${error.message}`);
  return data;
}

function assertAuthz(data, expectedOk, expectedReason, label) {
  const row = firstRow(data);
  assert(row.ok === expectedOk && (expectedReason ? row.reason === expectedReason : true), `${label}: got ${row.ok}/${row.reason}`);
}

function assertRow(data, expectedOk, expectedReason, label) {
  const row = firstRow(data);
  assert(row.ok === expectedOk && (expectedReason ? row.reason === expectedReason : true), `${label}: got ${row.ok}/${row.reason}`);
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

function secret(label) {
  return `${runId}_${label}_${randomUUID()}_${randomUUID()}`;
}

function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
