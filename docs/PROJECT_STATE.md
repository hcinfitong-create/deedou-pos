# DeeDou Project State

> Dynamic source-of-truth summary. Update this file whenever a major PR/phase changes state.
>
> Last source review: 2026-08-24. Current `main` reviewed at `0639d829f2645ce5efed2338550352583d526e63` after DD-012C Production completion and final documentation sync.

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

Merged/production-complete work confirmed from GitHub/source/hosted state:

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
- DD-011B — sole Owner, username staff identity, Owner-approved activation and backend-managed device sessions.
- DD-012 Slice A — authoritative product-core Admin catalog.
- DD-012 Slice B — authoritative variants/modifiers and assignments.
- DD-012 Slice C — authoritative combo/component management using existing `product_components`.

## Current Production baseline

Production Supabase project: `nwohsyzpmogqjbmknwbl`.

Current verified security/catalog baseline after DD-012C rollout:

- one active OWNER assignment;
- one active ADMIN workstation device;
- one active backend workstation-device session;
- `dd011b_security_policy.backend_device_sessions_required = true`;
- DD-012C migration present;
- zero real Production products/components/orders;
- no test fixture menu data retained.

DD-011B and DD-012C are Production-complete. Their current contracts are protected regression baselines, not open feature branches.

## Current engineering priority — Phase 1

**Production operational hardening**, tracked by Issue #40.

This is the current priority before the next functional billing phase. Required work includes:

- choose and implement a Production backup posture;
- document RPO/RTO;
- perform and record a restore drill;
- verify final Supabase Auth Site URL and redirect allowlist;
- explicitly set/verify public signup posture;
- decide/configure leaked-password protection;
- define and verify rate limits for public QR, Auth and privileged Admin surfaces;
- define audit/log retention/access/redaction policy and verify sensitive secret/JWT/device material is not logged.

The real menu/business-data baseline is intentionally deferred and must not be used as a substitute for the operational controls above.

## Accepted next functional phase — Phase 2

After Phase 1, implement a dedicated **billing/VAT/service-fee/e-invoice checkout authority** milestone.

Accepted direction:

- VAT/e-invoice is an explicit Cashier option when requested by the customer, not an automatic charge on every bill;
- current product intent is +8% VAT and +2% service fee when that option is selected;
- current Vietnamese legal/tax/e-invoice rules, tax base, rounding, accounting treatment and provider/API contract must be verified before hard-coding;
- the implementation must preserve the append-only payment ledger and immutable historical order/KDS/table-session state.

## Accepted future phase — Phase 3

The wider capability roadmap is confirmed for future implementation, with each capability requiring its own scoped issue/contract:

- inventory / recipe / COGS authority;
- accounting export/integration and eventual Accounting Agent boundary;
- provider-specific e-invoice integration after the Phase 2 provider/contract decision;
- discounts/promotions/loyalty;
- real PSP integrations after provider selection;
- richer reports/operations analytics;
- bounded technical decomposition where justified by accepted feature work;
- explicit wider DeeDou AI/system integrations after cross-system contracts exist.

## Real menu provisioning rule

Real Production menu provisioning is deferred until the inventory/recipe/cost authority required for correct stock deduction is implemented.

When real menu provisioning occurs:

- do not treat menu setup as name/price entry only;
- provide the recipe/cost/inventory relationship needed for sold items to deduct stock correctly;
- define recipe/BOM, units, yield/waste, direct-stock handling, costing and consumption timing in the dedicated inventory milestone rather than guessing them during catalog setup;
- use only user-provided real business data;
- reuse/extend DD-012 catalog authority instead of creating a parallel menu graph.

## UI/UX sequencing

Broad Admin/POS/QR UI/UX redesign is intentionally later than the confirmed operational/business capability phases. Existing backend contracts should be reused; backend/schema changes are justified only by a proven capability gap.

## Protected production authority

- PostgreSQL is business authority for hosted Supabase mode.
- Browser direct writes to protected business/catalog/security tables are denied.
- Transactional RPCs are the authoritative mutation boundary.
- Realtime events are refresh hints, not state authority; clients refetch authoritative snapshots.
- LOCAL_DEMO remains separate. No authoritative dual-write between localStorage and PostgreSQL.
- Historical submitted order-line pricing/options/components are immutable snapshots.
- Staff protected requests require the DD-011B backend-managed device-session model when enforcement is enabled.
- OWNER privileged security paths require AAL2; an AAL1 Owner with an active device must still receive a TOTP re-challenge path.
- `product_components` remains the canonical combo/component model.

## Known coupling / technical debt

- `app.js` still owns broad route composition, DOM/event wiring and orchestration.
- Some Admin surfaces remain integrated in the app shell.
- Hosted/security smoke suites include DD-011B backend device-session trust. Future harness changes must preserve the no-JS-readable-device-secret rule and public QR bypass of staff security.
- Long-lived privileged sessions can return to AAL1 according to Supabase Auth/session lifecycle; UI must preserve the Owner re-challenge path added by PR #49.
- Technical decomposition must be driven by accepted feature work and remain incremental; no framework/architecture rewrite is authorized.

## Next action

1. Complete the Phase 1 Issue #40 evidence audit against the current Production configuration.
2. Implement only the verified missing Production operational controls, with explicit user/cost decisions where a paid service or policy choice is required.
3. Close Phase 1 only after backup/restore, RPO/RTO, Auth posture, rate limits and log/audit controls have evidence.
4. Then open/execute the Phase 2 billing/VAT/service-fee/e-invoice milestone after current legal/tax/accounting/provider validation.
5. Do not populate the real menu or start broad UI/UX redesign before the confirmed preceding phases are complete.

## Required maintenance

When finishing a major phase, update at least:

- this file (`PROJECT_STATE.md`);
- `HANDOFF.md`;
- `ROADMAP.md` if milestone state changed;
- `DECISIONS.md` if a new decision was explicitly accepted;
- `DATABASE.md` / `API_CONTRACTS.md` when schema/contracts change.
