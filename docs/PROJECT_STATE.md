# DeeDou Project State

> Long-lived project state. Repository/source/CI remain authoritative; re-check them before coding.

Last verified: 2026-08-23 20:36 +07

## Source-of-truth order

1. Current source code.
2. Current database schema and forward migrations.
3. GitHub branch / commit / PR / CI.
4. Repository documentation.
5. Confirmed decisions in `docs/DECISIONS.md`.
6. Conversation history.
7. Memory.
8. Inference.

## Repository scope

This repository is the DeeDou POS + QR Ordering web application. It contains customer QR ordering, Cashier POS, Floor Staff, Kitchen/Bar/Dessert KDS, table-session authority, payment/refund ledger, Admin surfaces and Supabase/PostgreSQL authoritative backend integration.

The wider DeeDou Brand/Store, Marketing Agent, Accounting Agent and local AI infrastructure are outside this repository unless an explicit integration is added.

## Architecture state

- Framework-free JavaScript application with hash routes.
- Feature ownership lives under existing domain modules; do not introduce parallel models without an accepted decision.
- `shared/backend` is the Supabase/backend transport boundary.
- `shared/auth` is the browser authentication/route authorization boundary.
- PostgreSQL is authoritative for hosted business state.
- Realtime is a refresh hint; clients refetch authoritative snapshots.
- Public QR remains unauthenticated and narrowly scoped.
- Historical submitted order-line pricing/options/component snapshots remain immutable.

See `docs/ARCHITECTURE.md`, `docs/MODULE_MAP.md`, `docs/DATABASE.md` and `docs/API_CONTRACTS.md` before changing the relevant boundaries.

## Production-complete baseline

Confirmed completed milestones include:

- DD-002 / DD-002.1 — staff-order state + hybrid service context.
- DD-003 — station workflow + item-level serving.
- DD-004 — table-session/floor visit operations.
- DD-005 — variants/modifiers/configured pricing snapshots.
- DD-006 — course Hold/Fire workflow.
- DD-007 — append-only payment ledger.
- DD-008A — PostgreSQL/Supabase backend foundation.
- DD-008B — Auth/RBAC + hosted ACL hardening.
- DD-008C — authoritative commands + realtime refresh hints.
- DD-008D / DD-008P — authoritative cutover/resilience and hosted acceptance baseline.
- DD-010A — authoritative Admin table/floor/QR management.
- DD-011 — AAL2 production identity/device security baseline.
- DD-012 Slice A — authoritative product core.
- DD-012 Slice B — variants/modifiers/assignments.

## Current open work

### DD-011B — Issue #47 / PR #48

- PR: #48 `DD-011B: single Owner and backend-managed device activation`
- Branch: `agent/dd011b-owner-device-hardening`
- Base: `main`
- Exact head last verified: `9c77eb5fe9c017df0f1ed5257a7c368338e708b5`
- State: open, Draft, mergeable.
- Accepted scope: exactly one active OWNER, Owner AAL2 for privileged security actions, Name+username staff provisioning, Owner-approved six-digit first/new-device activation, backend-managed trusted-device sessions, immediate revoke/disable semantics, no browser-readable device secret, public QR outside staff security gateway.

Latest exact-head CI checked:

- DeeDou CI run #472 / run id `32642788388`: **FAILURE**.
- `backend-db`: PASS.
- `dd008c-integration`: PASS.
- `auth-integration`: PASS.
- `browser-smoke`: PASS.
- `test`: PASS.
- `dd008d-browser-smoke`: **FAIL**, job `97202349076`.

The head advanced one commit from `9687ecdf...` to `9c77eb5...`. That commit removed temporary DD011B Admin diagnostic preloads and changed `src/shared/backend/admin.js`, `src/shared/backend/admin-options.js`, `tests/dd008d-admin.test.js`, `tests/dd012b-admin-options.test.js` and package wiring. Despite those changes, exact-head DD008D browser smoke still fails. Re-inspect the current failure before making another fix.

Detailed session checkpoint: `docs/handoffs/DD-011B-PR48.md`.

### DD-012C — Issue #41 slice / PR #46

- PR: #46 `DD-012C: authoritative combo component management`
- Branch: `agent/dd012c-combo-components`
- Exact head last verified: `307e1868cac3cc1f1c593353ff3c51fa0878ce32`
- State: open, Draft, mergeable.
- Scope: extend existing `product_components`; no parallel combo model; preserve immutable submitted-order snapshots.

PR #46 and PR #48 are business-logically independent. Shared integration conflicts must be resolved by normal rebase/conflict handling, not by copying unrelated business logic between them.

## Current production authority / do-not-regress rules

- PostgreSQL is hosted business authority.
- Browser direct writes to protected business/catalog/security tables remain denied.
- Transactional RPC/backend handlers are authoritative mutation boundaries.
- Public QR remains unauthenticated and exact-token/public-projection scoped.
- Payment history remains append-only with bounded targeted refunds.
- KDS preparation, FOH serving and payment state remain separate.
- OWNER privileged security paths retain accepted AAL2 requirements.
- DD-011B must not restore a JS-readable workstation/device secret.
- Real production menu values must come from user-provided business data.

## Known coupling / technical debt

- `app.js` still owns broad route composition and UI orchestration.
- Admin surfaces share app-shell integration points.
- Parallel PRs may collide in `index.html`, `package.json` and Admin composition.
- Documentation may become stale while a branch moves; every session must compare handoff state with current GitHub/source.

## Current next priorities

1. Re-check PR #48 current head before touching code.
2. Inspect the exact-head DD008D browser-smoke failure on run #472 or any newer run.
3. Prove root cause before another DD011B fix; preserve security contracts.
4. Get exact-head local/fresh-DB regressions green.
5. Complete Issue #47 staging hosted acceptance + cleanup before considering PR #48 merge readiness.
6. Keep PR #46 independent; rebase whichever PR merges second.
7. Continue real menu provisioning only from user-supplied menu data after the relevant catalog slice is accepted.

## Documentation maintenance

Follow `docs/CONTINUITY_PROTOCOL.md`. At the end of each substantial session update the relevant workstream handoff and refresh this file only when project/PR/milestone state materially changes.
