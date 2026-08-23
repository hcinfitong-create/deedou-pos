# DeeDou Project State

> Dynamic source-of-truth summary. Update this file whenever a major PR/phase changes state.
>
> Last source review: 2026-08-24. Current `main` reviewed at `b282a0cd859b122fc6df4d065e5b9c496a5af537` after DD-012C PR #46 merged and Production schema rollout completed.

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
- DD-012 Slice C — authoritative combo/component management using existing `product_components`.

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

Issue #47 remains open as tracking metadata at this source review. The implementation/production acceptance described above is complete; close the issue separately only if no intentional follow-up acceptance item remains.

## DD-012C final production state

Parent issue: #41
Implementation PR: #46 `DD-012C: authoritative combo component management`
Current status: **production-complete**.

Merge/deploy evidence:

- exact accepted PR head: `27fa5c8219ad066bf21e3e02a33b1e803768535f`;
- PR #46 merged to `main` as `b282a0cd859b122fc6df4d065e5b9c496a5af537`;
- Vercel Production deployment for that merge commit succeeded;
- Production migration `dd012c_combo_components` was applied on Supabase project `nwohsyzpmogqjbmknwbl` as migration history version `20260823235316`.

Implemented behavior:

- `product_components` remains the single canonical combo/component model; no parallel combo model was introduced;
- `product_components.updated_at` supports optimistic concurrency;
- authoritative Admin menu snapshots now include component rows;
- authoritative mutation RPCs exist for component create/update/delete;
- DD-011B backend-managed device-session authority is preserved; the browser does not need a JS-readable device credential;
- direct browser writes remain denied;
- component mutations retain idempotency, audit and realtime refresh-hint behavior;
- order submission expands combo parents into non-billable routed component lines;
- submitted order-line component/configured snapshots remain immutable when catalog components later change;
- Admin component UI state is invalidated across auth/location/workstation context changes and failed loads do not auto-retry indefinitely.

Staging acceptance at exact head passed the complete hosted flow:

- Owner password login → TOTP/AAL2;
- backend HttpOnly device-session bootstrap;
- Admin catalog mount;
- product create prerequisite;
- direct protected component-table write denial;
- component create/update/delete;
- public component projection;
- initial/updated/post-delete QR/order behavior;
- complete fixture cleanup.

Final hosted acceptance run: `32673729910`, job `97278777585` — PASS.

Post-rollout Production verification confirmed:

- migration present;
- `product_components.updated_at` present;
- `dd012_create_product_component`, `dd012_update_product_component`, `dd012_delete_product_component` present;
- anon execute on those mutation RPCs denied;
- unauthenticated Admin menu snapshot fails closed with `FORBIDDEN / SIGN_IN_REQUIRED`;
- production real baseline preserved: one location, one staff profile, zero products/components/orders;
- DD-011B baseline preserved: one active OWNER assignment, one active ADMIN workstation device, one active backend device session, `backend_device_sessions_required = true`.

No Production menu/combo fixture data was invented or left behind.

## Current production authority

- PostgreSQL is business authority for hosted Supabase mode.
- Browser direct writes to protected business/catalog/security tables are denied.
- Transactional RPCs are the authoritative mutation boundary.
- Realtime events are refresh hints, not state authority; clients refetch authoritative snapshots.
- LOCAL_DEMO remains a separate demo/runtime path. No authoritative dual-write between localStorage and PostgreSQL.
- Historical submitted order-line pricing/options/components are immutable snapshots.
- Staff protected requests require the DD-011B backend-managed device-session model when enforcement is enabled.
- OWNER must be AAL2 for accepted privileged security paths; an AAL1 Owner with an active device must be offered a TOTP re-challenge rather than silently denied behind the active-device continue state.

## Known coupling / technical debt

- `app.js` still owns broad route composition, DOM/event wiring and orchestration.
- Some Admin surfaces remain integrated in the app shell.
- Hosted/security smoke suites include DD-011B backend device-session trust. Future harness changes must preserve the no-JS-readable-device-secret rule and public QR bypass of staff security.
- Long-lived privileged sessions can return to AAL1 according to Supabase Auth/session lifecycle; UI must preserve the Owner re-challenge path added by PR #49.
- Repository docs written before DD-008D/DD-010/DD-011/DD-012 may contain historical wording. Current source/migrations override stale documentation.

## Next action

1. Merge this docs-only DD-012C final-state sync after confirming the diff contains documentation only.
2. Provision real DeeDou menu/catalog data only from user-supplied source data; do not invent Production products/components.
3. Keep DD-012C business/schema contracts stable while future UI/UX work reuses the existing authoritative RPCs.
4. Scope the next backend/product milestone as a separate issue/PR before implementation.
5. Optionally close Issue #47 only if no DD-011B follow-up tracking item is intentionally retained.

## Required maintenance

When finishing a major phase, update at least:

- this file (`PROJECT_STATE.md`);
- `HANDOFF.md`;
- `ROADMAP.md` if milestone state changed;
- `DECISIONS.md` if a new decision was explicitly accepted;
- `DATABASE.md` / `API_CONTRACTS.md` when schema/contracts change.
