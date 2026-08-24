import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  BACKUP_FORMAT,
  EXPECTED_PRODUCTION_REF,
  packBackupBundle,
  recordDumpProbe,
  validateProductionDbUrl,
  unpackBackupBundle,
} from "../scripts/phase1a-backup-bundle.mjs";
import {
  assertSecurityPosture,
  buildDirectWriteDenialSql,
  compareAuthRecovery,
  compareCounts,
  compareMigrationHistory,
  compareOwnerRecovery,
} from "../scripts/phase1a-restore-verify.mjs";

const SLICE_1A_FILES = [
  ".github/workflows/phase1a-free-tier-backup-restore.yml",
  "docs/PHASE1_FREE_TIER_BACKUP_RESTORE_RUNBOOK.md",
  "scripts/phase1a-backup-bundle.mjs",
  "scripts/phase1a-restore-verify.mjs",
  "tests/phase1a-backup-restore.test.js",
];

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "deedou-phase1a-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Phase 1A encrypted backup bundle round-trips without plaintext artifact storage", async () => {
  await withTempDir(async (dir) => {
    const inputDir = join(dir, "plain");
    const outputDir = join(dir, "restore");
    await mkdir(inputDir, { recursive: true });
    await writeFile(join(inputDir, "roles.sql"), "create role deedou_fixture;\n");
    await writeFile(join(inputDir, "schema.sql"), "create table public.phase1a_secret_fixture(id int);\n");
    await writeFile(join(inputDir, "data.sql"), "copy public.phase1a_secret_fixture from stdin;\n1\n\\.\n");
    await writeFile(join(inputDir, "migration_history_schema.sql"), "create schema supabase_migrations;\n");
    await writeFile(join(inputDir, "migration_history_data.sql"), "copy supabase_migrations.schema_migrations from stdin;\n\\.\n");
    await writeFile(join(inputDir, "auth_schema.sql"), "create schema auth;\n");
    await writeFile(join(inputDir, "auth_data.sql"), "copy auth.users from stdin;\n\\.\n");
    await writeFile(
      join(inputDir, "verification.json"),
      JSON.stringify({
        counts: { locations: 1, products: 0 },
        auth: { counts: { users: 1, identities: 1, mfaFactors: 1 } },
        ownerRecovery: {
          counts: {
            activeOwnerAssignments: 1,
            ownerAuthUsers: 1,
            ownerAuthIdentities: 1,
            ownerVerifiedTotpFactors: 1,
          },
          booleans: {
            singleActiveOwner: true,
            ownerResolvesToAuthUser: true,
            ownerHasAuthIdentity: true,
            ownerHasVerifiedTotp: true,
          },
        },
        migrationHistory: { rows: [{ version: "20260823235316", name: "dd012c_combo_components" }] },
      }),
    );

    const bundlePath = join(dir, "backup.ddbak.enc");
    const manifestPath = join(dir, "backup-summary.json");
    const manifest = await packBackupBundle({
      inputDir,
      outputPath: bundlePath,
      sourceRef: "nwohsyzpmogqjbmknwbl",
      manifestOutputPath: manifestPath,
      passphrase: "unit-test-passphrase",
      createdAt: "2026-08-24T00:00:00.000Z",
    });

    assert.equal(manifest.format, BACKUP_FORMAT);
    assert.equal(manifest.source.projectRef, "nwohsyzpmogqjbmknwbl");
    assert.equal(manifest.files["roles.sql"].bytes, "create role deedou_fixture;\n".length);
    assert.equal(manifest.files["auth_data.sql"].bytes, "copy auth.users from stdin;\n\\.\n".length);
    assert.equal(manifest.verification.migrationHistory.count, 1);
    assert.equal("rows" in manifest.verification.migrationHistory, false);
    assert.equal(manifest.verification.ownerRecovery.counts.ownerVerifiedTotpFactors, 1);

    const encryptedText = await readFile(bundlePath, "utf8");
    assert.equal(encryptedText.includes("phase1a_secret_fixture"), false);
    assert.equal(encryptedText.includes("deedou_fixture"), false);

    const unpackedManifest = await unpackBackupBundle({
      inputPath: bundlePath,
      outputDir,
      passphrase: "unit-test-passphrase",
    });
    assert.deepEqual(unpackedManifest.files, manifest.files);
    assert.equal(await readFile(join(outputDir, "schema.sql"), "utf8"), "create table public.phase1a_secret_fixture(id int);\n");
    assert.equal(await readFile(join(outputDir, "auth_schema.sql"), "utf8"), "create schema auth;\n");
  });
});

test("Phase 1A Production DB URL guard accepts only the expected Production Supabase ref", () => {
  assert.deepEqual(
    validateProductionDbUrl({
      dbUrl: `postgresql://postgres:dummy-password@db.${EXPECTED_PRODUCTION_REF}.supabase.co:5432/postgres`,
    }),
    { ok: true, projectRef: EXPECTED_PRODUCTION_REF },
  );
  assert.deepEqual(
    validateProductionDbUrl({
      dbUrl: `postgresql://postgres.${EXPECTED_PRODUCTION_REF}:dummy-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
    }),
    { ok: true, projectRef: EXPECTED_PRODUCTION_REF },
  );
  assert.throws(
    () =>
      validateProductionDbUrl({
        dbUrl: "postgresql://postgres:dummy-password@db.nwyhxdcslxxjirsmqnxo.supabase.co:5432/postgres",
      }),
    /does not target the expected Production project ref/,
  );
  assert.throws(
    () =>
      validateProductionDbUrl({
        dbUrl: "postgresql://postgres:dummy-password@example.invalid:5432/postgres",
      }),
    /does not target the expected Production project ref/,
  );
  assert.throws(
    () =>
      validateProductionDbUrl({
        dbUrl: `postgresql://postgres.${EXPECTED_PRODUCTION_REF}:dummy-password@db.nwyhxdcslxxjirsmqnxo.supabase.co:5432/postgres`,
      }),
    /ambiguous/,
  );
  assert.throws(
    () => validateProductionDbUrl({ dbUrl: "not-a-postgres-url" }),
    /malformed or unsupported/,
  );
});

test("Phase 1A backup bundle fails closed without encryption passphrase", async () => {
  await withTempDir(async (dir) => {
    const inputDir = join(dir, "plain");
    await mkdir(inputDir, { recursive: true });
    await writeFile(join(inputDir, "roles.sql"), "-- roles\n");
    await writeFile(join(inputDir, "schema.sql"), "-- schema\n");
    await writeFile(join(inputDir, "data.sql"), "-- data\n");
    await writeFile(join(inputDir, "migration_history_schema.sql"), "-- migration schema\n");
    await writeFile(join(inputDir, "migration_history_data.sql"), "-- migration data\n");
    await writeFile(join(inputDir, "auth_schema.sql"), "-- auth schema\n");
    await writeFile(join(inputDir, "auth_data.sql"), "-- auth data\n");

    await assert.rejects(
      () =>
        packBackupBundle({
          inputDir,
          outputPath: join(dir, "backup.ddbak.enc"),
          sourceRef: "nwohsyzpmogqjbmknwbl",
          passphrase: "",
        }),
      /DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE is required/,
    );
  });
});

test("Phase 1A restore verifier rejects row-count mismatches", () => {
  const matchingCounts = {
    locations: 1,
    physicalTables: 2,
    products: 0,
    productComponents: 0,
    orders: 0,
    staffProfiles: 0,
    workstationDevices: 0,
    workstationDeviceSessions: 0,
  };
  assert.doesNotThrow(() =>
    compareCounts(
      matchingCounts,
      matchingCounts,
    ),
  );
  assert.throws(
    () => compareCounts({ ...matchingCounts, products: 2 }, { ...matchingCounts, products: 1 }),
    /Restore row-count mismatch: products/,
  );
  assert.throws(
    () => compareCounts({ locations: 1, products: 2 }, { locations: 1, products: 2 }),
    /missing captured count/,
  );
});

test("Phase 1A verifies migration ledger, Auth recovery, and representative security posture", () => {
  assert.doesNotThrow(() =>
    compareMigrationHistory(
      { rows: [{ version: "20260823061000", name: "dd011b_identity_device_schema" }] },
      { rows: [{ name: "dd011b_identity_device_schema", version: "20260823061000" }] },
    ),
  );
  assert.throws(
    () => compareMigrationHistory({ rows: [{ version: "1", name: "a" }] }, { rows: [{ version: "2", name: "b" }] }),
    /migration-history rows do not match/,
  );

  assert.doesNotThrow(() =>
    compareAuthRecovery(
      { counts: { users: 1, identities: 1, mfaFactors: 1 } },
      {
        counts: { users: 1, identities: 1, mfaFactors: 1 },
        relations: {
          staffProfilesHaveAuthUsers: true,
          identitiesHaveAuthUsers: true,
          mfaFactorsHaveAuthUsers: true,
          staffAuthUsersHaveIdentity: true,
        },
      },
    ),
  );

  const ownerRecovery = {
    counts: {
      activeOwnerAssignments: 1,
      ownerAuthUsers: 1,
      ownerAuthIdentities: 1,
      ownerVerifiedTotpFactors: 1,
    },
    booleans: {
      singleActiveOwner: true,
      ownerResolvesToAuthUser: true,
      ownerHasAuthIdentity: true,
      ownerHasVerifiedTotp: true,
    },
  };
  assert.doesNotThrow(() => compareOwnerRecovery(ownerRecovery, ownerRecovery));
  assert.throws(
    () =>
      compareOwnerRecovery(
        {
          ...ownerRecovery,
          counts: { ...ownerRecovery.counts, ownerVerifiedTotpFactors: 0 },
          booleans: { ...ownerRecovery.booleans, ownerHasVerifiedTotp: false },
        },
        ownerRecovery,
      ),
    /ownerHasVerifiedTotp/,
  );
  assert.throws(
    () =>
      compareOwnerRecovery(
        ownerRecovery,
        {
          ...ownerRecovery,
          counts: { ...ownerRecovery.counts, ownerVerifiedTotpFactors: 0 },
          booleans: { ...ownerRecovery.booleans, ownerHasVerifiedTotp: false },
        },
      ),
    /Owner recovery mismatch/,
  );

  assert.doesNotThrow(() =>
    assertSecurityPosture({
      rls: {
        products: true,
        productComponents: true,
        staffProfiles: true,
        workstationDevices: true,
        workstationDeviceSessions: true,
      },
      privileges: {
        anonCanInsertProducts: false,
        authenticatedCanInsertProducts: false,
        authenticatedCanInsertWorkstationDeviceSessions: false,
        serviceRoleCanMaintainWorkstationDeviceSessions: true,
      },
      functionPrivileges: {
        anonCanAuthorizeStaffAccess: true,
        authenticatedCanAuthorizeStaffAccess: true,
        authenticatedCanCreateProductComponent: true,
        authenticatedCannotCreatePendingStaff: true,
        serviceRoleCanCreatePendingStaff: true,
      },
    }),
  );
});

test("Phase 1A restore verifier includes executable direct protected-table write denial", () => {
  const sql = buildDirectWriteDenialSql();
  assert.match(sql, /set local role authenticated/i);
  assert.match(sql, /insert into public\.staff_role_assignments/i);
  assert.match(sql, /insufficient_privilege/i);
  assert.match(sql, /PHASE1A_DIRECT_WRITE_UNEXPECTEDLY_SUCCEEDED/);
});

test("Phase 1A records pinned CLI standard Auth dump coverage without storing secrets", async () => {
  await withTempDir(async (dir) => {
    const verificationPath = join(dir, "verification.json");
    const schemaPath = join(dir, "schema.sql");
    const dataPath = join(dir, "data.sql");
    await writeFile(verificationPath, JSON.stringify({ counts: {} }));
    await writeFile(schemaPath, "create table public.only_public(id int);\n");
    await writeFile(dataPath, "copy public.only_public from stdin;\n\\.\n");

    const probe = await recordDumpProbe({ verificationPath, schemaPath, dataPath });
    assert.equal(probe.standardDumpContainsAuthSchema, false);
    assert.equal(probe.standardDumpContainsAuthData, false);

    const updated = JSON.parse(await readFile(verificationPath, "utf8"));
    assert.equal(updated.cliDumpProbe.standardDumpContainsAuthSchema, false);
    assert.equal(updated.cliDumpProbe.standardDumpContainsAuthData, false);
  });
});

test("Phase 1A workflow is narrowly scoped to encrypted logical backup and safe restore", async () => {
  const workflow = await readFile(".github/workflows/phase1a-free-tier-backup-restore.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /DEEDOU_PRODUCTION_DB_URL/);
  assert.match(workflow, /DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE/);
  assert.match(workflow, /validate-production-url/);
  assert.ok(
    workflow.indexOf("Validate Production database target") < workflow.indexOf("Capture non-sensitive source verification counts"),
    "Production DB target guard must run before source verification queries",
  );
  assert.ok(
    workflow.indexOf("Validate Production database target") < workflow.indexOf("Dump roles, schema and data using Supabase logical export"),
    "Production DB target guard must run before any Supabase dump",
  );
  assert.match(workflow, /ownerRecovery/);
  assert.match(workflow, /supabase db dump --db-url "\$DEEDOU_PRODUCTION_DB_URL" --role-only/);
  assert.match(workflow, /supabase db dump --db-url "\$DEEDOU_PRODUCTION_DB_URL" --data-only --use-copy/);
  assert.match(workflow, /--schema supabase_migrations/);
  assert.match(workflow, /--schema auth/);
  assert.match(workflow, /workstation_device_sessions/);
  assert.equal(workflow.includes("backend" + "_device_sessions"), false);
  assert.match(workflow, /phase1a-backup-bundle\.mjs pack/);
  assert.match(workflow, /phase1a-backup-bundle\.mjs unpack/);
  assert.match(workflow, /phase1a-restore-verify\.mjs/);
  assert.match(workflow, /--single-transaction/);
  assert.match(workflow, /ON_ERROR_STOP=1/);
  assert.match(workflow, /SET session_replication_role = replica/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /set -x/);
  assert.doesNotMatch(workflow, /pull_request:/);
});

test("Phase 1A files never reintroduce the obsolete device-session table name", async () => {
  const obsoleteTableName = "backend" + "_device_sessions";
  for (const filePath of SLICE_1A_FILES) {
    const content = await readFile(filePath, "utf8");
    assert.equal(content.includes(obsoleteTableName), false, `${filePath} must not reference the obsolete table name`);
  }
});

test("Phase 1A runbook keeps implementation merge and post-merge operational gates separate", async () => {
  const runbook = await readFile("docs/PHASE1_FREE_TIER_BACKUP_RESTORE_RUNBOOK.md", "utf8");
  assert.match(runbook, /Implementation merge gate/);
  assert.match(runbook, /Post-merge operational acceptance gate/);
  assert.match(runbook, /Slice 1A is still explicitly NOT ACCEPTED/);
  assert.match(runbook, /first post-merge drill fails/);
  assert.match(runbook, /follow-up remediation PR is required before Slice 1B/);
  assert.doesNotMatch(runbook, /dispatch .*PR\/head workflow/i);
  assert.doesNotMatch(runbook, /manually dispatch .*pre-merge/i);
});
