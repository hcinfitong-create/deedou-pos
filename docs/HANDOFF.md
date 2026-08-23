# DeeDou Handoff

> Dynamic session-to-session handoff. Read this at the start of every new DeeDou coding conversation, then verify it against current GitHub/source state.

## How to resume safely

Before implementing anything:

1. Read `docs/PROJECT_STATE.md`.
2. Read `docs/CODING_RULES.md`.
3. Read `docs/DECISIONS.md`.
4. Read `docs/ARCHITECTURE.md` and `docs/MODULE_MAP.md` for affected modules.
5. Inspect the current branch/PR/commit and CI.
6. Read current implementation + relevant tests/migrations.
7. Compare repository state with this handoff.
8. Only then code/debug.

## Current state

**DD-011B / PR #48 is complete in production.**

- PR #48 merged to `main` as `834049bb89a08968e5f69d77f9bb3718ba908d5b`.
- Production DD-011B migrations are applied.
- Owner TOTP MFA is verified.
- Owner backend-managed ADMIN device/session is active.
- `backend_device_sessions_required = true` in production.
- Owner Admin access was verified after enforcement was enabled.
- Legacy ADMIN device was revoked through the Owner security UI and has no active backend session.
- Current Owner ADMIN device/session remains active after cleanup.
- Sanitized rollout/cutover/cleanup evidence was recorded on PR #48.

Do not reopen DD-011B implementation unless new production evidence proves a regression.

## Current working task

**DD-012C — PR #46 (`agent/dd012c-combo-components`)**

PR #46 is still open and Draft, but its current branch predates the DD-011B merge.

Verified integration state on 2026-08-24:

- head: `307e1868cac3cc1f1c593353ff3c51fa0878ce32`;
- status against current `main`: `diverged`;
- ahead of `main`: 15 commits;
- behind `main`: 70 commits;
- GitHub reports `mergeable=false` in the current state.

Therefore the next coding action is **rebase/integration first**, not new DD-012C implementation from the stale branch state.

## DD-011B completed work and protected behavior

Production implementation now includes:

- `staff_profiles.username` + provisioning status;
- case-insensitive username uniqueness;
- exactly one active OWNER guard;
- Owner AAL2/TOTP requirement for privileged security paths;
- Owner-created pending staff accounts;
- first-login/new-device verification challenge + explicit Owner approval;
- backend-only workstation device secrets;
- hashed backend device sessions;
- same-origin security endpoints;
- Secure HttpOnly browser device-session proof;
- immediate revoke/disable semantics;
- public QR outside the staff security gateway.

Production cutover sequence completed successfully:

1. Production Vercel server-only service-role secret configured for the production Supabase project.
2. Owner TOTP enrolled and verified before DB cutover.
3. Four forward DD-011B migrations applied to production.
4. Owner backend-managed ADMIN workstation bootstrapped.
5. Backend-session enforcement enabled only after the Owner session existed.
6. Owner Admin hard-refresh succeeded after enforcement; DB `last_seen_at` advanced after enforcement timestamp.
7. Legacy ADMIN device revoked through the security workflow.
8. Current Owner device/session remained active and continued receiving backend traffic after cleanup.

Do not regress these boundaries:

- no JS-readable device secret as production authority;
- no service-role/private secret in browser code;
- no direct browser writes to protected security/business tables;
- sole Owner cannot be removed/deactivated through normal role/staff mutation paths;
- revoked device/staff access must fail on the next protected request;
- public QR remains unauthenticated and exact-token scoped.

## DD-011B validation evidence

Pre-merge exact-head PR validation included:

- DeeDou CI: PASS;
- DD-011 Security Hardening Contract: PASS;
- DD-010A Table Authority Contract: PASS;
- DD-012 Catalog Contract: PASS;
- DD-011 Vercel Preview Hosted Security Smoke: PASS;
- hosted cleanup baseline: PASS;
- Vercel Preview: Ready/success.

Production verification included live Owner MFA/bootstrap/cutover plus direct production DB invariant checks. The historical `DD-011 Production Hosted Security Smoke` workflow remains hard-scoped to PR #39 and was not modified or bypassed simply to create a new green run for PR #48.

## DD-012C scope to preserve during rebase

PR #46 scope:

- authoritative CRUD for the existing `product_components` model;
- optimistic `updated_at` handling;
- authoritative Admin menu snapshot integration;
- DD-012C component RPCs + SQL/JS contracts;
- Admin component editor on the existing Admin route;
- no parallel combo model;
- submitted order-line snapshots remain immutable when component catalog rows change;
- no import/duplicate helper unless real provisioning proves it useful;
- no invented production menu data.

Expected rebase/integration hotspots:

- `index.html`;
- `package.json`;
- shared backend exports;
- Admin composition/security integration.

Do not copy DD-011B business logic into DD-012C. Resolve conflicts by reading the current `main` implementation and preserving both modules' accepted boundaries.

## Next concrete action

1. Fetch latest `main` and PR #46 head immediately before work.
2. Rebase `agent/dd012c-combo-components` onto current `main`.
3. Resolve only actual integration conflicts.
4. Re-read every conflicted file after resolution; confirm DD-011B security transport remains intact.
5. Run fresh exact-head DD-012C local/fresh-DB validation.
6. If green, run staging hosted Admin + public QR/order acceptance and cleanup all DD-012C fixtures.
7. Only after staging acceptance should DD-012C production migration/readiness be evaluated.

## Handoff template for future sessions

When ending a substantial session, refresh these fields:

- **Current state:**
- **Completed work:**
- **Current branch / PR / head:**
- **Files changed:**
- **Decisions made:**
- **Known issues:**
- **Tests performed:**
- **CI / hosted acceptance:**
- **Pending work:**
- **Next action:**
