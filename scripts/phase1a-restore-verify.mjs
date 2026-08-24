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
  "backendDeviceSessions",
];

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
    'backend_device_sessions', to_regclass('public.backend_device_sessions') is not null,
    'audit_events', to_regclass('public.audit_events') is not null
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
    'backendDeviceSessions', (select count(*) from public.backend_device_sessions)
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
  const missing = Object.entries(values || {})
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Restore verification missing ${groupName}: ${missing.join(", ")}`);
  }
}

export function compareCounts(expectedCounts, restoredCounts) {
  const mismatches = [];
  for (const key of COUNT_KEYS) {
    if (!(key in expectedCounts)) continue;
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

  const summary = [
    "# DeeDou Phase 1A Restore Drill Summary",
    "",
    `- backupCreatedAt: ${manifest.createdAt}`,
    `- sourceProjectRef: ${manifest.source?.projectRef || "UNKNOWN"}`,
    `- restoreSeconds: ${restoreSeconds ?? "NOT_RECORDED"}`,
    `- verifiedTables: ${Object.keys(restored.tables || {}).length}`,
    `- verifiedFunctions: ${Object.keys(restored.functions || {}).length}`,
    `- countKeys: ${Object.keys(restored.counts || {}).join(", ")}`,
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
