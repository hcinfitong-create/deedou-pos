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

## Current repository state

Current `main` source review: `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675`.

DD-011B is no longer an open implementation task. It is merged, deployed and production-verified.

Completed merge sequence:

- PR #48 — `DD-011B: single Owner and backend-managed device activation`
  - merged as `834049bb89a08968e5f69d77f9bb3718ba908d5b`;
- PR #49 — `Hotfix DD-011B: allow Owner AAL2 re-challenge with active device`
  - merged as `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675`.

Issue #47 is still open as tracking metadata at this handoff, but its implementation and production acceptance are complete. Close it separately after the final docs sync if no intentional follow-up acceptance item remains.

## DD-011B production-complete behavior

The current implementation and Production rollout provide:

- exactly one active OWNER globally;
- Owner TOTP MFA/AAL2 for accepted privileged security paths;
- staff `display_name` plus case-insensitive unique `username`;
- Owner-created pending staff accounts;
- six-digit first-login/new-device activation challenge with explicit Owner approval;
- backend-managed trusted device sessions;
- Secure/HttpOnly/SameSite cookie transport for device-session proof;
- no workstation/device secret authority in frontend JS-readable storage;
- immediate device revoke and staff/location/role disable semantics;
- sole-Owner protection against normal application deactivation/revoke flows;
- public QR remains outside staff security gating.

Production Supabase project: `nwohsyzpmogqjbmknwbl`.

Production rollout completed:

- DD-011B forward migrations applied in order;
- Production Vercel server-only Supabase service credential configured separately from Preview/staging;
- Owner TOTP factor verified;
- backend-managed Owner ADMIN device/session established;
- `dd011b_security_policy.backend_device_sessions_required = true`;
- legacy ADMIN device revoked through the security UI/workflow and retained only as historical revoked state;
- post-cutover Admin access verified with the current backend session after enforcement was enabled.

## Production incident resolved by PR #49

### Symptom

After DD-011B cutover and legacy-device cleanup, Owner reached the auth gate with a message equivalent to insufficient access even though the backend-managed device/session remained active.

### Evidence

Production checks showed:

- Owner staff profile/role/location/permissions remained valid;
- current backend-managed Owner device/session remained active and continued receiving usage;
- `backend_device_sessions_required` remained enabled;
- latest Owner Supabase Auth session had fallen back to AAL1 while privileged Owner authorization requires AAL2.

### Root cause

`security-bootstrap-ui.js` rendered the active-device "continue" state before the Owner AAL2 re-challenge state. Therefore an Owner with a valid active device but an AAL1 Auth session had no UI path to enter TOTP and elevate back to AAL2.

### Fix

PR #49 moved the Owner AAL2 re-challenge guard ahead of the active-device continue state. It did not weaken RBAC, RLS, AAL2, backend-session enforcement or device revoke semantics.

Post-deploy verification confirmed:

- Owner successfully completed TOTP challenge and re-entered Admin;
- latest Owner Auth session is AAL2;
- current Owner ADMIN device remains active;
- backend device session remains active and unrevoked;
- legacy ADMIN device remains revoked;
- `backend_device_sessions_required = true` remains enforced.

## Validation evidence

PR #49 exact head before merge: `039246cd56f5478ceb4b188b20845abe70b052ef`.

Confirmed passing checks:

- DeeDou CI run `32662677868` — PASS.
  - syntax/check gate PASS;
  - 275/275 unit tests PASS;
  - browser smoke PASS;
  - DD-008D multi-context browser smoke PASS;
  - Auth + TOTP AAL2 integration PASS;
  - backend DB contracts PASS;
  - DD-008C authoritative command/realtime integration PASS.
- DD-010A Table Authority Contract `32662677890` — PASS.
- DD-011 Security Hardening Contract `32662677908` — PASS.
- DD-012 Catalog Contract `32662677907` — PASS.
- Vercel Preview — success.
- Production Vercel deployment for `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675` — success.

## Protected behavior — do not regress

- PostgreSQL authority in hosted Supabase mode.
- direct-write/RLS/ACL denial.
- public QR unauthenticated flow.
- existing DD-008 operational command contracts.
- table-session authority from DD-004/DD-010A.
- KDS `prepStatus` workflow and FOH serving separation.
- append-only payment ledger and bounded refund semantics.
- DD-012 immutable historical configured-order snapshots.
- sole OWNER and Owner AAL2 requirements.
- no JS-readable device secret.
- backend-device-session enforcement remains authoritative after cutover.
- an Owner whose Auth session is AAL1 must receive a TOTP re-challenge even when the workstation device/session is already active.

## Current working engineering task after docs sync

**DD-012C — PR #46 `authoritative combo component management`**

Branch: `agent/dd012c-combo-components`
Head at this handoff: `307e1868cac3cc1f1c593353ff3c51fa0878ce32`
State: open, Draft, currently `mergeable=false` against latest `main`.

Current compare against `main` after DD-011B/hotfix merges:

- ahead by 15 commits;
- behind by 73 commits;
- merge base remains the older `f431e9e49d32e93cb6b460ea6efe80a79ac21a5c` baseline.

Do **not** continue implementation from the stale branch as though it were current. First rebase/update it onto latest `main`, inspect the actual conflicts, and resolve only integration conflicts.

DD-012C scope remains:

- authoritative CRUD for existing `product_components`;
- existing Admin catalog component editor;
- no parallel combo model;
- preserve immutable submitted-order snapshots;
- no invented production menu data;
- import/duplicate helper only if real operator provisioning later proves it useful.

Likely integration hotspots include `index.html`, `package.json`, shared backend composition and Admin wiring. Do not pull DD-011B security logic into DD-012C beyond what latest `main` already requires.

## Next concrete action

1. Finish/merge the docs-only DD-011B final-state sync.
2. Optionally close Issue #47 as completed after docs merge.
3. Rebase/update PR #46 onto latest `main`.
4. Inspect conflict resolution against current DD-011B/hotfix source rather than copying old branch assumptions.
5. Run fresh exact-head CI/database/Auth/browser contracts after rebase.
6. Run DD-012C staging hosted Admin + public QR/order acceptance and cleanup.
7. Only after staging success consider Production migration for DD-012C.
8. Provision real DeeDou menu data only from user-supplied source data after Slice C acceptance.

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
