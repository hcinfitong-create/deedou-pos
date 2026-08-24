# Phase 1A Free-tier Backup and Restore Runbook

This runbook owns the interim DeeDou logical backup and restore-drill posture while the accepted infrastructure decision keeps Supabase on the Free plan during build/testing.

It does not replace the DD-008D cutover runbook. DD-008D remains the authority for production cutover and rollback policy. This document is only the Phase 1A backup/restore operating procedure tracked by Issue #40.

## Scope

Phase 1A establishes a reproducible backup artifact and a disposable restore drill.

In scope:

- Supabase-supported logical export of roles, schema and data.
- Supabase-supported logical export of the Production migration-history ledger.
- Explicit Auth schema/data logical export for Owner identity/MFA recoverability.
- Encrypted GitHub Actions artifact.
- Restore drill into a disposable local Supabase/Postgres target in CI.
- Non-sensitive manifest, checksums, row-count checks and restore timing.
- Interim RPO/RTO documentation for the Free-tier development posture.

Out of scope:

- paid Supabase managed backups or PITR enablement;
- Production/staging schema or data mutation;
- Auth redirect/signup posture;
- leaked-password protection configuration;
- public QR or Admin rate limiting;
- audit/log retention implementation;
- billing, VAT, service fee or e-invoice behavior;
- menu/business data provisioning;
- self-hosting migration.

## Required GitHub secrets

Configure these secrets in GitHub before running the workflow. Never paste their values into chat, commits, PR comments or logs.

- `DEEDOU_PRODUCTION_DB_URL`: percent-encoded Production Postgres connection string for `supabase db dump --db-url`.
- `DEEDOU_BACKUP_ENCRYPTION_PASSPHRASE`: high-entropy passphrase used only by the backup workflow to encrypt/decrypt the logical bundle.

The workflow records the non-secret Production project ref/name as `nwohsyzpmogqjbmknwbl` so operators can identify the source without exposing credentials.

Before any verification query or dump, the workflow validates that `DEEDOU_PRODUCTION_DB_URL` targets that expected Production project ref. The guard supports Supabase direct database URLs and session-pooler URLs where the project ref appears in either the hostname or the `postgres.<project-ref>` username. It fails closed for the known staging ref, unknown refs, malformed URLs and ambiguous URLs. It never prints the configured URL, username, password, host credential or connection string.

## Backup format

The workflow creates three Supabase logical dumps:

```bash
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --role-only -f roles.sql
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" -f schema.sql
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --data-only --use-copy -f data.sql
```

It also preserves the Production Supabase migration ledger using the Supabase-documented migration-history path:

```bash
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --schema supabase_migrations -f migration_history_schema.sql
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --schema supabase_migrations --data-only --use-copy -f migration_history_data.sql
```

The workflow probes whether the standard schema/data dump contains Auth records, then uses explicit Auth schema/data dumps for DD-011B Owner identity/MFA recoverability evidence:

```bash
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --schema auth -f auth_schema.sql
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --schema auth --data-only --use-copy -f auth_data.sql
```

Auth backup material can include sensitive managed Auth database records. It must remain only inside runner temp storage and the encrypted bundle. Do not upload plaintext Auth SQL, password hashes, MFA secrets, session tokens, JWTs, cookies, device secrets or database credentials.

The committed helper `scripts/phase1a-backup-bundle.mjs` then builds one encrypted `.ddbak.enc` bundle containing:

- `roles.sql`;
- `schema.sql`;
- `data.sql`;
- `migration_history_schema.sql`;
- `migration_history_data.sql`;
- `auth_schema.sql`;
- `auth_data.sql`;
- `verification.json`;
- a manifest with UTC creation time, non-secret source ref, file sizes and SHA-256 checksums.

Encryption uses Node.js standard library only:

- AES-256-GCM;
- PBKDF2-SHA256 key derivation;
- random salt and IV per bundle.

Plain SQL is kept only in `$RUNNER_TEMP` and is removed in an `always()` cleanup step. The workflow uploads only the encrypted bundle and non-sensitive summary files.

## Restore drill design

The workflow starts a disposable local Supabase target with the pinned CLI used by the repository. It does not connect the restore target to Production or staging.

Restore order:

1. decrypt the encrypted bundle into a temporary runner directory;
2. reset only the disposable target's `public`, `auth` and `supabase_migrations` schemas;
3. restore `roles.sql`, `schema.sql`, `migration_history_schema.sql` and `auth_schema.sql`;
4. set `session_replication_role = replica` for trigger-safe data import;
5. restore `auth_data.sql`, `data.sql` and `migration_history_data.sql`;
6. verify representative schema objects, Auth identity/MFA consistency, Production migration-history match, DD-011B/DD-012C functions, RLS/ACL posture and row counts;
7. write a non-sensitive restore summary with elapsed restore seconds;
8. remove decrypted SQL.

The restore step uses one `psql --single-transaction --variable ON_ERROR_STOP=1` restore boundary for reset/schema/data/history/Auth restore. SQL errors stop the workflow and roll back the restore transaction. The reset is destructive only to the disposable restore target named by `RESTORE_DB_URL`.

Representative object checks include the staff/device authority tables, catalog/component tables and the critical DD-011B/DD-012C functions:

- `authorize_staff_access`;
- `dd011b_service_create_pending_staff`;
- `dd011b_service_approve_activation`;
- `revoke_workstation_device`;
- `dd012_create_product_component`;
- `dd012_update_product_component`;
- `dd012_delete_product_component`.

DD-011B canonical device session authority is `public.workstation_device_sessions`. Slice 1A must not use any earlier non-canonical device-session table spelling. The DD-011B backend-session-required policy flag remains a configuration field and is not a table.

Representative row-count checks compare counts captured before backup against the restored disposable target for:

- locations;
- physical tables;
- products;
- product components;
- orders;
- staff profiles;
- workstation devices;
- workstation device sessions.

Auth recovery checks compare counts only for:

- `auth.users`;
- `auth.identities`;
- `auth.mfa_factors`.

Relationship checks verify staff profiles point to restored Auth users, Auth identities/MFA factors point to restored Auth users, and each restored staff Auth user has an identity. Owner-specific recovery checks also verify the accepted DD-011B invariant without selecting or logging IDs: exactly one active `OWNER` assignment, that active Owner resolves to a restored Auth user, that Owner has at least one restored Auth identity, and that Owner has at least one verified TOTP MFA factor. They never print IDs, email addresses, password hashes, MFA secrets, recovery tokens, refresh tokens or session cookies.

Migration-history checks compare the exact captured `(version, name)` set from `supabase_migrations.schema_migrations` against the restored disposable target. The public backup summary records only a count and checksum; the exact set remains in the encrypted bundle/temporary restore workspace.

Representative post-restore security checks verify:

- RLS remains enabled on protected catalog/staff/device/session tables;
- anonymous/authenticated protected-table inserts remain denied for representative tables;
- `service_role` can still maintain workstation device sessions;
- expected execute grants remain present for `authorize_staff_access` and DD-012C component RPCs;
- DD-011B service-only staff provisioning functions remain unavailable to `authenticated`.

The restore verifier also performs one executable disposable-target denial proof: it temporarily switches the restore connection to `authenticated`, attempts a harmless direct insert into `public.staff_role_assignments`, and requires an `insufficient_privilege`/RLS-style failure. If that direct protected-table write succeeds, or if it fails for an unrelated constraint/data-shape reason, the restore drill fails closed. This assertion runs only against the disposable restore database named by `RESTORE_DB_URL`, never against Production or staging.

Supabase-managed project configuration outside the database, including Dashboard Auth Site URL, redirect allowlist, signup posture, Auth rate-limit settings and leaked-password protection, is not recovered by this logical DB backup. Those remain separate Phase 1 operator verification steps.


## Interim RPO/RTO

Accepted interim posture while DeeDou remains on Supabase Free:

- target RPO: 24 hours once the scheduled daily workflow is configured and passing;
- initial target RTO: 4 hours, provisional until a successful restore drill records measured restore evidence;
- managed Supabase daily backups/PITR are not available in the accepted Free posture;
- leaked-password protection remains an accepted Free-tier limitation until the infrastructure upgrade/self-hosting gate;
- Vercel Hobby/free deployment remains development and validation infrastructure, not final commercial store hosting;
- hosted-Pro or self-hosting remains a separate go-live infrastructure gate.

Do not claim the RTO is satisfied until the workflow records a successful measured restore drill.

## Running the workflow

The workflow is `.github/workflows/phase1a-free-tier-backup-restore.yml`.

Triggers:

- manual `workflow_dispatch`;
- daily schedule at `18:17 UTC`.

The workflow intentionally remains manual and scheduled only. It must not gain a pull request trigger because that would risk exposing Production database secrets to unmerged PR code.

GitHub Actions only receives `workflow_dispatch` events for a workflow file that already exists on the repository default branch, and scheduled workflows run from the default branch. Because this workflow is newly introduced by PR #54, the lifecycle has two gates:

### Implementation merge gate

Source review plus exact-head CI may allow the PR #54 tooling to merge into `main`, but Slice 1A is still explicitly NOT ACCEPTED at this gate. No real Production drill evidence or measured restore duration exists merely because the implementation PR is green.

### Post-merge operational acceptance gate

After the workflow exists on `main`, an operator confirms the two GitHub secret names are configured, manually dispatches `.github/workflows/phase1a-free-tier-backup-restore.yml` from `main`, and verifies the sanitized encrypted-backup/disposable-restore evidence. Only that successful post-merge drill can close Slice 1A and provide measured RTO evidence.

If the first post-merge drill fails, Phase 1A remains open and a follow-up remediation PR is required before Slice 1B starts.

## Operator review checklist

Before merging the implementation PR:

- confirm source review is complete;
- confirm exact-head CI for the PR is green;
- confirm the workflow has no PR trigger;
- confirm no Production/staging mutation is required for implementation validation.

After the workflow is on `main`, before accepting Slice 1A:

- confirm both required GitHub secrets are configured;
- confirm artifact retention is acceptable for encrypted backup bundles;
- confirm the encryption passphrase is stored outside GitHub in an operator-controlled secret manager;
- manually dispatch the workflow from `main` and verify the restore drill summary;
- record the measured restore duration after the first successful safe drill;
- verify no plaintext SQL artifact was uploaded.

## Open Phase 1 gates

Phase 1A does not complete the whole Production operational hardening phase. The following remain separate slices:

- Slice 1B: Supabase Auth Site URL, redirect allowlist, signup posture and Auth rate-limit verification.
- Slice 1C: durable public QR and privileged security mutation abuse controls.
- Slice 1D: audit/log retention, access and redaction policy.
- Slice 1E: final Security Advisor classification and Phase 1 evidence closure.
