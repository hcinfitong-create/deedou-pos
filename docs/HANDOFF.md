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

## Current working task

**DD-011B — Issue #47 / PR #48**

- PR: `#48 DD-011B: single Owner and backend-managed device activation`
- Branch: `agent/dd011b-owner-device-hardening`
- Pre-documentation implementation head finalized for docs: `1b0d4931693891ee343c037399d250beb9e146b7`
- PR state at DD-011B docs finalization: open, Draft, mergeable. Implementation and exact-head Vercel Preview hosted acceptance are complete; move to Ready only after this docs-only commit has fresh exact-head checks and Production rollout prerequisites are verified.
- PR #46/DD-012C remains a separate open Draft.

Always fetch the latest head before continuing; documentation commits and later fixes may advance this SHA.

## Completed work on DD-011B

Repository implementation already includes the DD-011B schema/security direction:

- `staff_profiles.username` and provisioning status.
- case-insensitive username uniqueness.
- single-active-OWNER database guard.
- `workstation_device_secrets` backend secret storage.
- `workstation_device_sessions` hashed backend session tokens.
- `staff_activation_requests` for FIRST_LOGIN/NEW_DEVICE challenges.
- same-origin backend security endpoints.
- Owner bootstrap/device/session flow.
- Owner security Admin UI.
- browser-side device-session transport that removes legacy workstation secret usage from production browser storage.

Recent Part 5 fixes added a browser-smoke compatibility adapter so old DD-008 regression suites can exercise the new backend device-session model without restoring browser-readable secrets. DD-011B now also has its own PR #48 Vercel Preview hosted security acceptance job inside the existing DD-011 hosted workflow, leaving the PR #38 job intact. The staging bootstrap Edge Function source is versioned at `supabase/functions/dd008-hosted-smoke-bootstrap/index.ts`.

Hosted acceptance fixes now resolved on pre-documentation head `1b0d4931693891ee343c037399d250beb9e146b7`:

- Username pattern failure: resolved; Chromium accepts the intended username pattern without invalid regex syntax.
- Hosted async 403 classification failure: resolved; only phase/path/method/reason-proven expected 403s are tolerated, while unrelated console/page/network errors remain fatal.

## Last confirmed debugging evidence

### Symptom before Part 5 fix

`browser-smoke` and `dd008d-browser-smoke` failed after DD-011B while DB/Auth/security contracts were otherwise passing.

### Root cause confirmed

Old smoke fixtures injected `deedou_device_credential` into `localStorage` and ran a static server. DD-011B intentionally removes that secret from JS-readable storage and proxies staff RPCs through same-origin backend `/api/staff-rpc` using backend-managed device sessions. Therefore the old fixture model no longer matched production security architecture.

### Fix direction

- Do **not** restore workstation/device secret to browser storage.
- Keep production 401/403 authorization semantics.
- Adapt smoke fixture infrastructure to create/use backend device sessions.
- Reuse the actual requested route permission; do not maintain a duplicate permission map in the test adapter.
- Ignore only a browser console signal proven to be an intentional denial in a negative authorization test; all unexpected console/page/network errors still fail.

## Validation status rule

Do not say DD-011B is complete merely because a previous run was green.

At the DD-011B hosted acceptance update, exact-head status must include:

- DeeDou CI syntax/unit/backend/Auth/browser gates;
- DD-011 security contract;
- DD-011B Vercel Preview hosted security acceptance;
- hosted fixture cleanup with run-scoped staff/device/session/location data returning to baseline.

Confirmed evidence on pre-documentation head `1b0d4931693891ee343c037399d250beb9e146b7`:

- DeeDou CI `32659206957`: PASS.
- DD-011 Security Hardening Contract `32659206967`: PASS.
- DD-010A Table Authority Contract `32659206939`: PASS.
- DD-012 Catalog Contract `32659206898`: PASS.
- DD-011 Vercel Preview Hosted Security Smoke `32659206888`, job `97242678394`: PASS.
- Hosted cleanup baseline: `DD011B_PREVIEW_CLEANUP_BASELINE=PASS`.
- Hosted completion marker: `DD-011B Vercel Preview hosted security acceptance passed.`

Any documentation commit changes the head and may trigger a new CI run. Fetch current checks before reporting status.

## Protected behavior — do not regress

- PostgreSQL authority in hosted Supabase mode.
- direct-write/RLS/ACL denial.
- public QR unauthenticated flow.
- existing DD-008 operational command contracts.
- table-session authority from DD-004/DD-010A.
- KDS `prepStatus` workflow and FOH serving separation.
- append-only payment ledger and bounded refund semantics.
- DD-012 immutable historical configured-order snapshots.
- OWNER AAL2 and sole-Owner protection.
- no JS-readable device secret.

## Parallel PR interaction

PR #46 is DD-012C combo/components. It must stay business-logically independent from DD-011B.

Expected integration hotspots if both remain open:

- `index.html`;
- `package.json`;
- possibly Admin composition if both add UI wiring.

Resolve these after one branch advances/merges; do not copy unrelated modules between PRs.

## Next concrete action

1. Fetch PR #48 latest head after the docs-only finalization commit.
2. Inspect fresh exact-head GitHub and Vercel checks; do not reuse the `1b0d493` conclusions for the new docs SHA.
3. Verify Production Vercel server-only service-role environment for the production Supabase project before claiming production rollout readiness.
4. If all post-doc checks and production prerequisites are green, move PR #48 from Draft to Ready and perform final merge-readiness review.
5. If any post-doc check fails, report the exact failing boundary and do not make production/security changes as part of the docs-only finalization.

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
