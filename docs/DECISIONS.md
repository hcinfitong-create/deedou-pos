# DeeDou Accepted Decisions

> This file records decisions that must not be silently reversed. It is not a wishlist.
>
> Status labels:
> - **IMPLEMENTED** — represented in current repository/runtime.
> - **ACCEPTED / IN PROGRESS** — explicitly accepted and currently being implemented.
> - **ACCEPTED / NOT IMPLEMENTED** — product decision exists but code is not yet present.
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
**Status: IMPLEMENTED / IN PROGRESS**

Use `products`, `product_variants`, `modifier_groups`, `modifier_options`, `product_modifier_groups`, `product_components`. Do not create a parallel catalog/combo model.

### D-013 — Historical submitted order snapshots are immutable
**Status: IMPLEMENTED**

Catalog edits must not rewrite submitted order-line pricing/options/component snapshots.

### D-014 — Do not invent production menu data
**Status: ACCEPTED**

Real DeeDou menu provisioning must use user-provided business data. Implementation/tests may use run-scoped fixtures, but production catalog values must not be guessed.

## Identity / security

### D-015 — Exactly one active OWNER globally
**Status: ACCEPTED / IN PROGRESS (DD-011B)**

No second active OWNER may be granted. The sole Owner account/role/location cannot be deactivated/revoked through normal application flows.

### D-016 — Owner privileged security actions require AAL2
**Status: ACCEPTED / IN PROGRESS**

Owner controls MFA/TOTP. Staff creation, activation approval, role changes, device revoke/rotate and account/location security mutations require Owner AAL2 according to the DD-011B contract.

### D-017 — Staff identity uses Name + username + role/location
**Status: ACCEPTED / IN PROGRESS**

Staff has `display_name` and unique case-insensitive `username`. Owner creates staff with Name + username + temporary password + initial role/location. Do not create a parallel user identity system.

### D-018 — Password login alone does not trust a new staff device
**Status: ACCEPTED / IN PROGRESS**

First login/new device creates a short-lived 6-digit verification challenge. Owner compares the code and explicitly approves. Pending staff/device is not operationally trusted before approval.

### D-019 — Device trust is backend-managed
**Status: ACCEPTED / IN PROGRESS**

Device secrets/session proof must not be stored in localStorage/sessionStorage/IndexedDB or exposed to frontend JavaScript. Trust uses backend-managed device session state plus Secure/HttpOnly/SameSite cookie proof. Revoke/disable takes effect on subsequent staff requests.

### D-020 — Manager cannot mint Owner/device trust
**Status: ACCEPTED / IN PROGRESS**

Role/device issuance is Owner-authoritative. Manager can retain explicitly granted operational permissions but cannot create/grant Owner or issue trusted device access.

## Billing / e-invoice product direction

### D-021 — VAT/e-invoice is an explicit checkout option, not automatic for every bill
**Status: ACCEPTED / NOT IMPLEMENTED**

User-confirmed product direction: normal orders do not automatically trigger the VAT/e-invoice flow; Cashier has an explicit option when the customer requests VAT/e-invoice.

### D-022 — Requested VAT flow currently targets +8% VAT and +2% service fee
**Status: ACCEPTED / NOT IMPLEMENTED — REQUIRES LEGAL/TAX VALIDATION BEFORE CODING**

The intended POS behavior discussed by the user is: when the VAT option is selected, add 8% VAT and 2% service fee. This records product intent only; it is **not a statement that the rates/treatment are legally correct for the eventual entity, goods/services or date**. Before implementation, verify current Vietnamese tax/e-invoice requirements and define rounding/accounting/API contracts. Do not hard-code this rule solely from memory.

## How decisions change

A binding decision may be changed only when:

1. the user explicitly approves the new rule, or a repository issue/decision records it;
2. affected modules/API/database consumers are reviewed;
3. `DECISIONS.md` is updated with supersession/migration notes;
4. code/tests/docs change consistently.
