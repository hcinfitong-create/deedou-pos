# DeeDou Project State

> Dynamic source-of-truth summary. Update this file whenever a major PR/phase changes state.
>
> Last source review: 2026-08-24. Current `main` reviewed at `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675` after DD-011B production hotfix PR #49.

## Source-of-truth order

When information conflicts, use this order:

1. Current source code.
2. Current database schema and forward migrations.
3. GitHub branch / commit / PR / CI state.
4. Repository documentation.
5. Confirmed product/business decisions in `docs/DECISIONS.md`.
6. Conversation history.
7. Memory or inference.

Never infer current implementation state from this file alone. Re-check the repository before coding.

## Product / repository scope

This repository is the DeeDou POS + QR Ordering web application. It currently contains:

- Customer QR ordering.
- Cashier POS.
- Floor Staff operations.
- Kitchen / Bar / Dessert KDS.
- Table-session and floor/table authority.
- Payment ledger and refunds.
- Admin catalog/table/security surfaces.
- Supabase/PostgreSQL authoritative backend integration.

The wider DeeDou project may also contain Brand/Store, Marketing Agent, Accounting Agent and local AI infrastructure. Those systems are outside this repository unless an explicit integration is added here.

## Architecture state

Current runtime remains a framework-free JavaScript web app with hash routes. Do not rewrite it into React/Next/etc. without an explicit architecture decision.

Primary business-module ownership:

- `customer-menu` — customer menu/filtering/presentation.
- `product-options` — variants/modifiers/configured pricing snapshots.
- `course-workflow` — course assignment and HELD/FIRED release.
- `ordering` — order contracts, service context, status/line rules.
- `cart` — cart identity/quantity/totals.
- `customer-orders` — customer order presentation.
- `service-requests` — CALL_STAFF/BILL_REQUEST state.
- `staff-orders` — FOH staff selectors/actions/presentation.
- `station-workflow` — KDS ticket/prep workflow.
- `table-session` — physical visit/session rules.
- `payments` — append-only ledger, payment/refund/void rules.
- `shared/backend` — Supabase query/command/realtime transport boundary.
- `shared/auth` — browser auth/session/route-gate boundary.

See `docs/ARCHITECTURE.md` and `docs/MODULE_MAP.md` before changing module ownership.

## Completed development baseline

Merged/production-complete work confirmed from GitHub/source/hosted state:

- DD-002 / DD-002.1 — staff-order state and hybrid cafe/restaurant service context.
- DD-003 — station workflow + item-level serving.
- DD-004 — table-session floor operations.
- DD-005 — product options/configured pricing.
- DD-006 — course Hold/Fire workflow.
- DD-007 — append-only payment ledger.
- DD-008A — Supabase/PostgreSQL backend foundation.
- DD-008B — Auth/RBAC + hosted ACL hardening.
- DD-008C — authoritative commands + realtime refresh hints.
- DD-008D / DD-008P — production cutover/resilience + hosted production acceptance.
- DD-010A — authoritative Admin tables/floor layout/QR management.
- DD-011 — production identity/device security hardening + AAL2.
- DD-011B — sole Owner, username staff identity, Owner-approved activation and backend-managed device sessions.
- DD-012 Slice A — authoritative product-core Admin catalog.
- DD-012 Slice B — authoritative variants/modifiers and assignments.

## DD-011B final production state

Issue: #47
Implementation PR: #48 `DD-011B: single Owner and backend-managed device activation`
Production hotfix PR: #49 `Hotfix DD-011B: allow Owner AAL2 re-challenge with active device`

Current status: **production-complete**.

Merged commits:

- PR #48 merged to `main` as `834049bb89a08968e5f69d77f9bb3718ba908d5b`.
- PR #49 merged to `main` as `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675`.

Implemented/accepted security behavior:

- exactly one active OWNER globally;
- OWNER privileged security paths require Supabase MFA/AAL2;
- staff identity uses `display_name` plus case-insensitive unique `username`;
- Owner creates pending staff and approves first-login/new-device six-digit activation challenges;
- trusted workstation proof is a backend-managed session using Secure/HttpOnly/SameSite cookie transport;
- browser JS-readable storage is not an authority for workstation/device secret material;
- individual device revoke and staff/location/role disable invalidate protected access immediately;
- sole OWNER protection blocks normal flows from removing/deactivating the only OWNER;
- public QR remains outside the staff security gateway.

Production rollout completed on Supabase project `nwohsyzpmogqjbmknwbl`:

- DD-011B forward migrations were applied in order: identity/device schema, staff activation authority, cutover compatibility, and sole-Owner role-revoke guard;
- production Vercel server-only Supabase service credential is configured separately from Preview/staging;
- OWNER TOTP factor is verified;
- OWNER backend-managed ADMIN device/session is active;
- `dd011b_security_policy.backend_device_sessions_required = true`;
- legacy ADMIN device was revoked through the application security workflow rather than hard-deleted;
- post-cutover Owner Admin access was verified after hard refresh with a backend session used after enforcement was enabled.

Post-rollout incident and hotfix:

- after the browser Supabase Auth session returned to AAL1, the existing active-device UI rendered the continue state before the Owner MFA challenge, which left OWNER unable to elevate back to AAL2 from the route gate;
- PR #49 moved the Owner AAL2 re-challenge guard ahead of the active-device continue state;
- no RBAC/RLS/device-session contract was weakened;
- after Production deployment of PR #49, OWNER successfully re-verified TOTP and re-entered Admin;
- direct Production verification confirmed the latest OWNER Auth session at `aal2`, the current ADMIN device/session active, the legacy device revoked, and backend-device-session enforcement still enabled.

Validation evidence for PR #49 exact head `039246cd56f5478ceb4b188b20845abe70b052ef` before merge:

- DeeDou CI `32662677868`: PASS, including 275/275 unit tests, browser smoke, DD-008D multi-context browser smoke, Auth+AAL2 integration, database contracts and authoritative command/realtime integration.
- DD-010A Table Authority Contract `32662677890`: PASS.
- DD-011 Security Hardening Contract `32662677908`: PASS.
- DD-012 Catalog Contract `32662677907`: PASS.
- Vercel Preview: success.
- Production Vercel deployment for merge commit `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675`: success.

Issue #47 is still open in GitHub as tracking metadata at this source review. The implementation/production acceptance described above is complete; close the issue separately after this documentation sync if no additional acceptance item is intentionally being kept open.

## Current open work

### PR #46 — DD-012C combo/components

Branch: `agent/dd012c-combo-components`
Issue parent: #41
Status: **Draft / open / currently not mergeable against latest `main`**.

Current integration state reviewed after DD-011B/hotfix merges:

- PR head: `307e1868cac3cc1f1c593353ff3c51fa0878ce32`.
- Branch is diverged from `main`: 15 commits ahead and 73 commits behind.
- GitHub reports `mergeable=false` at this review.
- The branch must be rebased/updated onto latest `main` before further acceptance or merge-readiness claims.

Scope remains:

- authoritative CRUD for existing `product_components` model;
- Admin component editor;
- no parallel combo model;
- preserve immutable submitted-order snapshots;
- import/duplicate helper only if real provisioning proves it useful.

After rebase/conflict resolution, rerun exact-head fresh-DB CI and the DD-012C staging hosted Admin + public QR/order acceptance/cleanup gate before production migration.

## Current production authority

- PostgreSQL is business authority for hosted Supabase mode.
- Browser direct writes to protected business/catalog/security tables are denied.
- Transactional RPCs are the authoritative mutation boundary.
- Realtime events are refresh hints, not state authority; clients refetch authoritative snapshots.
- LOCAL_DEMO remains a separate demo/runtime path. No authoritative dual-write between localStorage and PostgreSQL.
- Historical submitted order-line pricing/options are immutable snapshots.
- Staff protected requests require the DD-011B backend-managed device-session model when enforcement is enabled.
- OWNER must be AAL2 for accepted privileged security paths; an AAL1 Owner with an active device must be offered a TOTP re-challenge rather than silently denied behind the active-device continue state.

## Known coupling / technical debt

- `app.js` still owns broad route composition, DOM/event wiring and orchestration.
- Some Admin surfaces remain integrated in the app shell.
- Hosted/security smoke suites include DD-011B backend device-session trust. Future harness changes must preserve the no-JS-readable-device-secret rule and public QR bypass of staff security.
- Long-lived privileged sessions can return to AAL1 according to Supabase Auth/session lifecycle; UI must preserve the Owner re-challenge path added by PR #49.
- Repository docs written before DD-008D/DD-010/DD-011/DD-012 may contain historical wording. Current source/migrations override stale documentation.

## Next action

1. Merge this docs-only final-state sync after confirming its diff contains documentation only.
2. Optionally close Issue #47 as completed once the documentation state is merged and no further DD-011B acceptance work is intended.
3. Rebase/update PR #46 (`agent/dd012c-combo-components`) onto latest `main`.
4. Resolve only real integration conflicts introduced by DD-011B/hotfix work; do not copy unrelated business logic between slices.
5. Rerun PR #46 exact-head CI/fresh-DB contracts, then staging DD-012C hosted acceptance and fixture cleanup.
6. Continue real menu provisioning only from user-supplied menu data after Slice C is accepted; do not invent production catalog data.

## Required maintenance

When finishing a major phase, update at least:

- this file (`PROJECT_STATE.md`);
- `HANDOFF.md`;
- `ROADMAP.md` if milestone state changed;
- `DECISIONS.md` if a new decision was explicitly accepted;
- `DATABASE.md` / `API_CONTRACTS.md` when schema/contracts change.
