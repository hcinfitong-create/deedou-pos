import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const statusEnv = parseEnvOutput(execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" }));
const apiUrl = statusEnv.API_URL || statusEnv.SUPABASE_URL || "http://127.0.0.1:54321";
const anonKey = statusEnv.ANON_KEY || statusEnv.SUPABASE_ANON_KEY || statusEnv.PUBLISHABLE_KEY;
const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY || statusEnv.SUPABASE_SERVICE_ROLE_KEY || statusEnv.SECRET_KEY;
const dbUrl = process.env.DB_URL || statusEnv.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!anonKey || !serviceRoleKey) {
  throw new Error("Local Supabase publishable/service credentials are unavailable from `supabase status -o env`.");
}

const runId = `dd011_${Date.now()}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const ids = {
  location: `${runId}_loc`,
  owner: `${runId}_owner`,
  target: `${runId}_target`,
  adminDevice: `${runId}_admin_device`,
  cashierDevice: `${runId}_cashier_device`
};
const credentials = {
  admin: secret("admin-device"),
  cashier: secret("cashier-device")
};
const diagnosticSecrets = [anonKey, serviceRoleKey, ...Object.values(credentials)];
const createdAuthUserIds = [];

const adminClient = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

let failed = false;
try {
  await waitForAuthReady();

  const owner = await createRuntimeUser("owner");
  const target = await createRuntimeUser("target");
  createdAuthUserIds.push(owner.id, target.id);
  provisionDeeDouFixtures(owner, target);

  const ownerStorage = memoryStorage();
  const ownerClient = createRuntimeClient(ownerStorage);
  const signIn = await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
  assert(!signIn.error && signIn.data.session?.access_token, `password sign-in failed: ${signIn.error?.message || "missing session"}`);

  await assertAal(ownerClient, "aal1", "password login starts at AAL1");

  const aal1Denied = await rpc(ownerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: ids.target,
    p_location_id: ids.location,
    p_role_id: "CASHIER",
    p_current_workstation_mode: "CASHIER",
    p_current_device_credential: credentials.cashier
  });
  assertRow(aal1Denied, false, "MFA_REQUIRED", "AAL1 privileged role mutation is blocked before device-mode evaluation");

  await promoteSessionToAal2(ownerClient);
  await assertAal(ownerClient, "aal2", "verified TOTP promotes current session to AAL2");

  const wrongModeDenied = await rpc(ownerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: ids.target,
    p_location_id: ids.location,
    p_role_id: "CASHIER",
    p_current_workstation_mode: "CASHIER",
    p_current_device_credential: credentials.cashier
  });
  assertRow(wrongModeDenied, false, "DEVICE_MODE_DENIED", "AAL2 still requires an ADMIN workstation for privileged mutations");

  const roleAssigned = await rpc(ownerClient, "assign_staff_role_at_location", {
    p_target_staff_profile_id: ids.target,
    p_location_id: ids.location,
    p_role_id: "CASHIER",
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: credentials.admin
  });
  assertRow(roleAssigned, true, "", "AAL2 OWNER can assign a role within its privilege ceiling");

  const registered = firstRow(await rpc(ownerClient, "register_workstation_device", {
    p_location_id: ids.location,
    p_label: "DD-011 Runtime Cashier",
    p_mode: "CASHIER",
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: credentials.admin
  }));
  assert(registered?.ok === true, `AAL2 device registration failed: ${registered?.reason || "unknown"}`);
  assert(typeof registered.device_id === "string" && registered.device_id.startsWith("DEV-"), "server generated a workstation device id");
  assert(typeof registered.device_credential === "string" && registered.device_credential.length >= 40, "server returned a one-time high-entropy credential");
  diagnosticSecrets.push(registered.device_credential);

  const newDeviceAllowed = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: ids.location,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: registered.device_credential
  });
  assertAuthz(newDeviceAllowed, true, "", "new server-issued device works with the authenticated OWNER role");

  const rotated = firstRow(await rpc(ownerClient, "dd011_rotate_workstation_device", {
    p_location_id: ids.location,
    p_device_id: registered.device_id,
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: credentials.admin
  }));
  assert(rotated?.ok === true, `AAL2 device rotation failed: ${rotated?.reason || "unknown"}`);
  assert(rotated.device_credential && rotated.device_credential !== registered.device_credential, "rotation returned a different credential");
  diagnosticSecrets.push(rotated.device_credential);

  const oldCredentialDenied = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: ids.location,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: registered.device_credential
  });
  assertAuthz(oldCredentialDenied, false, "DEVICE_UNREGISTERED", "rotation invalidates the previous credential immediately");

  const rotatedCredentialAllowed = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: ids.location,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: rotated.device_credential
  });
  assertAuthz(rotatedCredentialAllowed, true, "", "rotated credential is immediately usable");

  const revoked = await rpc(ownerClient, "revoke_workstation_device", {
    p_location_id: ids.location,
    p_device_id: registered.device_id,
    p_current_workstation_mode: "ADMIN",
    p_current_device_credential: credentials.admin
  });
  assertRow(revoked, true, "", "AAL2 OWNER can revoke a non-current workstation");

  const revokedDenied = await rpc(ownerClient, "authorize_staff_access", {
    p_location_id: ids.location,
    p_permission_key: "payments.record",
    p_workstation_mode: "CASHIER",
    p_device_credential: rotated.device_credential
  });
  assertAuthz(revokedDenied, false, "DEVICE_UNREGISTERED", "revoked device is denied without a JWT refresh");

  const restoredClient = createRuntimeClient(ownerStorage);
  const restored = await restoredClient.auth.getSession();
  assert(restored.data.session?.user?.email === owner.email, "AAL2 owner session restores from client storage");
  const refreshed = await restoredClient.auth.refreshSession();
  assert(!refreshed.error && refreshed.data.session?.access_token, "AAL2 owner session refresh succeeds");
  await assertAal(restoredClient, "aal2", "refreshed MFA session remains AAL2");

  const auditCount = queryPsqlNumber(`
    select count(*)
    from public.audit_events
    where location_id = ${lit(ids.location)}
      and command in (
        'assign_staff_role_at_location',
        'register_workstation_device',
        'dd011_rotate_workstation_device',
        'revoke_workstation_device'
      );
  `);
  assert(auditCount >= 4, `expected privileged security mutations to be audited, got ${auditCount}`);

  await restoredClient.auth.signOut({ scope: "local" });
  const afterLogout = await restoredClient.auth.getSession();
  assert(afterLogout.data.session === null, "local logout clears the current browser session");

  console.log("DD-011 real Supabase Auth + TOTP integration passed");
  console.log("verified: AAL1 denial, real TOTP AAL2, workstation constraint, register/rotate/revoke, restore/refresh/logout, audit");
} catch (error) {
  failed = true;
  console.error(sanitizeDiagnostic(String(error?.stack || error)));
} finally {
  cleanupDatabaseFixtures();
  for (const userId of createdAuthUserIds.reverse()) {
    try {
      await adminClient.auth.admin.deleteUser(userId);
    } catch {
      // Local CI cleanup is best-effort after database references are removed.
    }
  }
}

if (failed) process.exitCode = 1;

async function createRuntimeUser(kind) {
  const email = `${runId}_${kind}@example.invalid`;
  const password = `Dd011-${kind}-${randomBytes(18).toString("base64url")}`;
  diagnosticSecrets.push(password);
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { dd011_runtime: runId, kind }
  });
  if (error || !data.user?.id) throw new Error(`failed to create ${kind} auth user: ${error?.message || "missing user"}`);
  return { id: data.user.id, email, password };
}

function provisionDeeDouFixtures(owner, target) {
  runPsql(`
    begin;
    insert into public.locations (id, name, timezone, currency)
    values (${lit(ids.location)}, 'DD-011 Auth Integration', 'Asia/Ho_Chi_Minh', 'VND');

    insert into public.staff_profiles (id, auth_user_id, display_name, active)
    values
      (${lit(ids.owner)}, ${lit(owner.id)}::uuid, 'DD-011 Runtime Owner', true),
      (${lit(ids.target)}, ${lit(target.id)}::uuid, 'DD-011 Runtime Target', true);

    insert into public.staff_location_assignments (staff_profile_id, location_id, active)
    values
      (${lit(ids.owner)}, ${lit(ids.location)}, true),
      (${lit(ids.target)}, ${lit(ids.location)}, true);

    insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
    values (${lit(ids.owner)}, ${lit(ids.location)}, 'OWNER', true);

    insert into public.workstation_devices (
      id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
    )
    values
      (${lit(ids.adminDevice)}, ${lit(ids.location)}, 'DD-011 Runtime Admin', 'ADMIN', public.hash_device_credential(${lit(credentials.admin)}), true, ${lit(ids.owner)}),
      (${lit(ids.cashierDevice)}, ${lit(ids.location)}, 'DD-011 Runtime Cashier Baseline', 'CASHIER', public.hash_device_credential(${lit(credentials.cashier)}), true, ${lit(ids.owner)});
    commit;
  `);
}

async function promoteSessionToAal2(client) {
  const enrollment = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `DeeDou DD011 ${runId}`
  });
  if (enrollment.error || !enrollment.data?.id || !enrollment.data?.totp?.secret) {
    throw new Error(`TOTP enrollment failed: ${enrollment.error?.message || "missing factor/secret"}`);
  }

  const factorId = enrollment.data.id;
  const totpSecret = enrollment.data.totp.secret;
  diagnosticSecrets.push(totpSecret);

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const challenge = await client.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data?.id) {
      throw new Error(`TOTP challenge failed: ${challenge.error?.message || "missing challenge id"}`);
    }

    const code = generateTotp(totpSecret);
    diagnosticSecrets.push(code);
    const verification = await client.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code
    });
    if (!verification.error) return;
    lastError = verification.error;
    if (attempt === 0) await sleep(1100);
  }

  throw new Error(`TOTP verification failed: ${lastError?.message || "unknown"}`);
}

async function assertAal(client, expectedLevel, label) {
  const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw new Error(`${label}: ${error.message}`);
  assert(data?.currentLevel === expectedLevel, `${label}: expected ${expectedLevel}, got ${data?.currentLevel || "null"}`);
}

function generateTotp(base32Secret, nowMs = Date.now()) {
  const key = decodeBase32(base32Secret);
  const counter = BigInt(Math.floor(nowMs / 1000 / 30));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;
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
  let lastError = "unavailable";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/auth/v1/health`, { headers: { apikey: anonKey } });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(Math.min(300 * attempt, 2000));
  }
  throw new Error(`local Supabase Auth did not become ready: ${lastError}`);
}

async function rpc(client, functionName, params) {
  const { data, error } = await client.rpc(functionName, params);
  if (error) throw new Error(`${functionName} failed: ${error.message}`);
  return data;
}

function assertAuthz(data, expectedOk, expectedReason, label) {
  assertRow(data, expectedOk, expectedReason, label);
}

function assertRow(data, expectedOk, expectedReason, label) {
  const row = firstRow(data);
  assert(row?.ok === expectedOk && (expectedReason ? row?.reason === expectedReason : true), `${label}: got ${row?.ok}/${row?.reason}`);
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

function cleanupDatabaseFixtures() {
  try {
    runPsql(`
      delete from public.audit_events where location_id = ${lit(ids.location)};
      delete from public.workstation_devices where location_id = ${lit(ids.location)};
      delete from public.staff_role_assignments where location_id = ${lit(ids.location)};
      delete from public.staff_location_assignments where location_id = ${lit(ids.location)};
      delete from public.staff_profiles where id in (${lit(ids.owner)}, ${lit(ids.target)});
      delete from public.locations where id = ${lit(ids.location)};
    `);
  } catch {
    // The local Supabase stack is disposable; do not hide the primary test failure.
  }
}

function runPsql(sql) {
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function queryPsqlNumber(sql) {
  const output = execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-q", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  const value = Number(output.split(/\r?\n/).find(Boolean) || "0");
  if (!Number.isFinite(value)) throw new Error(`expected numeric SQL result, got ${output}`);
  return value;
}

function parseEnvOutput(output) {
  return output.split(/\r?\n/).reduce((accumulator, line) => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) return accumulator;
    accumulator[match[1]] = match[2].replace(/^"|"$/g, "");
    return accumulator;
  }, {});
}

function secret(label) {
  return `${runId}_${label}_${randomUUID()}_${randomUUID()}`;
}

function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sanitizeDiagnostic(text) {
  let sanitized = String(text || "")
    .replace(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "Bearer [JWT_REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
  for (const secretValue of diagnosticSecrets.filter(Boolean)) {
    sanitized = sanitized.split(secretValue).join("[SECRET_REDACTED]");
  }
  return sanitized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
