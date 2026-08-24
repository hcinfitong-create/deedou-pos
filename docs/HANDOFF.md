# DeeDou Handoff

> Dynamic session-to-session handoff. Read this at the start of every new DeeDou coding conversation, then verify it against current GitHub/source state.

## How to resume safely

Before implementing anything:

1. Read `docs/PROJECT_STATE.md`.
2. Read `docs/CODING_RULES.md`.
3. Read `docs/DECISIONS.md`.
4. Read `docs/ARCHITECTURE.md` and `docs/MODULE_MAP.md` for affected modules.
5. Inspect the current branch/PR/commit and CI.
6. Read current implementation + relevant tests/migrations.
7. Compare repository state with this handoff.
8. Only then code/debug.

## Current repository state

Current `main` source review: `0639d829f2645ce5efed2338550352583d526e63`.

DD-011B and DD-012C are merged, deployed and Production-verified.

Recent completion sequence:

- PR #48 — `DD-011B: single Owner and backend-managed device activation` → merge `834049bb89a08968e5f69d77f9bb3718ba908d5b`;
- PR #49 — `Hotfix DD-011B: allow Owner AAL2 re-challenge with active device` → merge `ff615b5874c0ad1ff9379c0eb2c6b8a9b98b7675`;
- PR #46 — `DD-012C: authoritative combo component management` → accepted head `27fa5c8219ad066bf21e3e02a33b1e803768535f`, merge `b282a0cd859b122fc6df4d065e5b9c496a5af537`;
- PR #51 — final DD-012C docs sync → merge `0639d829f2645ce5efed2338550352583d526e63`.

Production Supabase project: `nwohsyzpmogqjbmknwbl`.

Current verified baseline:

- one active OWNER assignment;
- one active ADMIN workstation device;
- one active backend workstation-device session;
- `backend_device_sessions_required = true`;
- DD-012C schema/RPCs present;
- zero real Production products/components/orders;
- no hosted-smoke fixtures retained.

## Protected behavior — do not regress

- PostgreSQL authority in hosted Supabase mode.
- direct-write/RLS/ACL denial.
- public QR unauthenticated flow.
- existing DD-008 operational command contracts.
- table-session authority from DD-004/DD-010A.
- KDS `prepStatus` workflow and FOH serving separation.
- append-only payment ledger and bounded refund semantics.
- immutable historical configured-order/component snapshots.
- sole OWNER and Owner AAL2 requirements.
- no JS-readable device secret.
- backend-device-session enforcement remains authoritative.
- an Owner whose Auth session returns to AAL1 must receive the TOTP re-challenge path.
- `product_components` remains the canonical component graph; do not introduce a parallel combo/menu model.

## Current working phase — Phase 1

**Production operational hardening — Issue #40.**

This is the active priority. Before feature implementation, inspect current Production evidence for:

1. backup posture;
2. RPO/RTO;
3. restore drill;
4. final Auth Site URL / redirect allowlist;
5. public-signup posture;
6. leaked-password protection;
7. rate-limit policy/enforcement for public QR, Auth and privileged Admin surfaces;
8. audit/log retention/access/redaction.

Do not claim a control is missing or complete until current Supabase/Vercel/repository evidence is inspected.

If a required control needs a paid plan, provider choice, irreversible policy choice or credential, surface that decision to the user rather than inventing it.

Real menu/business-data provisioning is a later go-live/data phase and does not replace the Phase 1 operational controls.

## Phase 2 — accepted next functional work

After Phase 1, create/execute a dedicated billing/VAT/service-fee/e-invoice milestone.

Binding product direction:

- VAT/e-invoice is an explicit Cashier option when the customer requests it;
- it is not automatically applied to every bill;
- current intent is +8% VAT and +2% service fee when the option is selected;
- do not hard-code the rates/treatment until current Vietnamese tax/e-invoice law, tax base, rounding, accounting and provider/API contracts are verified;
- preserve append-only payment history and existing KDS/order/table-session history.

Provider-specific e-invoice integration requires an explicit provider/API contract.

## Phase 3 — accepted future scope

Confirmed for future implementation through separate issues/contracts:

- inventory / recipe / COGS authority;
- accounting export/integration and eventual Accounting Agent boundary;
- e-invoice provider integration after the billing contract/provider choice;
- discounts/promotions/loyalty;
- real PSP integration after provider selection;
- richer reports/operations analytics;
- bounded technical decomposition justified by accepted feature work;
- wider DeeDou AI/system integrations once cross-system contracts exist.

## Real menu provisioning is coupled to inventory/recipe/cost

Do **not** proceed from the current empty Production catalog directly to real menu entry as a standalone task.

Accepted requirement:

- menu provisioning must include the recipe/cost/inventory authority required for sold items to deduct stock correctly;
- the exact BOM/recipe model, ingredient units, yield/waste, direct-stock handling, costing method and consumption timing are not yet specified and must be decided in the inventory milestone;
- real business data must come from the user;
- DD-012 catalog authority should be extended/reused, not replaced.

## UI/UX sequencing

Broad Admin/POS/QR UI/UX redesign is deferred until the confirmed backend/business phases stabilize. UI may reuse existing contracts; backend/schema changes need a proven capability gap.

## Next concrete action

1. Merge the docs-only roadmap/decision confirmation after verifying the diff is documentation only.
2. Audit current Production against Issue #40 and classify every checkbox as already satisfied, missing, or requiring user/provider/cost decision.
3. Implement/verify Phase 1 controls sequentially; do not mix Phase 2 code into the same PR.
4. After Phase 1 closes, perform current legal/tax/accounting/provider research and open the dedicated Phase 2 implementation issue/PR plan.
5. Do not populate real menu data or start broad UI/UX redesign in the meantime.

## Handoff template for future sessions

When ending a substantial session, refresh these fields:

- **Current state:**
- **Completed work:**
- **Current branch / PR / head:**
- **Files changed:**
- **Decisions made:**
- **Known issues:**
- **Tests performed:**
- **CI / hosted acceptance:**
- **Pending work:**
- **Next action:**
