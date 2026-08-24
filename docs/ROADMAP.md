# DeeDou POS Roadmap

> Ordered engineering roadmap for this repository. Accepted milestones are separated from conditional implementation details. Repository/source state still overrides this document when they conflict.

## Status legend

- ✅ Production-complete / merged acceptance.
- 🟡 In progress / active engineering phase.
- ⏭ Accepted future work.
- ◻ Conditional detail / requires a dedicated issue, contract or external/provider decision before implementation.

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
- Owner TOTP verified and backend-managed ADMIN device/session established.
- `backend_device_sessions_required = true` enabled after successful Owner bootstrap.
- Legacy ADMIN device revoked through the security workflow.
- PR #49 hotfix merged as `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675` to preserve the Owner TOTP re-challenge path when a valid active device is paired with an AAL1 Auth session.

Issue #47 remains open only as tracking metadata at the 2026-08-24 review; close it only after confirming no intentional follow-up acceptance item remains.

## Catalog authority

Parent: Issue #41.

- ✅ DD-012 Slice A — authoritative product core.
- ✅ DD-012 Slice B — variants/modifiers/assignments.
- ✅ DD-012 Slice C / PR #46 — authoritative combo/component management using existing `product_components`.

### DD-012C completion evidence

- accepted PR head: `27fa5c8219ad066bf21e3e02a33b1e803768535f`;
- PR #46 merged as `b282a0cd859b122fc6df4d065e5b9c496a5af537`;
- exact-head DeeDou CI, DD-010A, DD-011, DD-012 Catalog Contract and DD-012C hosted Preview smoke passed;
- final hosted staging acceptance run `32673729910`, job `97278777585` — PASS;
- Production migration `dd012c_combo_components` applied as version `20260823235316`;
- Production verification preserved DD-011B security and left real products/components/orders empty.

Binding catalog architecture:

- `product_components` remains the canonical combo/component graph; no parallel combo model;
- submitted order component/configured snapshots remain immutable;
- browser direct writes remain denied;
- Admin catalog mutations use authenticated server-authoritative contracts.

## Confirmed execution sequence after DD-012C

The following sequence is user-confirmed on 2026-08-24. **Do not prioritize real menu population or broad UI/UX polish ahead of these backend/business phases.**

### Phase 1 — Production operational hardening

Status: 🟡 **current priority**.
Tracking issue: #40.

Complete the operational controls required for a production service:

- backup strategy and tested restore posture;
- documented RPO/RTO;
- final Supabase Auth Site URL / redirect allowlist verification;
- explicit public-signup posture;
- leaked-password protection decision/configuration;
- rate-limit policy for public QR, Auth and privileged Admin surfaces;
- audit/log retention, access and secret-redaction policy.

Real tables/menu/business data are a later go-live provisioning gate and do not replace these operational controls.

### Phase 2 — Billing, VAT, service fee and e-invoice checkout authority

Status: ⏭ **accepted next functional phase after Phase 1**.
Tracking issue: #52 / DD-013.

Accepted product intent and legal gate:

- Cashier needs an explicit customer invoice-information/request workflow;
- that customer-request workflow must **not** be interpreted as permission to suppress an electronic invoice that current law requires the seller to create;
- invoice obligation/type/timing, required buyer information and cash-register e-invoice applicability must be reconciled against the current legal/accounting contract before code semantics are fixed;
- the previously discussed +8% VAT and +2% service-fee calculation remains product intent only, not a universal permanent rule;
- current VAT eligibility, effective period, tax base, service-fee treatment, rounding and provider contract must be verified before hard-coding;
- implementation must preserve the append-only payment ledger and existing immutable order/KDS/table-session history.

Phase 2 may perform research/specification while Phase 1 runs, but Production implementation begins only after Phase 1 closes and DD-013 contract questions are approved.

### Phase 3 — Accepted wider POS/back-office capabilities

Status: ⏭ **accepted future implementation phase**. Individual capabilities still require dedicated issues/contracts and sequencing.

Accepted scope includes:

- inventory / recipe / COGS authority;
- accounting export/integration and eventual Accounting Agent boundary;
- provider-specific e-invoice integration after the Phase 2 billing contract/provider selection;
- discounts/promotions/loyalty;
- real PSP integrations such as VNPAY/MoMo/ZaloPay after payment-provider contracts are selected;
- richer reports/operations analytics;
- technical decomposition of large UI orchestration where justified by the accepted feature work, without an architecture rewrite;
- explicit integrations with wider DeeDou Marketing/Accounting/local-AI infrastructure when cross-system contracts are defined.

### Menu provisioning and recipe/cost/inventory coupling

Real DeeDou production menu provisioning is **deferred until the required inventory/recipe/cost authority is designed and implemented**.

Accepted rule:

- production menu entry is not treated as isolated product-name/price data entry;
- the menu-provisioning phase must include the recipe/cost/inventory model needed for sold items to deduct inventory correctly;
- exact recipe/BOM, ingredient unit, yield, waste, direct-stock-item and COGS semantics must be specified in the Phase 3 inventory contract rather than guessed during catalog entry;
- real Production menu values still come only from user-provided business data.

The existing DD-012 product/variant/modifier/component contracts remain the catalog authority and should be extended/reused rather than replaced.

### UI/UX redesign

Broad Admin/POS/QR UI/UX redesign remains a later phase after the confirmed business/backend capabilities above stabilize.

UI work should reuse existing backend contracts. A backend/schema change is justified only by a proven capability gap, not by visual preference alone.

## Roadmap rules

- Do not start a later milestone by embedding it into an unrelated PR.
- Architecture/security/data integrity prerequisites outrank UI polish.
- Each database/API slice follows local/fresh-DB CI → staging acceptance/cleanup → production gate where applicable.
- A phase-level acceptance does not authorize guessing its detailed business rules; each capability still needs a scoped issue/contract.
- Do not invent Production menu, tax, provider, accounting or inventory data/rules.
- Update this roadmap when a milestone is merged, abandoned, superseded or explicitly added.
