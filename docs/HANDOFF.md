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
- Pre-documentation code baseline inspected: `10a6b53b67768a0912410a46267008d4688de7a6`
- PR state at latest DD-011B hosted acceptance update: open, Draft, mergeable; move to Ready only after the exact-head hosted acceptance and final CI are green.
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

Recent Part 5 fixes added a browser-smoke compatibility adapter so old DD-008 regression suites can exercise the new backend device-session model without restoring browser-readable secrets. DD-011B now also has its own Vercel Preview hosted security acceptance workflow for PR #48.

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

1. Fetch PR #48 latest head.
2. Inspect all current CI checks and logs.
3. If browser or hosted smoke fails, trace exact request/authorization/UI/cleanup state before patching.
4. Keep fixes surgical and security-preserving.
5. Use `.github/workflows/dd011b-preview-hosted-smoke.yml` / `scripts/dd011b-preview-hosted-smoke.mjs` for Issue #47 staging hosted acceptance and cleanup.
6. When exact-head CI and hosted acceptance are green, move PR #48 from Draft to Ready for Review.

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
