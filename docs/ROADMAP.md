# DeeDou POS Roadmap

> Ordered engineering roadmap for this repository. This is not a promise that every future item will be implemented unchanged; accepted milestones are separated from unapproved ideas.

## Status legend

- ✅ Production-complete / merged acceptance.
- 🟡 In progress / open PR.
- ⏭ Accepted next work.
- ◻ Candidate / needs explicit issue/decision before implementation.

## Foundation and core operations

- ✅ DD-002 — staff order state machine/module extraction.
- ✅ DD-002.1 — hybrid cafe + restaurant service context.
- ✅ DD-003 — station workflow and item-level serving.
- ✅ DD-004 — table-session/floor visit operations.
- ✅ DD-005 — variants/modifiers/configured pricing snapshots in local domain layer.
- ✅ DD-006 — course Hold/Fire workflow.
- ✅ DD-007 — append-only payment ledger.

## Authoritative backend cutover

- ✅ DD-008A — PostgreSQL/Supabase foundation.
- ✅ DD-008B — Auth/RBAC + hosted ACL hardening.
- ✅ DD-008C — authoritative command/realtime refresh-hint layer.
- ✅ DD-008D — cutover/resilience, Admin authority and final local multi-context acceptance.
- ✅ DD-008P — hosted production-authoritative acceptance/cutover verification.

## Admin authority

- ✅ DD-010A — Admin tables/floor layout/QR authority.
- ✅ DD-011 — AAL2-gated production identity/device security hardening.

## Catalog provisioning

Parent: Issue #41.

- ✅ DD-012 Slice A — authoritative product core.
- ✅ DD-012 Slice B — variants/modifiers/assignments.
- 🟡 DD-012 Slice C / PR #46 — combo/component management using existing `product_components`.
- ⏭ Real DeeDou production menu provisioning through Admin UI using user-provided menu data after Slice C is accepted.

Do not invent production menu data. Import/duplicate helpers are optional and should be added only if real operator setup proves they materially reduce work.

## Identity/device trust refinement

- 🟡 DD-011B / Issue #47 / PR #48 — sole Owner, username staff identity, Owner-approved first/new-device activation, backend-managed device sessions, no JS-readable device secret.

Required gates before merge/production completion:

1. exact-head local/fresh-DB regressions;
2. DD-008/DD-010A/DD-011/DD-012 regression compatibility;
3. staging hosted acceptance;
4. fixture cleanup/baseline restoration;
5. production rollout plan/acceptance appropriate to Issue #47.

## Merge sequencing for current parallel work

PR #46 and PR #48 are independent but can conflict in shared integration files.

Recommended rule:

1. finish/validate each PR independently;
2. merge the ready PR;
3. rebase the other on latest `main`;
4. resolve only real integration conflicts (`index.html`, `package.json`, Admin composition as applicable);
5. rerun exact-head CI/hosted gates.

Do not combine DD-012C business logic into DD-011B or vice versa solely to avoid rebasing.

## Accepted next product areas not yet implemented

### Billing / VAT / e-invoice

- ⏭ Explicit Cashier option for VAT/e-invoice when customer requests it; not automatic on every bill.
- ⏭ Current user-intended calculation is +8% VAT +2% service fee when that option is selected.
- **Gate:** current Vietnamese legal/tax/e-invoice rules, entity type, rounding, accounting treatment and provider API contract must be verified before coding. See `DECISIONS.md`.

This area should receive its own issue/contract before implementation. Do not mix it into DD-011B/DD-012C.

## Candidate future areas — no binding implementation issue yet

These are wider DeeDou needs and must be scoped/approved individually:

- ◻ inventory / recipe / COGS authority;
- ◻ accounting export/integration and eventual Accounting Agent boundary;
- ◻ e-invoice provider integration after billing contract is defined;
- ◻ discounts/promotions/loyalty;
- ◻ real PSP integrations (VNPAY/MoMo/ZaloPay etc.) rather than current manual/external-terminal semantics;
- ◻ richer reports/operations analytics;
- ◻ decomposition of large `app.js` UI orchestration after higher-priority authoritative workflows stabilize;
- ◻ integrations with wider DeeDou Marketing/Accounting/local-AI infrastructure when an explicit cross-system contract exists.

## Roadmap rules

- Do not start a later milestone by embedding it into an unrelated PR.
- Architecture/security/data integrity prerequisites outrank UI polish.
- Each database/API slice follows local/fresh-DB CI → staging acceptance/cleanup → production gate where applicable.
- Update this roadmap when a milestone is merged, abandoned, superseded or explicitly added.
