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
- ✅ DD-011B — sole Owner, username staff identity, Owner-approved first/new-device activation and backend-managed device sessions with no JS-readable device secret.

### DD-011B completion evidence

- PR #48 merged as `834049bb89a08968e5f69d77f9bb3718ba908d5b`.
- DD-011B forward migrations applied to Production Supabase `nwohsyzpmogqjbmknwbl`.
- Production server-only Supabase service credential configured separately from staging/Preview.
- Owner TOTP verified and backend-managed ADMIN device/session established.
- `backend_device_sessions_required = true` enabled after successful Owner bootstrap.
- Legacy ADMIN device revoked through the security workflow.
- Post-cutover Owner Admin access verified after enforcement.
- PR #49 hotfix merged as `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675` to restore the required Owner TOTP re-challenge path when a valid active device is paired with an AAL1 Auth session.
- PR #49 exact-head DeeDou CI, DD-010A, DD-011 and DD-012 contracts all passed; Production Vercel deployment succeeded; post-deploy Owner session/device/enforcement state was verified.

Issue #47 remains open only as tracking metadata at the 2026-08-24 review; close it after this documentation sync if no follow-up acceptance item is intentionally retained.

## Catalog provisioning

Parent: Issue #41.

- ✅ DD-012 Slice A — authoritative product core.
- ✅ DD-012 Slice B — variants/modifiers/assignments.
- 🟡 DD-012 Slice C / PR #46 — combo/component management using existing `product_components`.
- ⏭ Real DeeDou production menu provisioning through Admin UI using user-provided menu data after Slice C is accepted.

Current PR #46 integration status after DD-011B + hotfix merges:

- head `307e1868cac3cc1f1c593353ff3c51fa0878ce32`;
- Draft/open;
- currently not mergeable against latest `main`;
- branch diverged: 15 commits ahead / 73 commits behind.

Required next sequence for DD-012C:

1. rebase/update `agent/dd012c-combo-components` onto latest `main`;
2. resolve only real integration conflicts against current security/Admin composition;
3. rerun exact-head fresh-DB CI and existing regression contracts;
4. run DD-012C staging hosted Admin + public QR/order acceptance;
5. clean all staging fixtures back to baseline;
6. only after staging success consider Production migration and acceptance.

Do not invent production menu data. Import/duplicate helpers are optional and should be added only if real operator setup proves they materially reduce work.

## Merge sequencing for active work

DD-011B is complete, so PR #46 must now integrate **forward** onto the latest `main` rather than being treated as a parallel peer of PR #48.

Rules:

1. repository/source on latest `main` wins over stale PR #46 assumptions;
2. rebase/update before additional feature work;
3. resolve only actual integration conflicts;
4. do not remove DD-011B/hotfix security behavior to make the old branch merge;
5. rerun all relevant exact-head gates after conflict resolution.

## Accepted next product areas not yet implemented

### Billing / VAT / e-invoice

- ⏭ Explicit Cashier option for VAT/e-invoice when customer requests it; not automatic on every bill.
- ⏭ Current user-intended calculation is +8% VAT +2% service fee when that option is selected.
- **Gate:** current Vietnamese legal/tax/e-invoice rules, entity type, rounding, accounting treatment and provider API contract must be verified before coding. See `DECISIONS.md`.

This area should receive its own issue/contract before implementation. Do not mix it into DD-012C.

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
