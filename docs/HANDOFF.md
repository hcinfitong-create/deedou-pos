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

Current `main` source review: `b282a0cd859b122fc6df4d065e5b9c496a5af537`.

DD-011B and DD-012C are both merged, deployed and Production-verified.

Recent completion sequence:

- PR #48 — `DD-011B: single Owner and backend-managed device activation`
  - merged as `834049bb89a08968e5f69d77f9bb3718ba908d5b`;
- PR #49 — `Hotfix DD-011B: allow Owner AAL2 re-challenge with active device`
  - merged as `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675`;
- PR #46 — `DD-012C: authoritative combo component management`
  - accepted head `27fa5c8219ad066bf21e3e02a33b1e803768535f`;
  - merged as `b282a0cd859b122fc6df4d065e5b9c496a5af537`.

Issue #47 remains open as tracking metadata; its DD-011B implementation and Production acceptance are complete. Do not close it unless a fresh check confirms no follow-up acceptance item is intentionally retained.

## DD-011B protected production behavior

Current implementation and Production rollout provide:

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
- public QR remains outside staff security gating;
- an Owner whose Auth session returns to AAL1 is offered the TOTP re-challenge path even when the workstation device/session is already active.

Production Supabase project: `nwohsyzpmogqjbmknwbl`.

Current Production security baseline verified after DD-012C rollout:

- one active OWNER assignment;
- one active ADMIN workstation device;
- one active backend workstation-device session;
- `dd011b_security_policy.backend_device_sessions_required = true`.

## DD-012C production-complete behavior

Parent issue: #41
PR: #46 `DD-012C: authoritative combo component management`
Status: **production-complete**.

Implemented contracts:

- reuse canonical `product_components`; no parallel combo model;
- `product_components.updated_at` optimistic concurrency;
- Admin menu snapshot includes components;
- authoritative component create/update/delete RPCs;
- DD-011B HttpOnly backend device-session authority works with component mutations;
- no browser-readable workstation credential is required or accepted as authority;
- direct protected-table writes remain denied;
- component mutations preserve `menu.manage`, registered workstation authority, idempotency, audit and realtime refresh hints;
- combo order submission expands parent products into non-billable routed component lines;
- historical submitted order-line component/configuration snapshots remain immutable after later catalog edits;
- Admin component UI cache is invalidated across auth/location/workstation context changes;
- failed component-menu loads stop automatic retry loops and require an explicit retry/refresh.

Hosted staging acceptance passed at exact head:

- Owner password login + TOTP/AAL2;
- backend HttpOnly ADMIN device session;
- Admin catalog mount;
- product-create prerequisite;
- direct component-table write denial;
- component Create / Update / Delete;
- public component projection;
- initial / updated / post-delete QR order behavior;
- final staging cleanup to zero.

Final DD-012C hosted acceptance: run `32673729910`, job `97278777585` — PASS.

Production rollout evidence:

- Vercel Production deployment for merge commit `b282a0cd859b122fc6df4d065e5b9c496a5af537`: success;
- Production migration `dd012c_combo_components` applied as migration history version `20260823235316`;
- `product_components.updated_at` present;
- `dd012_create_product_component`, `dd012_update_product_component`, `dd012_delete_product_component` present;
- anon EXECUTE denied on DD-012C mutation RPCs;
- unauthenticated Admin menu snapshot remains fail-closed with `FORBIDDEN / SIGN_IN_REQUIRED`;
- real Production baseline preserved: one location, one staff profile, zero products, zero components, zero orders;
- no Production menu/combo fixture data was invented or left behind.

## Protected behavior — do not regress

- PostgreSQL authority in hosted Supabase mode.
- direct-write/RLS/ACL denial.
- public QR unauthenticated flow.
- existing DD-008 operational command contracts.
- table-session authority from DD-004/DD-010A.
- KDS `prepStatus` workflow and FOH serving separation.
- append-only payment ledger and bounded refund semantics.
- immutable historical configured-order/component snapshots.
- sole OWNER and Owner AAL2 requirements.
- no JS-readable device secret.
- backend-device-session enforcement remains authoritative after cutover.
- DD-012C must keep `product_components` as the canonical component model rather than creating a second combo graph.

## Current working state

There is no open DD-012C implementation/rollout blocker at this handoff.

Do not resume from the old PR #46 branch as active work; PR #46 is merged and its Production migration is complete.

Real DeeDou menu provisioning is not yet represented by Production product/component rows. Any real product/menu provisioning must use user-supplied source data; do not invent catalog data.

UI/UX redesign may reuse the current backend/API contracts without changing them unless a verified UI requirement exposes a genuine backend capability gap. Keep UI-only work separate from backend/schema changes.

## Next concrete action

1. Merge the docs-only DD-012C final-state sync after confirming it changes documentation only.
2. Choose/scope the next DeeDou issue/PR from the current roadmap rather than extending merged PR #46.
3. If the next task is real menu provisioning, require user-supplied menu/product/component data and use the existing Admin/API authority.
4. If the next task is UI/UX redesign, first audit current screens and map proposed interactions to existing backend capabilities before requesting backend changes.
5. Optionally close Issue #47 only after confirming no intentional DD-011B tracking item remains.

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
