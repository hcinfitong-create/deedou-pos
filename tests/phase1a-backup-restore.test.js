import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  BACKUP_FORMAT,
  packBackupBundle,
  unpackBackupBundle,
} from "../scripts/phase1a-backup-bundle.mjs";
import { compareCounts } from "../scripts/phase1a-restore-verify.mjs";

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
    await writeFile(
      join(inputDir, "verification.json"),
      JSON.stringify({ counts: { locations: 1, products: 0 } }),
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
  });
});

test("Phase 1A backup bundle fails closed without encryption passphrase", async () => {
  await withTempDir(async (dir) => {
    const inputDir = join(dir, "plain");
    await mkdir(inputDir, { recursive: true });
    await writeFile(join(inputDir, "roles.sql"), "-- roles\n");
    await writeFile(join(inputDir, "schema.sql"), "-- schema\n");
    await writeFile(join(inputDir, "data.sql"), "-- data\n");

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
  assert.doesNotThrow(() =>
    compareCounts(
      { locations: 1, physicalTables: 2, products: 0 },
      { locations: 1, physicalTables: 2, products: 0 },
    ),
  );
  assert.throws(
    () => compareCounts({ locations: 1, products: 2 }, { locations: 1, products: 1 }),
    /Restore row-count mismatch: products/,
  );
});

test("Phase 1A workflow is narrowly scoped to encrypted logical backup and safe restore", async () => {
  const workflow = await readFile(".github/workflows/phase1a-free-tier-backup-restore.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /DEEDOU_PRODUCTION_DB_URL/);
  assert.match(workflow, /DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE/);
  assert.match(workflow, /supabase db dump --db-url "\$DEEDOU_PRODUCTION_DB_URL" --role-only/);
  assert.match(workflow, /supabase db dump --db-url "\$DEEDOU_PRODUCTION_DB_URL" --data-only --use-copy/);
  assert.match(workflow, /phase1a-backup-bundle\.mjs pack/);
  assert.match(workflow, /phase1a-backup-bundle\.mjs unpack/);
  assert.match(workflow, /phase1a-restore-verify\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /set -x/);
});
