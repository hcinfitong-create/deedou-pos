# DeeDou Project State

> Dynamic source-of-truth summary. Update this file whenever a major PR/phase changes state.
>
> Last source review: 2026-08-23. DD-011B docs finalization is based on PR #48 pre-documentation head `1b0d4931693891ee343c037399d250beb9e146b7`.

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

Merged/production-complete work confirmed from GitHub history:

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
- DD-012 Slice A — authoritative product-core Admin catalog.
- DD-012 Slice B — authoritative variants/modifiers and assignments.

## Current open work

### PR #48 — DD-011B single Owner + backend-managed device activation

Branch: `agent/dd011b-owner-device-hardening`
Issue: #47
Status at DD-011B docs finalization: **Draft / open / mergeable**. Implementation and exact-head Vercel Preview hosted security acceptance completed on pre-documentation head `1b0d4931693891ee343c037399d250beb9e146b7`; final merge remains pending Production rollout prerequisite verification and fresh exact-head checks after this docs-only commit.

Accepted scope:

- exactly one active OWNER globally;
- Owner AAL2 for privileged security operations;
- staff `display_name` + case-insensitive unique `username`;
- Owner-created pending staff account;
- first-login/new-device six-digit verification challenge;
- explicit Owner approval;
- backend-managed trusted device session;
- device secret never stored in frontend JS-readable storage;
- immediate device/staff/location/role revoke semantics;
- public QR remains outside staff security gateway.

Resolved hosted acceptance regressions:

- Chromium username `pattern` syntax was corrected without changing the accepted username contract.
- Async/background 403 resource diagnostics now classify only proven expected `DEVICE_SESSION_REQUIRED` and `SINGLE_OWNER_ENFORCED` responses by phase/path/method/reason; no global 403 ignore was added.

Verified evidence on pre-documentation head `1b0d4931693891ee343c037399d250beb9e146b7`:

- DeeDou CI `32659206957`: PASS.
- DD-011 Security Hardening Contract `32659206967`: PASS.
- DD-010A Table Authority Contract `32659206939`: PASS.
- DD-012 Catalog Contract `32659206898`: PASS.
- DD-011 Vercel Preview Hosted Security Smoke `32659206888`, job `97242678394`: PASS.
- Hosted log ended with `DD011B_PREVIEW_CLEANUP_BASELINE=PASS` and `DD-011B Vercel Preview hosted security acceptance passed.`
- Vercel Preview status: Ready/success.

Hosted acceptance is no longer pending for the pre-documentation implementation head. Exact-head DB/Auth/browser/security/hosted state must still be read from GitHub Actions after every new commit; do not copy an old CI conclusion forward. PR #48 remains open/Draft and is not production verified or merged.

### PR #46 — DD-012C combo/components

Branch: `agent/dd012c-combo-components`
Issue parent: #41
Status: **Draft / open**.

Scope:

- authoritative CRUD for existing `product_components` model;
- Admin component editor;
- no parallel combo model;
- preserve immutable submitted-order snapshots;
- import/duplicate helper only if real provisioning proves it useful.

PR #46 and PR #48 are intentionally independent. They both touch integration files such as `index.html` / `package.json`; whichever merges second may require rebase/conflict resolution. Do not merge one PR's business logic into the other merely to avoid a normal integration conflict.

## Current production authority

- PostgreSQL is business authority for hosted Supabase mode.
- Browser direct writes to protected business/catalog/security tables are denied.
- Transactional RPCs are the authoritative mutation boundary.
- Realtime events are refresh hints, not state authority; clients refetch authoritative snapshots.
- LOCAL_DEMO remains a separate demo/runtime path. No authoritative dual-write between localStorage and PostgreSQL.
- Historical submitted order-line pricing/options are immutable snapshots.

## Known coupling / technical debt

- `app.js` still owns broad route composition, DOM/event wiring and orchestration.
- Some Admin surfaces remain integrated in the app shell.
- Hosted/security smoke suites now include DD-011B backend device-session trust. Any future harness change must preserve the no-JS-readable-device-secret rule and public QR bypass of staff security.
- Repository docs written before DD-008D/DD-010/DD-011/DD-012 may contain historical wording. Current source/migrations override stale documentation.

## Next action

1. After this docs-only commit, re-check PR #48 exact head and all GitHub/Vercel checks.
2. Verify the Production Vercel server-only service-role environment for the production Supabase project before any production rollout/acceptance claim.
3. If post-doc exact-head checks and production prerequisites are green, move PR #48 from Draft to Ready for final merge-readiness review.
4. Rebase/resolve interaction with PR #46 according to merge order.
5. Continue DD-012C and real menu provisioning using user-supplied menu data; do not invent production catalog data.

## Required maintenance

When finishing a major phase, update at least:

- this file (`PROJECT_STATE.md`);
- `HANDOFF.md`;
- `ROADMAP.md` if milestone state changed;
- `DECISIONS.md` if a new decision was explicitly accepted;
- `DATABASE.md` / `API_CONTRACTS.md` when schema/contracts change.
