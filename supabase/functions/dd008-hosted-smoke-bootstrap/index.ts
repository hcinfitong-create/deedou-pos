import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.3";

const PROJECT_URL = requiredEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const REPOSITORY = "hcinfitong-create/deedou-pos";
const ACTOR = "hcinfitong-create";
const AUDIENCE = "deedou-hosted-smoke";
const ISSUER = "https://token.actions.githubusercontent.com";
const ALLOWED_PR_REFS = new Set([
  "refs/pull/35/merge",
  "refs/pull/38/merge",
  "refs/pull/42/merge",
  "refs/pull/44/merge",
  "refs/pull/48/merge"
]);
const ALLOWED_WORKFLOW_PATHS = new Set([
  ".github/workflows/dd008p-preview-hosted-smoke.yml",
  ".github/workflows/dd010a-preview-hosted-smoke.yml",
  ".github/workflows/dd011-preview-hosted-smoke.yml",
  ".github/workflows/dd012-preview-hosted-smoke.yml",
  ".github/workflows/dd012b-preview-hosted-smoke.yml"
]);

const service = createClient(PROJECT_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ ok: false, reason: "METHOD_NOT_ALLOWED" }, 405);

  try {
    await verifyGithubActionsRequest(request);
    const body = object(await request.json().catch(() => ({})));
    const action = text(body.action);
    const runId = safeIdentifier(body.runId, "runId");
    const locationId = safeLocationId(body.locationId || `${runId}_loc`);

    if (action === "setup") return json(await setupFixtures(runId, locationId, body));
    if (action === "diagnose") return json({ ok: true, diagnostic: await diagnoseFixtures(runId, locationId) });
    if (action === "cleanup") {
      const diagnostic = await cleanupFixtures(runId, locationId);
      return json({ ok: true, diagnostic });
    }

    return json({ ok: false, reason: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    return json({ ok: false, reason: safeError(error) }, error instanceof AuthError ? 401 : 409);
  }
});

async function setupFixtures(runId: string, locationId: string, body: Record<string, unknown>) {
  await cleanupFixtures(runId, locationId);
  try {
    await upsertLocation(locationId, `DD hosted smoke ${runId}`);

    if (Array.isArray(body.accounts)) {
      await setupLegacyAccounts(runId, locationId, body.accounts);
    } else {
      await setupDd011bOwner(runId, locationId, object(body.account), object(body.table));
    }

    return { ok: true, diagnostic: await diagnoseFixtures(runId, locationId) };
  } catch (error) {
    await cleanupFixtures(runId, locationId).catch(() => {});
    throw error;
  }
}

async function setupLegacyAccounts(runId: string, locationId: string, rawAccounts: unknown[]) {
  const accounts = rawAccounts.map((value) => object(value));
  const owner = accounts.find((account) => text(account.name) === "owner");
  if (!owner) throw new Error("OWNER_ACCOUNT_REQUIRED");

  const created = new Map<string, string>();
  for (const account of accounts) {
    const name = safeShortName(account.name);
    const email = safeEmail(account.email);
    const password = safePassword(account.password);
    const user = await createAuthUser(email, password, {
      deedou_hosted_run_id: runId,
      deedou_hosted_kind: "dd011",
      deedou_account_name: name
    });
    created.set(name, user.id);
    await upsertStaffProfile({
      id: `${runId}_${name}`,
      authUserId: user.id,
      username: `${name}_${runId}`.replace(/[^a-z0-9_-]/g, "_").slice(0, 31),
      displayName: email,
      active: true,
      provisioningStatus: "ACTIVE"
    });
    await upsertStaffLocation(`${runId}_${name}`, locationId, true);
  }

  await upsertStaffRole(`${runId}_owner`, locationId, "OWNER", true);
  if (created.has("manager")) await upsertStaffRole(`${runId}_manager`, locationId, "MANAGER", true);
  if (created.has("cashier")) await upsertStaffRole(`${runId}_cashier`, locationId, "CASHIER", true);

  await createLegacyDevice(locationId, `${runId}_owner_device`, "DD011 Hosted Owner Admin", "ADMIN", text(owner.deviceSecret), `${runId}_owner`);
  const cashier = accounts.find((account) => text(account.name) === "cashier");
  if (cashier) {
    await createLegacyDevice(locationId, `${runId}_cashier_device`, "DD011 Hosted Cashier", "CASHIER", text(cashier.deviceSecret), `${runId}_owner`);
  }

  await setBackendDeviceSessionsRequired(false);
}

async function setupDd011bOwner(runId: string, locationId: string, rawAccount: Record<string, unknown>, rawTable: Record<string, unknown>) {
  const email = safeEmail(rawAccount.email);
  const password = safePassword(rawAccount.password);
  const owner = await createAuthUser(email, password, {
    deedou_hosted_run_id: runId,
    deedou_hosted_kind: "dd011b",
    deedou_account_name: "owner"
  });

  const ownerId = `${runId}_owner`;
  await upsertStaffProfile({
    id: ownerId,
    authUserId: owner.id,
    username: `owner_${runId}`.replace(/[^a-z0-9_-]/g, "_").slice(0, 31),
    displayName: "DD011B Hosted Owner",
    active: true,
    provisioningStatus: "ACTIVE"
  });
  await upsertStaffLocation(ownerId, locationId, true);
  await upsertStaffRole(ownerId, locationId, "OWNER", true);
  await upsertTable(locationId, rawTable);
  await setBackendDeviceSessionsRequired(true);
}

async function createAuthUser(email: string, password: string, userMetadata: Record<string, string>) {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: userMetadata
  });
  if (error || !data.user?.id) throw new Error(`AUTH_USER_CREATE_FAILED:${error?.message || "missing user"}`);
  return data.user;
}

async function upsertLocation(id: string, name: string) {
  await expectOk(service.from("locations").upsert({
    id,
    name,
    timezone: "Asia/Saigon",
    currency: "VND"
  }, { onConflict: "id" }), "LOCATION_UPSERT_FAILED");
}

async function upsertTable(locationId: string, rawTable: Record<string, unknown>) {
  const id = safeIdentifier(rawTable.id || `${locationId}_table`, "table.id");
  const code = text(rawTable.code || "B48").slice(0, 32);
  const zone = text(rawTable.zone || "DD011B").slice(0, 64);
  const qrToken = text(rawTable.qrToken);
  if (qrToken.length < 12) throw new Error("TABLE_QR_TOKEN_REQUIRED");
  await expectOk(service.from("physical_tables").upsert({
    id,
    location_id: locationId,
    code,
    zone,
    qr_token: qrToken,
    is_active: true,
    display_order: 1
  }, { onConflict: "id" }), "TABLE_UPSERT_FAILED");
}

async function upsertStaffProfile(input: {
  id: string;
  authUserId: string;
  username: string;
  displayName: string;
  active: boolean;
  provisioningStatus: string;
}) {
  await expectOk(service.from("staff_profiles").upsert({
    id: input.id,
    auth_user_id: input.authUserId,
    username: input.username,
    display_name: input.displayName,
    active: input.active,
    provisioning_status: input.provisioningStatus
  }, { onConflict: "id" }), "STAFF_PROFILE_UPSERT_FAILED");
}

async function upsertStaffLocation(staffProfileId: string, locationId: string, active: boolean) {
  await expectOk(service.from("staff_location_assignments").upsert({
    staff_profile_id: staffProfileId,
    location_id: locationId,
    active
  }, { onConflict: "staff_profile_id,location_id" }), "STAFF_LOCATION_UPSERT_FAILED");
}

async function upsertStaffRole(staffProfileId: string, locationId: string, roleId: string, active: boolean) {
  await expectOk(service.from("staff_role_assignments").upsert({
    staff_profile_id: staffProfileId,
    location_id: locationId,
    role_id: roleId,
    active
  }, { onConflict: "staff_profile_id,location_id,role_id" }), "STAFF_ROLE_UPSERT_FAILED");
}

async function createLegacyDevice(locationId: string, deviceId: string, label: string, mode: string, credential: string, registeredBy: string) {
  if (!credential) throw new Error("DEVICE_CREDENTIAL_REQUIRED");
  await expectOk(service.from("workstation_devices").upsert({
    id: deviceId,
    location_id: locationId,
    label,
    mode,
    credential_hash: await deviceHash(credential),
    active: true,
    registered_by_staff_profile_id: registeredBy,
    revoked_at: null
  }, { onConflict: "id" }), "WORKSTATION_DEVICE_UPSERT_FAILED");
  await expectOk(service.from("workstation_device_secrets").upsert({
    device_id: deviceId,
    credential
  }, { onConflict: "device_id" }), "WORKSTATION_DEVICE_SECRET_UPSERT_FAILED");
}

async function setBackendDeviceSessionsRequired(required: boolean) {
  const { error } = await service.rpc("dd011b_service_set_device_session_enforcement", { p_required: required });
  if (error) throw new Error(`DEVICE_SESSION_POLICY_FAILED:${error.message}`);
}

async function cleanupFixtures(runId: string, locationId: string) {
  const before = await fixtureRefs(runId, locationId);
  const profileIds = before.profileIds;
  const userIds = before.userIds;
  const deviceIds = before.deviceIds;
  const orderIds = await idsFrom("orders", "id", "location_id", locationId);

  if (deviceIds.length) await deleteIn("staff_activation_requests", "device_id", deviceIds);
  if (profileIds.length) await deleteIn("staff_activation_requests", "staff_profile_id", profileIds);
  await deleteEq("staff_activation_requests", "location_id", locationId);

  if (deviceIds.length) {
    await deleteIn("workstation_device_sessions", "device_id", deviceIds);
    await deleteIn("workstation_device_secrets", "device_id", deviceIds);
  }
  if (userIds.length) await deleteIn("workstation_device_sessions", "auth_user_id", userIds);
  await deleteEq("workstation_devices", "location_id", locationId);

  await deleteEq("payment_transactions", "location_id", locationId);
  if (orderIds.length) await deleteIn("order_lines", "order_id", orderIds);
  await deleteEq("service_requests", "location_id", locationId);
  await deleteEq("orders", "location_id", locationId);
  await deleteEq("table_sessions", "location_id", locationId);
  await deleteEq("physical_tables", "location_id", locationId);

  await deleteEq("dd008c_refresh_hints", "location_id", locationId);
  await deleteEq("idempotency_keys", "location_id", locationId);
  await deleteEq("command_deduplication", "location_id", locationId);
  await deleteEq("audit_events", "location_id", locationId);

  await deleteEq("staff_role_assignments", "location_id", locationId);
  await deleteEq("staff_location_assignments", "location_id", locationId);
  if (profileIds.length) await deleteIn("staff_profiles", "id", profileIds);
  await deleteEq("locations", "id", locationId);

  for (const userId of userIds) {
    await service.auth.admin.deleteUser(userId).catch(() => {});
  }

  const after = await diagnoseFixtures(runId, locationId, userIds);
  await setBackendDeviceSessionsRequired(false).catch(() => {});
  return after;
}

async function diagnoseFixtures(runId: string, locationId: string, expectedDeletedUserIds: string[] = []) {
  const refs = await fixtureRefs(runId, locationId);
  const authUsersByRun = await authUserIdsForRun(runId);
  const remainingDeletedUsers = await existingAuthUserCount(expectedDeletedUserIds);
  const productIds = await idsFrom("products", "id", "location_id", locationId);
  const orderIds = await idsFrom("orders", "id", "location_id", locationId);
  return {
    locations: await countEq("locations", "id", locationId),
    tables: await countEq("physical_tables", "location_id", locationId),
    products: productIds.length,
    components: productIds.length
      ? await countIn("product_components", "parent_product_id", productIds)
      : 0,
    orders: orderIds.length,
    orderLines: orderIds.length
      ? await countIn("order_lines", "order_id", orderIds)
      : 0,
    staffProfiles: refs.profileIds.length,
    staffLocations: await countEq("staff_location_assignments", "location_id", locationId),
    staffRoles: await countEq("staff_role_assignments", "location_id", locationId),
    activations: await countEq("staff_activation_requests", "location_id", locationId),
    devices: await countEq("workstation_devices", "location_id", locationId),
    deviceSessions: refs.deviceIds.length
      ? await countIn("workstation_device_sessions", "device_id", refs.deviceIds)
      : 0,
    audits: await countEq("audit_events", "location_id", locationId),
    dedupe: await countEq("command_deduplication", "location_id", locationId),
    refreshHints: await countEq("dd008c_refresh_hints", "location_id", locationId),
    authUsers: new Set([...authUsersByRun, ...refs.userIds, ...Array.from({ length: remainingDeletedUsers }, (_, index) => `deleted-${index}`)]).size
  };
}

async function fixtureRefs(runId: string, locationId: string) {
  const assignmentIds = await idsFrom("staff_location_assignments", "staff_profile_id", "location_id", locationId);
  const roleIds = await idsFrom("staff_role_assignments", "staff_profile_id", "location_id", locationId);
  const prefixedIds = await idsLike("staff_profiles", "id", `${runId}_%`);
  const profileIds = [...new Set([...assignmentIds, ...roleIds, ...prefixedIds])];
  const profileRows = profileIds.length
    ? await selectIn("staff_profiles", "id,auth_user_id", "id", profileIds)
    : [];
  const userIds = [...new Set(profileRows.map((row) => text(row.auth_user_id)).filter(Boolean))];
  const deviceRows = await selectEq("workstation_devices", "id", "location_id", locationId);
  const deviceIds = deviceRows.map((row) => text(row.id)).filter(Boolean);
  return { profileIds, userIds, deviceIds };
}

async function authUserIdsForRun(runId: string) {
  const result = new Set<string>();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`AUTH_USER_LIST_FAILED:${error.message}`);
    const users = data.users || [];
    for (const user of users) {
      const meta = object(user.user_metadata);
      if (text(meta.deedou_hosted_run_id) === runId || text(user.email).includes(`deedou.smoke.${runId}.`)) {
        result.add(user.id);
      }
    }
    if (users.length < 1000) break;
  }
  return [...result];
}

async function existingAuthUserCount(userIds: string[]) {
  let count = 0;
  for (const userId of new Set(userIds.filter(Boolean))) {
    const { data, error } = await service.auth.admin.getUserById(userId);
    if (!error && data?.user?.id) count += 1;
  }
  return count;
}

async function deleteEq(table: string, column: string, value: string) {
  const { error } = await service.from(table).delete().eq(column, value);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_DELETE_FAILED:${error.message}`);
}

async function deleteIn(table: string, column: string, values: string[]) {
  if (!values.length) return;
  const { error } = await service.from(table).delete().in(column, [...new Set(values)]);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_DELETE_FAILED:${error.message}`);
}

async function idsFrom(table: string, idColumn: string, eqColumn: string, eqValue: string) {
  return (await selectEq(table, idColumn, eqColumn, eqValue)).map((row) => text(row[idColumn])).filter(Boolean);
}

async function idsLike(table: string, idColumn: string, pattern: string) {
  const { data, error } = await service.from(table).select(idColumn).like(idColumn, pattern);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_LIKE_FAILED:${error.message}`);
  return (data || []).map((row) => text(row[idColumn])).filter(Boolean);
}

async function selectEq(table: string, columns: string, eqColumn: string, eqValue: string) {
  const { data, error } = await service.from(table).select(columns).eq(eqColumn, eqValue);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_SELECT_FAILED:${error.message}`);
  return data || [];
}

async function selectIn(table: string, columns: string, column: string, values: string[]) {
  const { data, error } = await service.from(table).select(columns).in(column, [...new Set(values)]);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_SELECT_FAILED:${error.message}`);
  return data || [];
}

async function countEq(table: string, column: string, value: string) {
  const { count, error } = await service.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_COUNT_FAILED:${error.message}`);
  return count || 0;
}

async function countIn(table: string, column: string, values: string[]) {
  if (!values.length) return 0;
  const { count, error } = await service.from(table).select("*", { count: "exact", head: true }).in(column, [...new Set(values)]);
  if (error && !isMissingRelation(error.message)) throw new Error(`${table}_COUNT_FAILED:${error.message}`);
  return count || 0;
}

async function expectOk(builder: PromiseLike<{ error: { message?: string } | null }>, reason: string) {
  const { error } = await builder;
  if (error) throw new Error(`${reason}:${error.message || ""}`);
}

async function verifyGithubActionsRequest(request: Request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new AuthError("MISSING_BEARER");
  const claims = await verifyJwt(token);
  if (claims.iss !== ISSUER) throw new AuthError("OIDC_ISSUER_DENIED");
  if (claims.aud !== AUDIENCE) throw new AuthError("OIDC_AUDIENCE_DENIED");
  if (claims.repository !== REPOSITORY || claims.actor !== ACTOR) throw new AuthError("OIDC_REPOSITORY_DENIED");
  if (claims.event_name !== "pull_request") throw new AuthError("OIDC_EVENT_DENIED");
  if (!ALLOWED_PR_REFS.has(String(claims.ref || ""))) throw new AuthError("OIDC_REF_DENIED");
  const workflowRef = String(claims.workflow_ref || "");
  const allowedWorkflow = [...ALLOWED_WORKFLOW_PATHS].some((path) => workflowRef.startsWith(`${REPOSITORY}/${path}@`));
  if (!allowedWorkflow) throw new AuthError("OIDC_WORKFLOW_DENIED");
}

async function verifyJwt(token: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new AuthError("MALFORMED_JWT");
  const header = JSON.parse(base64UrlDecode(encodedHeader));
  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("JWT_ALG_DENIED");
  const key = await jwkForKid(header.kid);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!ok) throw new AuthError("JWT_SIGNATURE_DENIED");
  const now = Math.floor(Date.now() / 1000);
  if (Number(payload.exp || 0) <= now || Number(payload.nbf || 0) > now + 60) throw new AuthError("JWT_TIME_DENIED");
  return payload;
}

let jwksCache: { keys: JsonWebKey[]; cachedAt: number } | null = null;

async function jwkForKid(kid: string) {
  if (!jwksCache || Date.now() - jwksCache.cachedAt > 600_000) {
    const response = await fetch(`${ISSUER}/.well-known/jwks`);
    if (!response.ok) throw new AuthError("JWKS_UNAVAILABLE");
    const body = await response.json();
    jwksCache = { keys: body.keys || [], cachedAt: Date.now() };
  }
  const jwk = jwksCache.keys.find((item) => item.kid === kid);
  if (!jwk) throw new AuthError("JWT_KID_DENIED");
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

async function deviceHash(credential: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`deedou-device-v2:${credential}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlDecode(value: string) {
  return new TextDecoder().decode(base64UrlBytes(value));
}

function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function safeIdentifier(value: unknown, label: string) {
  const next = text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,96}$/.test(next)) throw new Error(`${label.toUpperCase()}_INVALID`);
  return next;
}

function safeLocationId(value: unknown) {
  const next = text(value);
  if (!/^[a-z0-9][a-z0-9_-]{2,96}$/i.test(next)) throw new Error("LOCATION_ID_INVALID");
  return next;
}

function safeShortName(value: unknown) {
  const next = text(value).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(next)) throw new Error("ACCOUNT_NAME_INVALID");
  return next;
}

function safeEmail(value: unknown) {
  const next = text(value).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next) || !next.startsWith("deedou.smoke.")) throw new Error("EMAIL_INVALID");
  return next;
}

function safePassword(value: unknown) {
  const next = String(value || "");
  if (next.length < 10 || next.length > 128) throw new Error("PASSWORD_INVALID");
  return next;
}

function text(value: unknown) {
  return String(value || "").trim();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isMissingRelation(message = "") {
  return /does not exist|schema cache/i.test(message);
}

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || "UNKNOWN")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .replace(/service_role|sb_secret_|SUPABASE_SERVICE_ROLE_KEY|JWT_SECRET|DATABASE_URL/gi, "[SECRET_REDACTED]")
    .slice(0, 160);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name) || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

class AuthError extends Error {}
