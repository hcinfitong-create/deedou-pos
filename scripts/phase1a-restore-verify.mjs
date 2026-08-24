import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DB_URL_ENV = "RESTORE_DB_URL";
const COUNT_KEYS = [
  "locations",
  "physicalTables",
  "products",
  "productComponents",
  "orders",
  "staffProfiles",
  "workstationDevices",
  "workstationDeviceSessions",
];
const AUTH_COUNT_KEYS = ["users", "identities", "mfaFactors"];

function canonicalMigrationRows(rows = []) {
  return [...rows]
    .map((row) => ({
      version: String(row.version || ""),
      name: String(row.name || ""),
    }))
    .sort((a, b) => `${a.version}\u0000${a.name}`.localeCompare(`${b.version}\u0000${b.name}`));
}

export function buildVerificationSql() {
  return `
select jsonb_build_object(
  'tables', jsonb_build_object(
    'locations', to_regclass('public.locations') is not null,
    'physical_tables', to_regclass('public.physical_tables') is not null,
    'products', to_regclass('public.products') is not null,
    'product_components', to_regclass('public.product_components') is not null,
    'staff_profiles', to_regclass('public.staff_profiles') is not null,
    'staff_activation_requests', to_regclass('public.staff_activation_requests') is not null,
    'workstation_devices', to_regclass('public.workstation_devices') is not null,
    'workstation_device_sessions', to_regclass('public.workstation_device_sessions') is not null,
    'audit_events', to_regclass('public.audit_events') is not null,
    'auth_users', to_regclass('auth.users') is not null,
    'auth_identities', to_regclass('auth.identities') is not null,
    'auth_mfa_factors', to_regclass('auth.mfa_factors') is not null,
    'schema_migrations', to_regclass('supabase_migrations.schema_migrations') is not null
  ),
  'functions', (
    select jsonb_object_agg(required.name, exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = required.name
    ))
    from (
      values
        ('authorize_staff_access'),
        ('dd011b_service_create_pending_staff'),
        ('dd011b_service_approve_activation'),
        ('revoke_workstation_device'),
        ('dd012_create_product_component'),
        ('dd012_update_product_component'),
        ('dd012_delete_product_component')
    ) as required(name)
  ),
  'counts', jsonb_build_object(
    'locations', (select count(*) from public.locations),
    'physicalTables', (select count(*) from public.physical_tables),
    'products', (select count(*) from public.products),
    'productComponents', (select count(*) from public.product_components),
    'orders', (select count(*) from public.orders),
    'staffProfiles', (select count(*) from public.staff_profiles),
    'workstationDevices', (select count(*) from public.workstation_devices),
    'workstationDeviceSessions', (select count(*) from public.workstation_device_sessions)
  ),
  'auth', jsonb_build_object(
    'counts', jsonb_build_object(
      'users', (select count(*) from auth.users),
      'identities', (select count(*) from auth.identities),
      'mfaFactors', (select count(*) from auth.mfa_factors)
    ),
    'relations', jsonb_build_object(
      'staffProfilesHaveAuthUsers', not exists (
        select 1
        from public.staff_profiles sp
        left join auth.users au on au.id = sp.auth_user_id
        where au.id is null
      ),
      'identitiesHaveAuthUsers', not exists (
        select 1
        from auth.identities ai
        left join auth.users au on au.id = ai.user_id
        where au.id is null
      ),
      'mfaFactorsHaveAuthUsers', not exists (
        select 1
        from auth.mfa_factors mf
        left join auth.users au on au.id = mf.user_id
        where au.id is null
      ),
      'staffAuthUsersHaveIdentity', not exists (
        select 1
        from public.staff_profiles sp
        where not exists (
          select 1 from auth.identities ai where ai.user_id = sp.auth_user_id
        )
      )
    )
  ),
  'migrationHistory', jsonb_build_object(
    'count', (select count(*) from supabase_migrations.schema_migrations),
    'rows', (
      select coalesce(
        jsonb_agg(jsonb_build_object('version', version::text, 'name', name::text) order by version::text, name::text),
        '[]'::jsonb
      )
      from supabase_migrations.schema_migrations
    )
  ),
  'security', jsonb_build_object(
    'rls', jsonb_build_object(
      'products', (select relrowsecurity from pg_class where oid = 'public.products'::regclass),
      'productComponents', (select relrowsecurity from pg_class where oid = 'public.product_components'::regclass),
      'staffProfiles', (select relrowsecurity from pg_class where oid = 'public.staff_profiles'::regclass),
      'workstationDevices', (select relrowsecurity from pg_class where oid = 'public.workstation_devices'::regclass),
      'workstationDeviceSessions', (select relrowsecurity from pg_class where oid = 'public.workstation_device_sessions'::regclass)
    ),
    'privileges', jsonb_build_object(
      'anonCanInsertProducts', has_table_privilege('anon', 'public.products', 'INSERT'),
      'authenticatedCanInsertProducts', has_table_privilege('authenticated', 'public.products', 'INSERT'),
      'authenticatedCanInsertWorkstationDeviceSessions', has_table_privilege('authenticated', 'public.workstation_device_sessions', 'INSERT'),
      'serviceRoleCanMaintainWorkstationDeviceSessions', has_table_privilege('service_role', 'public.workstation_device_sessions', 'INSERT')
    ),
    'functionPrivileges', jsonb_build_object(
      'anonCanAuthorizeStaffAccess', has_function_privilege('anon', 'public.authorize_staff_access(text,text,text,text)'::regprocedure, 'EXECUTE'),
      'authenticatedCanAuthorizeStaffAccess', has_function_privilege('authenticated', 'public.authorize_staff_access(text,text,text,text)'::regprocedure, 'EXECUTE'),
      'authenticatedCanCreateProductComponent', has_function_privilege('authenticated', 'public.dd012_create_product_component(text,text,text,text,text,text,integer,text,integer,text,text,text)'::regprocedure, 'EXECUTE'),
      'authenticatedCannotCreatePendingStaff', not has_function_privilege('authenticated', 'public.dd011b_service_create_pending_staff(uuid,uuid,text,text,text,text)'::regprocedure, 'EXECUTE'),
      'serviceRoleCanCreatePendingStaff', has_function_privilege('service_role', 'public.dd011b_service_create_pending_staff(uuid,uuid,text,text,text,text)'::regprocedure, 'EXECUTE')
    )
  )
)::text;
`;
}

function runPsqlJson({ dbUrl, sql }) {
  const result = spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`Restore verification query failed${stderr ? `: ${stderr}` : ""}`);
  }
  return JSON.parse((result.stdout || "").trim());
}

function assertAllTrue(groupName, values) {
  if (!values || typeof values !== "object" || Object.keys(values).length === 0) {
    throw new Error(`Restore verification missing ${groupName}`);
  }
  const missing = Object.entries(values || {})
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Restore verification missing ${groupName}: ${missing.join(", ")}`);
  }
}

export function compareCounts(expectedCounts, restoredCounts) {
  if (!expectedCounts || typeof expectedCounts !== "object" || Object.keys(expectedCounts).length === 0) {
    throw new Error("Captured restore row counts are required");
  }
  const mismatches = [];
  for (const key of COUNT_KEYS) {
    if (!(key in expectedCounts)) {
      mismatches.push(`${key}: missing captured count`);
      continue;
    }
    const expected = Number(expectedCounts[key]);
    const actual = Number(restoredCounts?.[key]);
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected !== actual) {
      mismatches.push(`${key}: expected ${expectedCounts[key]}, restored ${restoredCounts?.[key]}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Restore row-count mismatch: ${mismatches.join("; ")}`);
  }
}

export function compareAuthRecovery(expectedAuth, restoredAuth) {
  if (!expectedAuth?.counts || typeof expectedAuth.counts !== "object" || Object.keys(expectedAuth.counts).length === 0) {
    throw new Error("Captured Auth recovery counts are required");
  }
  const mismatches = [];
  for (const key of AUTH_COUNT_KEYS) {
    if (!(key in expectedAuth.counts)) {
      mismatches.push(`${key}: missing captured Auth count`);
      continue;
    }
    const expected = Number(expectedAuth.counts[key]);
    const actual = Number(restoredAuth?.counts?.[key]);
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected !== actual) {
      mismatches.push(`${key}: expected ${expectedAuth.counts[key]}, restored ${restoredAuth?.counts?.[key]}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Restore Auth count mismatch: ${mismatches.join("; ")}`);
  }
  assertAllTrue("Auth relations", restoredAuth?.relations);
}

export function compareMigrationHistory(expectedHistory, restoredHistory) {
  if (!Array.isArray(expectedHistory?.rows)) {
    throw new Error("Captured Supabase migration-history rows are required");
  }
  const expectedRows = canonicalMigrationRows(expectedHistory?.rows || []);
  const restoredRows = canonicalMigrationRows(restoredHistory?.rows || []);
  if (expectedRows.length !== restoredRows.length) {
    throw new Error(`Restore migration-history count mismatch: expected ${expectedRows.length}, restored ${restoredRows.length}`);
  }
  const expectedJson = JSON.stringify(expectedRows);
  const restoredJson = JSON.stringify(restoredRows);
  if (expectedJson !== restoredJson) {
    throw new Error("Restore migration-history rows do not match the captured Production ledger");
  }
}

export function assertSecurityPosture(security) {
  assertAllTrue("RLS posture", security?.rls);
  const privileges = security?.privileges || {};
  if (privileges.anonCanInsertProducts !== false) {
    throw new Error("Restore security verification failed: anon can insert products");
  }
  if (privileges.authenticatedCanInsertProducts !== false) {
    throw new Error("Restore security verification failed: authenticated can insert products");
  }
  if (privileges.authenticatedCanInsertWorkstationDeviceSessions !== false) {
    throw new Error("Restore security verification failed: authenticated can insert workstation_device_sessions");
  }
  if (privileges.serviceRoleCanMaintainWorkstationDeviceSessions !== true) {
    throw new Error("Restore security verification failed: service_role cannot maintain workstation_device_sessions");
  }
  assertAllTrue("function ACL posture", security?.functionPrivileges);
}

export async function verifyRestoredBackup({
  decryptedDir,
  dbUrl = process.env[DEFAULT_DB_URL_ENV],
  summaryPath,
  restoreSeconds,
}) {
  if (!dbUrl) {
    throw new Error(`${DEFAULT_DB_URL_ENV} is required`);
  }
  const manifestPath = join(resolve(decryptedDir), "manifest.json");
  const verificationPath = join(resolve(decryptedDir), "verification.json");
  if (!existsSync(manifestPath) || !existsSync(verificationPath)) {
    throw new Error("Decrypted backup manifest and verification.json are required");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expected = JSON.parse(await readFile(verificationPath, "utf8"));
  const restored = runPsqlJson({ dbUrl, sql: buildVerificationSql() });
  assertAllTrue("tables", restored.tables);
  assertAllTrue("functions", restored.functions);
  compareCounts(expected.counts || {}, restored.counts || {});
  compareAuthRecovery(expected.auth || {}, restored.auth || {});
  compareMigrationHistory(expected.migrationHistory || {}, restored.migrationHistory || {});
  assertSecurityPosture(restored.security || {});

  const summary = [
    "# DeeDou Phase 1A Restore Drill Summary",
    "",
    `- backupCreatedAt: ${manifest.createdAt}`,
    `- sourceProjectRef: ${manifest.source?.projectRef || "UNKNOWN"}`,
    `- restoreSeconds: ${restoreSeconds ?? "NOT_RECORDED"}`,
    `- verifiedTables: ${Object.keys(restored.tables || {}).length}`,
    `- verifiedFunctions: ${Object.keys(restored.functions || {}).length}`,
    `- countKeys: ${Object.keys(restored.counts || {}).join(", ")}`,
    `- authCountKeys: ${Object.keys(restored.auth?.counts || {}).join(", ")}`,
    `- migrationHistoryRows: ${restored.migrationHistory?.count ?? "NOT_RECORDED"}`,
    `- securityAssertions: RLS, ACL and representative direct-write denial`,
    "",
  ].join("\n");

  if (summaryPath) {
    const resolvedSummary = resolve(summaryPath);
    await mkdir(dirname(resolvedSummary), { recursive: true });
    await writeFile(resolvedSummary, summary);
  }

  return { manifest, expected, restored };
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const decryptedDir = readFlag(args, "--decrypted-dir");
  const summaryPath = readFlag(args, "--summary");
  const restoreSeconds = readFlag(args, "--restore-seconds");
  if (!decryptedDir) {
    throw new Error("Usage: phase1a-restore-verify.mjs --decrypted-dir <dir> [--summary <file>] [--restore-seconds <seconds>]");
  }
  await verifyRestoredBackup({ decryptedDir, summaryPath, restoreSeconds });
  console.log("Verified DeeDou logical backup restore against disposable database");
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
