import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildVerificationSql } from "./phase1a-restore-verify.mjs";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DB_URL = process.env.DB_URL || process.env.RESTORE_DB_URL || DEFAULT_DB_URL;
const SOURCE_REF = "local-synthetic-phase1a";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const NODE = process.execPath;

const OWNER_AUTH_USER_ID = "51000000-0000-4000-8000-000000000001";
const OWNER_MFA_FACTOR_ID = "51000000-0000-4000-8000-000000000101";
const SYNTHETIC_OWNER_PASSWORD = `phase1a-owner-${randomBytes(18).toString("base64url")}`;
const SYNTHETIC_DEVICE_CREDENTIAL = `phase1a-device-${randomBytes(24).toString("base64url")}`;
const SYNTHETIC_TOTP_SECRET = randomBytes(20).toString("base64url");

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function run(command, args, label, options = {}) {
  console.log(`[phase1a-e2e] ${label}`);
  execFileSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: options.stdio || "inherit",
    encoding: options.encoding,
    windowsHide: true,
  });
}

function capture(command, args, label, options = {}) {
  console.log(`[phase1a-e2e] ${label}`);
  return execFileSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  });
}

function psqlArgs(extraArgs) {
  return [DB_URL, "-v", "ON_ERROR_STOP=1", ...extraArgs];
}

function runPsql(sql, label) {
  run("psql", psqlArgs(["-c", sql]), label);
}

function capturePsql(sql, label) {
  return capture("psql", psqlArgs(["-tA", "-c", sql]), label).trim();
}

function buildSyntheticFixtureSql() {
  return `
begin;

insert into public.locations (id, name, timezone, currency)
values ('phase1a-synthetic-location', 'Phase 1A Synthetic Location', 'Asia/Ho_Chi_Minh', 'VND')
on conflict (id) do update
set name = excluded.name,
    timezone = excluded.timezone,
    currency = excluded.currency;

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
values (
  '00000000-0000-0000-0000-000000000000',
  '${OWNER_AUTH_USER_ID}',
  'authenticated',
  'authenticated',
  'phase1a-owner@example.invalid',
  crypt(${sqlText(SYNTHETIC_OWNER_PASSWORD)}, gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  false
)
on conflict (id) do update
set email = excluded.email,
    raw_app_meta_data = excluded.raw_app_meta_data,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

insert into auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '${OWNER_AUTH_USER_ID}',
  '${OWNER_AUTH_USER_ID}',
  jsonb_build_object('sub', '${OWNER_AUTH_USER_ID}', 'email', 'phase1a-owner@example.invalid'),
  'email',
  'phase1a-owner@example.invalid',
  now(),
  now(),
  now()
)
on conflict (provider, provider_id) do update
set user_id = excluded.user_id,
    identity_data = excluded.identity_data,
    updated_at = now();

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  secret,
  created_at,
  updated_at
)
values (
  '${OWNER_MFA_FACTOR_ID}',
  '${OWNER_AUTH_USER_ID}',
  'Phase 1A Synthetic TOTP',
  'totp',
  'verified',
  ${sqlText(SYNTHETIC_TOTP_SECRET)},
  now(),
  now()
)
on conflict (id) do update
set status = 'verified',
    updated_at = now();

insert into public.staff_profiles (
  id,
  auth_user_id,
  display_name,
  active,
  provisioning_status
)
values (
  'phase1a-owner-staff',
  '${OWNER_AUTH_USER_ID}',
  'Phase 1A Synthetic Owner',
  true,
  'ACTIVE'
)
on conflict (id) do update
set auth_user_id = excluded.auth_user_id,
    display_name = excluded.display_name,
    active = excluded.active,
    provisioning_status = excluded.provisioning_status;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values ('phase1a-owner-staff', 'phase1a-synthetic-location', true)
on conflict (staff_profile_id, location_id) do update
set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values ('phase1a-owner-staff', 'phase1a-synthetic-location', 'OWNER', true)
on conflict (staff_profile_id, location_id, role_id) do update
set active = excluded.active;

insert into public.workstation_devices (
  id,
  location_id,
  label,
  mode,
  credential_hash,
  active,
  registered_by_staff_profile_id
)
values (
  'phase1a-owner-admin-device',
  'phase1a-synthetic-location',
  'Phase 1A Synthetic Admin Device',
  'ADMIN',
  public.hash_device_credential(${sqlText(SYNTHETIC_DEVICE_CREDENTIAL)}),
  true,
  'phase1a-owner-staff'
)
on conflict (id) do update
set location_id = excluded.location_id,
    label = excluded.label,
    mode = excluded.mode,
    credential_hash = excluded.credential_hash,
    active = excluded.active,
    registered_by_staff_profile_id = excluded.registered_by_staff_profile_id;

insert into public.workstation_device_sessions (
  device_id,
  auth_user_id,
  session_token_hash,
  active,
  expires_at
)
values (
  'phase1a-owner-admin-device',
  '${OWNER_AUTH_USER_ID}',
  repeat('1', 64),
  true,
  now() + interval '30 days'
)
on conflict (session_token_hash) do update
set active = excluded.active,
    expires_at = excluded.expires_at;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) then
    execute $ddl$
      insert into supabase_migrations.schema_migrations (version, name, statements)
      values ('29991231010101', 'phase1a_synthetic_local_ledger', array['-- phase1a synthetic local ledger'])
      on conflict (version) do update
      set name = excluded.name,
          statements = excluded.statements
    $ddl$;
  else
    insert into supabase_migrations.schema_migrations (version, name)
    values ('29991231010101', 'phase1a_synthetic_local_ledger')
    on conflict (version) do update
    set name = excluded.name;
  end if;
end $$;

commit;
`;
}

async function writeSourceVerification(plainDir) {
  const restoredShape = JSON.parse(capturePsql(buildVerificationSql(), "capture local synthetic verification JSON"));
  const verification = {
    capturedAt: new Date().toISOString(),
    sourceProjectRef: SOURCE_REF,
    counts: restoredShape.counts,
    auth: restoredShape.auth,
    ownerRecovery: restoredShape.ownerRecovery,
    migrationHistory: restoredShape.migrationHistory,
  };
  await writeFile(join(plainDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
}

async function main() {
  const root = process.env.PHASE1A_E2E_ROOT || await mkdtemp(join(tmpdir(), "deedou-phase1a-e2e-"));
  const plainDir = join(root, "plain");
  const decryptedDir = join(root, "decrypted");
  const artifactDir = join(root, "artifact");
  const restoreResetPath = join(decryptedDir, "restore-reset.sql");
  const encryptedBundlePath = join(artifactDir, "synthetic.ddbak.enc");
  const summaryPath = join(artifactDir, "restore-summary.md");
  const passphrase = `phase1a-synthetic-${randomBytes(24).toString("base64url")}`;

  let keepWorkspace = process.env.PHASE1A_E2E_KEEP_WORKSPACE === "1";
  try {
    await mkdir(plainDir, { recursive: true });
    await mkdir(decryptedDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });

    const supabaseVersion = capture(NPX, ["supabase", "--version"], "confirm pinned Supabase CLI").trim();
    if (supabaseVersion !== "2.113.0") {
      throw new Error(`Expected Supabase CLI 2.113.0, got ${supabaseVersion}`);
    }
    process.env.DEEDOU_SUPABASE_CLI_VERSION = supabaseVersion;

    runPsql(buildSyntheticFixtureSql(), "create local-only Owner/Auth/TOTP/device/session/migration fixtures");
    await writeSourceVerification(plainDir);

    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "--role-only", "-f", join(plainDir, "roles.sql")], "dump roles with Supabase CLI");
    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "-f", join(plainDir, "schema.sql")], "dump normal schema with Supabase CLI");
    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "--data-only", "--use-copy", "-f", join(plainDir, "data.sql")], "dump normal data with Supabase CLI");
    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "--schema", "supabase_migrations", "-f", join(plainDir, "migration_history_schema.sql")], "dump migration-history schema with Supabase CLI");
    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "--schema", "supabase_migrations", "--data-only", "--use-copy", "-f", join(plainDir, "migration_history_data.sql")], "dump migration-history data with Supabase CLI");
    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "--schema", "auth", "-f", join(plainDir, "auth_schema.sql")], "dump Auth schema with Supabase CLI");
    run(NPX, ["supabase", "db", "dump", "--db-url", DB_URL, "--schema", "auth", "--data-only", "--use-copy", "-f", join(plainDir, "auth_data.sql")], "dump Auth data with Supabase CLI");

    run(NODE, [
      "scripts/phase1a-backup-bundle.mjs",
      "record-probe",
      "--verification",
      join(plainDir, "verification.json"),
      "--schema",
      join(plainDir, "schema.sql"),
      "--data",
      join(plainDir, "data.sql"),
    ], "record standard dump Auth coverage", {
      env: { DEEDOU_SUPABASE_CLI_VERSION: supabaseVersion },
    });

    run(NODE, [
      "scripts/phase1a-backup-bundle.mjs",
      "pack",
      "--input-dir",
      plainDir,
      "--output",
      encryptedBundlePath,
      "--source-ref",
      SOURCE_REF,
      "--manifest-output",
      join(artifactDir, "backup-summary.json"),
    ], "pack encrypted synthetic backup bundle", {
      env: { DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE: passphrase },
    });

    run(NODE, [
      "scripts/phase1a-backup-bundle.mjs",
      "unpack",
      "--input",
      encryptedBundlePath,
      "--output-dir",
      decryptedDir,
    ], "unpack encrypted synthetic backup bundle", {
      env: { DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE: passphrase },
    });

    await writeFile(restoreResetPath, [
      "drop schema if exists public cascade;",
      "drop schema if exists auth cascade;",
      "drop schema if exists supabase_migrations cascade;",
      "",
    ].join("\n"));

    const restoreStartedAt = Date.now();
    run("psql", [
      DB_URL,
      "--single-transaction",
      "--variable",
      "ON_ERROR_STOP=1",
      "--file",
      restoreResetPath,
      "--file",
      join(decryptedDir, "roles.sql"),
      "--file",
      join(decryptedDir, "auth_schema.sql"),
      "--file",
      join(decryptedDir, "migration_history_schema.sql"),
      "--file",
      join(decryptedDir, "schema.sql"),
      "--command",
      "SET session_replication_role = replica",
      "--file",
      join(decryptedDir, "auth_data.sql"),
      "--file",
      join(decryptedDir, "data.sql"),
      "--file",
      join(decryptedDir, "migration_history_data.sql"),
    ], "restore synthetic backup into disposable database with fail-fast trigger-safe boundary");
    const restoreSeconds = Math.max(0, Math.round((Date.now() - restoreStartedAt) / 1000));

    run(NODE, [
      "scripts/phase1a-restore-verify.mjs",
      "--decrypted-dir",
      decryptedDir,
      "--summary",
      summaryPath,
      "--restore-seconds",
      String(restoreSeconds),
    ], "run real Phase 1A restore verifier including runtime direct-write denial", {
      env: { RESTORE_DB_URL: DB_URL },
    });

    console.log("[phase1a-e2e] synthetic PR-safe backup/restore drill passed");
    console.log("[phase1a-e2e] verified: local fixtures, auth dump, migration dump, pack, unpack, restore, Owner TOTP recovery, direct-write denial");
  } finally {
    if (keepWorkspace) {
      console.log(`[phase1a-e2e] retained workspace for diagnostics: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
      console.log("[phase1a-e2e] removed plaintext synthetic backup workspace");
    }
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
