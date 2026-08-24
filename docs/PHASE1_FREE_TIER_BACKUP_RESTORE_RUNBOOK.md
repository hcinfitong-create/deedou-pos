# Phase 1A Free-tier Backup and Restore Runbook

This runbook owns the interim DeeDou logical backup and restore-drill posture while the accepted infrastructure decision keeps Supabase on the Free plan during build/testing.

It does not replace the DD-008D cutover runbook. DD-008D remains the authority for production cutover and rollback policy. This document is only the Phase 1A backup/restore operating procedure tracked by Issue #40.

## Scope

Phase 1A establishes a reproducible backup artifact and a disposable restore drill.

In scope:

- Supabase-supported logical export of roles, schema and data.
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

## Backup format

The workflow creates three Supabase logical dumps:

```bash
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --role-only -f roles.sql
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" -f schema.sql
supabase db dump --db-url "$DEEDOU_PRODUCTION_DB_URL" --data-only --use-copy -f data.sql
```

The committed helper `scripts/phase1a-backup-bundle.mjs` then builds one encrypted `.ddbak.enc` bundle containing:

- `roles.sql`;
- `schema.sql`;
- `data.sql`;
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
2. restore `roles.sql`;
3. reset only the disposable target's `public` schema;
4. restore `schema.sql`;
5. restore `data.sql`;
6. verify representative schema objects, DD-011B/DD-012C functions and row counts;
7. write a non-sensitive restore summary with elapsed restore seconds;
8. remove decrypted SQL.

The restore step uses `psql -v ON_ERROR_STOP=1` so SQL errors stop the workflow.

Representative object checks include the staff/device authority tables, catalog/component tables and the critical DD-011B/DD-012C functions:

- `authorize_staff_access`;
- `dd011b_service_create_pending_staff`;
- `dd011b_service_approve_activation`;
- `revoke_workstation_device`;
- `dd012_create_product_component`;
- `dd012_update_product_component`;
- `dd012_delete_product_component`.

Representative row-count checks compare counts captured before backup against the restored disposable target for:

- locations;
- physical tables;
- products;
- product components;
- orders;
- staff profiles;
- workstation devices;
- backend device sessions.

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

The workflow fails closed if either required secret is absent. Do not run the real Production backup workflow until the PR/source has been reviewed and the GitHub secrets are configured through the GitHub UI.

## Operator review checklist

Before enabling the daily schedule on `main`:

- confirm both required GitHub secrets are configured;
- confirm artifact retention is acceptable for encrypted backup bundles;
- confirm the encryption passphrase is stored outside GitHub in an operator-controlled secret manager;
- run one manual workflow dispatch and verify the restore drill summary;
- record the measured restore duration after the first successful safe drill;
- verify no plaintext SQL artifact was uploaded.

## Open Phase 1 gates

Phase 1A does not complete the whole Production operational hardening phase. The following remain separate slices:

- Slice 1B: Supabase Auth Site URL, redirect allowlist, signup posture and Auth rate-limit verification.
- Slice 1C: durable public QR and privileged security mutation abuse controls.
- Slice 1D: audit/log retention, access and redaction policy.
- Slice 1E: final Security Advisor classification and Phase 1 evidence closure.
