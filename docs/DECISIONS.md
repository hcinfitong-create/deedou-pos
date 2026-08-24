# DeeDou Accepted Decisions

> This file records decisions that must not be silently reversed. It is not a wishlist.
>
> Status labels:
> - **IMPLEMENTED** — represented in current repository/runtime.
> - **ACCEPTED / IN PROGRESS** — explicitly accepted and currently being implemented.
> - **ACCEPTED / NOT IMPLEMENTED** — product decision exists but code is not yet present.
> - **ACCEPTED INTENT / LEGAL RECONCILIATION REQUIRED** — user intent is recorded, but current law/accounting/provider rules must be reconciled before implementation semantics become binding.
> - **PROPOSED** — not binding; must not be implemented as a rule without approval.

## Architecture

### D-001 — Incremental framework-free evolution
**Status: IMPLEMENTED**

DeeDou POS remains a framework-free JavaScript/hash-route application and evolves incrementally into feature modules. No React/Next/framework rewrite or broad architecture rewrite without explicit authorization.

### D-002 — Domain ownership over duplication
**Status: IMPLEMENTED**

Each business capability has one canonical owner module/model. Reuse/extend existing owners before creating anything parallel.

Examples: `product_components` remains the combo-component model; `payments` remains the payment-ledger rule owner; `table-session` remains the active visit owner.

## Backend / authority

### D-003 — PostgreSQL is hosted business authority
**Status: IMPLEMENTED**

In hosted Supabase mode, PostgreSQL/RPC state is authoritative. Realtime is a refresh hint; browser clients refetch authoritative snapshots.

LOCAL_DEMO remains separate. There is no authoritative dual-write to localStorage.

### D-004 — Protected mutations use narrow server-authoritative contracts
**Status: IMPLEMENTED**

Browser direct writes to protected operational, catalog, payment, audit, RBAC and security tables remain denied. Transactional RPCs/backend handlers enforce authorization and invariants.

### D-005 — Public QR is unauthenticated but narrowly scoped
**Status: IMPLEMENTED**

Customer QR flow does not pass through staff security. Table resolution is exact-token scoped; public projections expose only public-safe menu/order data.

## Order / service workflow

### D-006 — Hybrid service context
**Status: IMPLEMENTED**

Orders distinguish:

- `COUNTER_SERVICE` vs `TABLE_SERVICE`;
- `DINE_IN` vs `TAKEAWAY`;
- source `CUSTOMER_QR`, `STAFF`, `COUNTER`.

Takeaway is a fulfillment type, not a physical table/zone.

### D-007 — Preparation, serving and billing are separate
**Status: IMPLEMENTED**

KDS preparation uses line `prepStatus`; FOH serving uses `servedQty`; billing/payment is separate. KDS must not mark an item `SERVED` and payment must not become a prep-state shortcut.

### D-008 — Course Hold/Fire releases work; it does not complete prep
**Status: IMPLEMENTED**

`course-workflow` owns course and HELD/FIRED state. FIRED only releases work to KDS; normal prep transitions still apply.

### D-009 — Physical Table != Table Session != Order Batch
**Status: IMPLEMENTED**

A table session is one dining visit and may contain multiple order batches. Counter/takeaway can have no table session.

## Payment

### D-010 — Append-only payment ledger
**Status: IMPLEMENTED**

Payments, payment voids and targeted refunds are ledger transactions. Effective paid/refunded/outstanding amounts are derived from the ledger rather than destructive mutation of payment history.

### D-011 — CASHIER can perform bounded targeted refunds
**Status: IMPLEMENTED**

A valid CASHIER role on a valid CASHIER workstation may execute the accepted refund operation directly; no Manager/Owner second approval is required in the current DD-008D policy. Refund remains server-authoritative, selected-payment-targeted, bounded by remaining refundable amount, idempotent and audited; refund after close must not reopen table/KDS workflow.

## Catalog

### D-012 — Reuse the existing catalog graph
**Status: IMPLEMENTED**

Use `products`, `product_variants`, `modifier_groups`, `modifier_options`, `product_modifier_groups`, `product_components`. Do not create a parallel catalog/combo model.

DD-012 A/B/C are Production-complete. Future recipe/inventory work must extend the existing catalog authority rather than replacing it.

### D-013 — Historical submitted order snapshots are immutable
**Status: IMPLEMENTED**

Catalog edits must not rewrite submitted order-line pricing/options/component snapshots.

### D-014 — Do not invent production menu data
**Status: ACCEPTED**

Real DeeDou menu provisioning must use user-provided business data. Implementation/tests may use run-scoped fixtures, but production catalog values must not be guessed.

## Identity / security

### D-015 — Exactly one active OWNER globally
**Status: IMPLEMENTED**

No second active OWNER may be granted. The sole Owner account/role/location cannot be deactivated/revoked through normal application flows.

### D-016 — Owner privileged security actions require AAL2
**Status: IMPLEMENTED**

Owner controls MFA/TOTP. Staff creation, activation approval, role changes, device revoke/rotate and account/location security mutations require Owner AAL2 according to the DD-011B contract.

### D-017 — Staff identity uses Name + username + role/location
**Status: IMPLEMENTED**

Staff has `display_name` and unique case-insensitive `username`. Owner creates staff with Name + username + temporary password + initial role/location. Do not create a parallel user identity system.

### D-018 — Password login alone does not trust a new staff device
**Status: IMPLEMENTED**

First login/new device creates a short-lived 6-digit verification challenge. Owner compares the code and explicitly approves. Pending staff/device is not operationally trusted before approval.

### D-019 — Device trust is backend-managed
**Status: IMPLEMENTED**

Device secrets/session proof must not be stored in localStorage/sessionStorage/IndexedDB or exposed to frontend JavaScript. Trust uses backend-managed device session state plus Secure/HttpOnly/SameSite cookie proof. Revoke/disable takes effect on subsequent staff requests.

### D-020 — Manager cannot mint Owner/device trust
**Status: IMPLEMENTED**

Role/device issuance is Owner-authoritative. Manager can retain explicitly granted operational permissions but cannot create/grant Owner or issue trusted device access.

## Billing / e-invoice product direction

### D-021 — Cashier supports an explicit customer invoice-information/request workflow; invoice issuance itself follows current law
**Status: ACCEPTED INTENT / LEGAL RECONCILIATION REQUIRED**

The original user intent was that normal checkout should not add VAT/e-invoice handling unless the customer requests it, with an explicit Cashier option for the request.

Current legal research for Phase 2 indicates that Vietnamese electronic-invoice obligations in force in 2026 may require the seller to create an electronic invoice when goods/services are sold, including rules relevant to direct-to-consumer/F&B transactions. Therefore the old intent must **not** be implemented as “no invoice exists unless the customer asks”.

Phase 2 must distinguish at least:

- the legal obligation/timing to create the required electronic invoice or cash-register electronic invoice; and
- the optional customer-request workflow for collecting buyer/tax information or delivering an invoice in the form requested by the customer.

The final behavior becomes binding only after current legal/accounting requirements and the chosen e-invoice provider contract are verified and recorded. Do not suppress legally required invoice issuance based solely on the customer-request toggle.

### D-022 — Requested pricing intent currently targets +8% VAT and +2% service fee
**Status: ACCEPTED INTENT / LEGAL RECONCILIATION REQUIRED**

The intended POS behavior previously discussed is: when the relevant VAT/service-fee flow applies, the UI/business calculation targets 8% VAT and 2% service fee.

This records product intent only. Current legal research indicates the 8% VAT reduction applies only to eligible goods/services and is time-bounded under current legislation; it is not a universal permanent rate. The tax base, eligibility by product, treatment of alcoholic/special-tax goods if applicable, service-fee tax treatment, rounding, invoice timing and accounting entries are not yet verified for DeeDou's eventual legal entity and menu.

Before implementation, Phase 2 must define a current legal/accounting tax contract and provider/API contract. Do not hard-code 8% or 2% as universal rules solely from conversation history.

## Confirmed implementation sequencing

### D-023 — Complete operational hardening before the next functional billing phase
**Status: ACCEPTED / IN PROGRESS**

After DD-012C, the immediate engineering priority is Production operational hardening tracked by Issue #40: backup/restore posture, RPO/RTO, Auth configuration, signup/password-protection posture, rate limits and audit/log retention/redaction.

Real menu population and broad UI/UX redesign are intentionally deferred while these production controls and confirmed functional backend capabilities are completed.

### D-024 — Phase 2 is billing/VAT/service-fee/e-invoice checkout authority
**Status: ACCEPTED / NOT IMPLEMENTED**

After Phase 1, DeeDou will implement the billing/VAT/service-fee/e-invoice checkout contract as a dedicated scoped milestone. Legal/tax/accounting reconciliation is the first gate of the milestone, before database/API/UI semantics are fixed.

The implementation must preserve the append-only payment ledger and existing order/table/KDS history, and it must not hard-code legally sensitive tax, invoice-issuance or provider behavior until the current legal/accounting/provider contract is verified.

### D-025 — Phase 3 wider POS/back-office capabilities are accepted future work
**Status: ACCEPTED / NOT IMPLEMENTED**

The following capability groups are confirmed for future implementation, each through its own scoped issue/contract and deployment gate:

- inventory / recipe / COGS authority;
- accounting export/integration and eventual Accounting Agent boundary;
- provider-specific e-invoice integration after the Phase 2 contract/provider selection;
- discounts/promotions/loyalty;
- real PSP integrations after provider contracts are selected;
- richer reports/operations analytics;
- technical decomposition of large UI orchestration where justified by accepted feature work, without a framework/architecture rewrite;
- explicit wider DeeDou Marketing/Accounting/local-AI integrations once cross-system contracts exist.

Acceptance of the phase does not authorize inventing detailed business rules. Missing units, accounting treatment, provider behavior, discount precedence, loyalty economics or analytics definitions must still be specified before coding.

## Inventory / recipe / menu provisioning

### D-026 — Real menu provisioning is coupled to recipe, cost and inventory deduction
**Status: ACCEPTED / NOT IMPLEMENTED**

Real Production menu provisioning will not be treated as isolated name/price entry. When the real menu is provisioned, DeeDou must also have the recipe/cost/inventory authority needed for sold items to deduct stock correctly.

The exact recipe/BOM structure, ingredient units, yield/waste treatment, direct-stock-item handling, costing method and inventory-consumption timing are **not yet defined** and must be specified in the dedicated inventory/recipe/COGS milestone rather than guessed during catalog entry.

Existing DD-012 catalog tables/contracts remain authoritative and should be reused/extended; do not create a second product/menu graph.

### D-027 — Broad UI/UX redesign follows core business/backend capability completion
**Status: ACCEPTED / NOT IMPLEMENTED**

Admin/POS/QR visual and interaction redesign is intentionally deferred until the confirmed operational/business backend phases stabilize. UI-only changes should reuse existing contracts; backend/schema changes require a proven capability gap.

## How decisions change

A binding decision may be changed only when:

1. the user explicitly approves the new rule, or a repository issue/decision records it;
2. affected modules/API/database consumers are reviewed;
3. `DECISIONS.md` is updated with supersession/migration notes;
4. code/tests/docs change consistently.
