# DeeDou Project State

> Dynamic source-of-truth summary. Update this file whenever a major PR/phase changes state.
>
> Last source review: 2026-08-24. Repository `main` is at DD-011B merge commit `834049bb89a08968e5f69d77f9bb3718ba908d5b`; production state below was verified after the DD-011B cutover and legacy-device cleanup.

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

Merged/production-complete work confirmed from repository history and production verification:

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
- DD-011B — sole Owner + backend-managed device activation/session trust; merged and production-cutover complete via PR #48.
- DD-012 Slice A — authoritative product-core Admin catalog.
- DD-012 Slice B — authoritative variants/modifiers and assignments.

### DD-011B final production state

PR #48 (`agent/dd011b-owner-device-hardening`) merged into `main` as commit `834049bb89a08968e5f69d77f9bb3718ba908d5b`.

Implemented/verified production state:

- exactly one active OWNER globally;
- Owner has one verified TOTP MFA factor and privileged Owner flow requires AAL2;
- production Vercel has its server-only `DEEDOU_SUPABASE_SERVICE_ROLE_KEY` configured separately from staging Preview;
- all four DD-011B forward migrations are applied to production;
- Owner bootstrapped a backend-managed ADMIN workstation using the same-origin backend;
- trusted device session is represented by backend session state / Secure HttpOnly cookie; no browser-readable device secret is the production authority;
- `backend_device_sessions_required = true` in production;
- live Owner Admin access was re-verified after enforcement was enabled, and the backend session `last_seen_at` advanced after the enforcement timestamp;
- the old legacy ADMIN device was revoked through the Owner security workflow; it has no active backend session and its revoke is present in the audit log;
- the current Owner ADMIN device/session remains active after cleanup;
- public QR remains outside the staff security gateway.

Pre-merge exact-head Preview acceptance was green, including cleanup baseline. Production DD-011B cutover acceptance was completed via live Owner flow plus direct production DB invariant checks. The existing `DD-011 Production Hosted Security Smoke` workflow is still hard-scoped to historical PR #39, so it was not repurposed to manufacture a new green run for PR #48.

## Current open work

### PR #46 — DD-012C combo/components

Branch: `agent/dd012c-combo-components`
Issue parent: #41
Status reviewed 2026-08-24: **Draft / open / currently not mergeable**.

Current integration state against `main` after PR #48:

- branch is 15 commits ahead and 70 commits behind `main`;
- GitHub comparison status is `diverged`;
- merge base predates PR #48;
- rebase/conflict resolution is required before DD-012C validation can be trusted.

Scope remains:

- authoritative CRUD for existing `product_components` model;
- Admin component editor;
- no parallel combo model;
- preserve immutable submitted-order snapshots;
- import/duplicate helper only if real provisioning proves it useful;
- no invented production menu data.

Expected integration hotspots after rebase include `index.html`, `package.json`, shared backend exports and Admin composition. Resolve only real integration conflicts; do not copy DD-011B business/security logic into DD-012C merely to make the branch merge.

## Current production authority

- PostgreSQL is business authority for hosted Supabase mode.
- Browser direct writes to protected business/catalog/security tables are denied.
- Transactional RPCs are the authoritative mutation boundary.
- Realtime events are refresh hints, not state authority; clients refetch authoritative snapshots.
- LOCAL_DEMO remains a separate demo/runtime path. No authoritative dual-write between localStorage and PostgreSQL.
- Historical submitted order-line pricing/options are immutable snapshots.
- Staff/Owner protected operations require backend-managed device-session trust in production.
- OWNER privileged security paths require AAL2; sole-Owner protection is enforced.
- Revoked legacy device credentials are not sufficient for protected access after DD-011B enforcement.

## Known coupling / technical debt

- `app.js` still owns broad route composition, DOM/event wiring and orchestration.
- Some Admin surfaces remain integrated in the app shell.
- Hosted/security smoke suites include DD-011B backend device-session trust. Any future harness change must preserve the no-JS-readable-device-secret rule and public QR bypass of staff security.
- `DD-011 Production Hosted Security Smoke` is still intentionally hard-scoped to historical PR #39; future production-security automation should be redesigned deliberately rather than bypassing that gate ad hoc.
- Repository docs written before DD-008D/DD-010/DD-011/DD-012 may contain historical wording. Current source/migrations override stale documentation.

## Next action

1. Rebase `agent/dd012c-combo-components` / PR #46 onto current `main` (`834049bb89a08968e5f69d77f9bb3718ba908d5b` or newer at execution time).
2. Resolve only real DD-011B/DD-012C integration conflicts and re-read the affected implementations after rebase.
3. Run fresh exact-head DD-012C CI/fresh-DB contracts; do not reuse results from the pre-DD-011B branch state.
4. If local/fresh-DB gates are green, proceed with the already-defined staging DD-012C hosted acceptance and fixture cleanup before any production migration.
5. Continue real DeeDou menu provisioning only from user-supplied menu data; do not invent production catalog data.

## Required maintenance

When finishing a major phase, update at least:

- this file (`PROJECT_STATE.md`);
- `HANDOFF.md`;
- `ROADMAP.md` if milestone state changed;
- `DECISIONS.md` if a new decision was explicitly accepted;
- `DATABASE.md` / `API_CONTRACTS.md` when schema/contracts change.
