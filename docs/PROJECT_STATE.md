# DeeDou Project State

> Dynamic source-of-truth summary. Update this file whenever a major PR/phase changes state.
>
> Last source review: 2026-08-23. Baseline inspected for DD-011B hosted acceptance on `agent/dd011b-owner-device-hardening` at PR #48 head.

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
Status at DD-011B hosted acceptance update: **Draft / open / mergeable; Vercel Preview hosted security acceptance is automated by `.github/workflows/dd011-preview-hosted-smoke.yml` job `dd011b-hosted-preview-security-acceptance` and must pass on the exact PR head before merge**.

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

Recent browser regression root cause: DD-008C/DD-008D smoke fixtures and serve-flow synchronization were adapted to the DD-011B backend-managed device-session model without restoring browser-readable workstation credentials. Production security must not be weakened to satisfy old fixtures.

Hosted acceptance status is no longer a manual pending item in source: PR #48 now has a dedicated DD-011B Vercel Preview hosted security acceptance gate and versioned staging bootstrap function source at `supabase/functions/dd008-hosted-smoke-bootstrap/index.ts`. Exact-head DB/Auth/browser/security/hosted state must still be read from GitHub Actions after every new commit; do not copy an old CI conclusion forward.

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

1. Re-check PR #48 exact head and all CI jobs, including the DD-011B hosted acceptance job in `DD-011 Vercel Preview Hosted Security Smoke`.
2. If a job fails, inspect the failing log and identify root cause before changing code.
3. Confirm hosted acceptance cleanup returns the run-scoped staging database fixtures to baseline.
4. If all exact-head local/CI/hosted gates pass, PR #48 can be moved from Draft to Ready for Review.
5. Rebase/resolve interaction with PR #46 according to merge order.
6. Continue DD-012C and real menu provisioning using user-supplied menu data; do not invent production catalog data.

## Required maintenance

When finishing a major phase, update at least:

- this file (`PROJECT_STATE.md`);
- `HANDOFF.md`;
- `ROADMAP.md` if milestone state changed;
- `DECISIONS.md` if a new decision was explicitly accepted;
- `DATABASE.md` / `API_CONTRACTS.md` when schema/contracts change.
