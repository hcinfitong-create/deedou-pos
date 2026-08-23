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

Issue #47 remains open only as tracking metadata at the 2026-08-24 review; close it only after confirming no intentional follow-up acceptance item remains.

## Catalog provisioning

Parent: Issue #41.

- ✅ DD-012 Slice A — authoritative product core.
- ✅ DD-012 Slice B — variants/modifiers/assignments.
- ✅ DD-012 Slice C / PR #46 — authoritative combo/component management using existing `product_components`.
- ⏭ Real DeeDou production menu provisioning through Admin UI using user-provided menu data.

### DD-012C completion evidence

- accepted PR head: `27fa5c8219ad066bf21e3e02a33b1e803768535f`;
- PR #46 merged as `b282a0cd859b122fc6df4d065e5b9c496a5af537`;
- exact-head DeeDou CI, DD-010A, DD-011, DD-012 Catalog Contract and DD-012C hosted Preview smoke all passed;
- final hosted staging acceptance run `32673729910`, job `97278777585` — PASS;
- staging fixture cleanup returned catalog/order/security smoke data to zero;
- Vercel Production deployment for the merge commit succeeded;
- Production migration `dd012c_combo_components` applied as version `20260823235316`;
- post-rollout Production verification confirmed component RPCs/ACLs and DD-011B security baseline intact;
- no Production menu/combo fixture data was invented or left behind.

DD-012C architecture remains binding:

- `product_components` is the canonical component graph; no parallel combo model;
- submitted order component/configured snapshots remain immutable;
- browser direct writes remain denied;
- Admin component mutations use existing authenticated `menu.manage` + registered workstation/backend-session authority.

## Next catalog work

Real menu provisioning is now the next accepted catalog step, but it requires user-provided source data.

Rules:

1. do not invent Production products/components;
2. reuse current DD-012 A/B/C contracts rather than creating a second catalog path;
3. keep data provisioning separate from UI/UX redesign;
4. UI/UX redesign may reuse existing backend contracts and should request backend changes only for proven capability gaps.

## Accepted next product areas not yet implemented

### Billing / VAT / e-invoice

- ⏭ Explicit Cashier option for VAT/e-invoice when customer requests it; not automatic on every bill.
- ⏭ Current user-intended calculation is +8% VAT +2% service fee when that option is selected.
- **Gate:** current Vietnamese legal/tax/e-invoice rules, entity type, rounding, accounting treatment and provider API contract must be verified before coding. See `DECISIONS.md`.

This area should receive its own issue/contract before implementation.

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
