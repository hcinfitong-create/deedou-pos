# DeeDou Module Map

This map adapts the requested feature-module architecture to the current static DeeDou QR Ordering app. It intentionally avoids empty architecture.

## Current Runtime Model

- Browser-only static app.
- Hash routes in `index.html`.
- State stored in `localStorage`.
- Cross-tab sync through `BroadcastChannel`.
- Supabase/PostgreSQL foundation files exist for DD-008A. DD-008B adds staff auth/RBAC gates for `SUPABASE` mode.
- `LOCAL_DEMO` remains local-first. No authoritative backend business mutations, React, Next.js, or build system yet.

## Dependency Direction

```text
app
↓
features
↓
shared
```

Feature modules may import from `shared`. Feature modules should use another feature module through that module's public `index.js` API.

## Feature Modules

### customer-menu

Owns:

- Customer-facing menu categories.
- Product card/menu presentation.
- Customer menu filtering and sold-out presentation.
- Bilingual menu labels for the customer menu.
- Static demo catalog seeds while the app is local-first.

Does not own:

- Cart rules.
- Order creation.
- Payment.
- Kitchen/bar workflow.
- Admin product editing.

Current files:

- `src/features/customer-menu/index.js` after Phase B.

Future files when extracted:

- `components/`
- `queries/`
- `types/`
- `tests/`

### cart

Owns:

- Customer cart item quantity rules.
- Cart totals before order submission.
- Cart UI.
- Cart submit validation before order submission.
- Cart clear/remove helpers for the local-first app.

Current location:

- `src/features/cart/index.js`

Notes:

- DD-005 lets cart line identity include product ID, selected variant, and canonical modifier selections.
- Legacy `{ id, qty }` cart lines remain readable.
- Cart estimates configured subtotal from the current catalog, while submitted order-line snapshot pricing is created by `ordering` through `product-options`.

### customer-orders

Owns:

- Customer-facing order status display.
- Customer order history/status strip.
- Customer-facing submitted order presentation.

Current location:

- `src/features/customer-orders/index.js`

### service-requests

Owns:

- Call staff and request bill events.
- Service request state transitions.
- Customer service request action UI.

Current location:

- `src/features/service-requests/index.js`

### ordering

Owns:

- Order line contracts.
- Bill quantity calculation.
- Combo expansion rules.
- Order totals.
- Service context normalization and validation:
  - `serviceMode`: `COUNTER_SERVICE` or `TABLE_SERVICE`.
  - `fulfillmentType`: `DINE_IN` or `TAKEAWAY`.
  - `orderSource`: `CUSTOMER_QR`, `STAFF`, or `COUNTER`.
  - Physical `zone`/`table` context when table service requires it.
- Machine-readable order timestamps used by operations views.
- Line-level operational identity (`lineId`) for item-level service actions.
- Line-level preparation state (`prepStatus`) as the canonical KDS source of truth.
- Line-level serving progress (`servedQty`) independent from bill quantity.
- Order status normalization.
- Direct order status transition guards.
- Station-derived aggregate order readiness and service completion.
- Persisted line course/hold/fire fields supplied by `course-workflow`.
- Configured order-line price snapshot creation through the public `product-options` API.

Does not own:

- Customer product card UI.
- Cashier payment capture.
- Admin product editing.
- Kitchen/bar/dessert presentation.
- Kitchen/bar/dessert ticket selection/rendering.

### product-options

Owns:

- Product variant normalization and validation.
- Modifier group/option normalization and validation.
- Configured selection canonicalization.
- Configured cart identity keys.
- Catalog-derived configured unit-price calculation.
- Immutable option snapshots for submitted order lines.
- Option summary helpers for customer, cashier, staff, and KDS displays.

Does not own:

- Menu filtering or category definitions.
- Cart quantity state.
- Order status or station preparation.
- Payment, split, refund, or void behavior.
- Admin product form DOM or localStorage persistence.

Current location:

- `src/features/product-options/index.js`

Admin note:

- DD-005 keeps the admin option editor as validated JSON inside the existing `admin-menu` area in `app.js`. A richer structured editor should be extracted later with `admin-menu`.

Current files:

- `src/features/ordering/index.js` after Phase B.

### course-workflow

Owns:

- Course normalization.
- Line/family `HELD` / `FIRED` release state.
- Service-family selection for billable roots plus their operational station components.
- Course assignment, hold, fire, and whole-course fire guards.
- FOH course summaries and read-only/editable state decisions.

Does not own:

- `prepStatus` transitions or KDS button effects.
- Serving quantity, bill quantity, pricing, payment, split, refund, or void behavior.
- Table-session lifecycle.
- Product option pricing or snapshots.
- Customer-facing course selection.

Current location:

- `src/features/course-workflow/index.js`

Notes:

- Missing legacy `holdState` means `FIRED`; missing legacy `course` means immediate service.
- Combo parents are the service-family root. Generated station child components inherit course and hold/fire state, but remain non-billable operational components.
- Fire release does not skip preparation. It only makes queued operational lines KDS-eligible.

### table-session

Owns:

- Business meaning of an active dining visit at a table.
- Table session normalization.
- Open/reuse rules and the one-open-session-per-table invariant.
- Stable session identity with injectable generation for tests.
- Attaching table-service order batches to an active session.
- Selecting active sessions, session orders, and floor-plan view models.
- Deterministic close/reconciliation.
- Table transfer to a vacant physical table.
- Legacy active table-order runtime backfill.

Current location:

- `src/features/table-session/index.js`

Does not own:

- Physical table CRUD or QR token regeneration.
- Payment, split, refund, or void business rules.
- Station/KDS preparation.
- Item-level serving.
- Persistence, audit logging, DOM binding, realtime sync, or table merge/join.

### staff-orders

Owns:

- Staff board.
- Staff-facing order metrics and selectors for new orders, table-service open orders, counter/cafe open orders, ready-to-serve orders, unresolved service/payment requests, and open physical tables by zone.
- Staff action presentation for order acceptance/rejection and served confirmation.
- Staff service request completion presentation.
- Staff presentation of service mode, fulfillment type, source, zone/table context, and order age when machine-readable timestamps exist.
- Staff-facing ready-to-serve line selectors and presentation.
- FOH presentation for serving one ready line/quantity and counter/takeaway serve-all-ready handoff.
- FOH presentation for course assignment, hold, fire, and whole-course fire controls through `course-workflow`.

Current location:

- `src/features/staff-orders/index.js`

Does not own:

- Persistence or localStorage.
- Payment capture.
- Kitchen/bar/dessert station queue internals.
- Table definitions.
- Course/hold/fire business rules.

### station-workflow

Owns:

- Station/KDS ticket selection.
- Station-specific preparation action model.
- KDS ticket derivation.
- Ticket age/wait age.
- Thin reusable Kitchen, Bar, and Dessert rendering.
- KDS grouping by station and course for fired lines.

Does not own:

- Serving progress or FOH delivery.
- Billing quantity, payment, split, refund, or void logic.
- Menu/admin CRUD.
- Table definitions or table-session behavior.
- Course assignment or hold/fire decisions.

Current location:

- `src/features/station-workflow/index.js`

Notes:

- Preparation state is `prepStatus`: `QUEUED -> ACKNOWLEDGED -> PREPARING -> READY`.
- KDS must never set `SERVED`.
- `stationStatus` remains a readable compatibility summary derived from line preparation state.
- KDS eligibility requires a station line to be fired by `course-workflow`; held lines are not active prep workload.

### kitchen

Owns:

- Kitchen queue display.
- Kitchen station item transitions.

Current location:

- Thin route composition remains in `app.js`; shared KDS selection/rendering and prep action model live in `station-workflow`.

### bar

Owns:

- Bar queue display.
- Bar station item transitions.

Current location:

- Thin route composition remains in `app.js`; shared KDS selection/rendering and prep action model live in `station-workflow`.

### dessert

Owns:

- Dessert queue display.
- Dessert station item transitions.

Current location:

- Thin route composition remains in `app.js`; shared KDS selection/rendering and prep action model live in `station-workflow`.

### admin-menu

Owns:

- Admin menu form.
- Product availability toggle.
- Product CRUD in local demo storage.
- Product image input and preview.

Current location:

- Still inside `app.js`.

### admin-tables

Owns:

- QR links by table.
- Future table CRUD.

Current location:

- Still inside `app.js` and shared table config.

### service-periods

Owns:

- Morning, afternoon, evening availability logic.

Current location:

- `currentPeriod` and product periods in `app.js`/customer menu data.

### payments

Owns:

- Append-only payment ledger normalization and duplicate transaction id handling.
- Legacy payment, refund, and `paidVnd`-only normalization.
- Payment summaries: bill total, gross paid, voided payments, effective paid, refunded, net collected, outstanding, refundable, and payment status.
- Partial, mixed-tender, and split-tender allocation rules.
- Table-level tender allocation across current-session orders, oldest first.
- Payment void and targeted refund rules.
- Bill quantity editing and order void guards once effective payment exists.
- `paidVnd` compatibility projection from the ledger.

Current location:

- `src/features/payments/index.js`
- Cashier DOM binding, prompts, audit, localStorage persistence, and button rendering remain in `app.js`.

Does not own:

- KDS preparation workflow.
- Item-level serving.
- Menu price calculation or billable quantity totals.
- Payment provider settlement callbacks.
- Table-session lifecycle.

### reports

Owns:

- Revenue, paid order history, audit/report views.

Current location:

- Cashier summary and audit panels in `app.js`.

## Shared Infrastructure

### shared/config

Owns:

- Storage keys.
- Current static table definitions.
- Current static station definitions.
- Current station aliases.

Review:

- Storage keys are infrastructure configuration and may remain here.
- Table definitions are business-domain data. Recommended future owner: `admin-tables` for table setup and `table-session` for active dining visit semantics.
- Station definitions are business-domain/operations data. Recommended future owner: station/operations modules such as `kitchen`, `bar`, `dessert`, or a narrow operations config module.
- Station aliases support legacy normalization. Recommended future owner: `ordering` or a station-normalization module once station extraction begins.
- Service mode, fulfillment type, and order source are not shared config; they are order-domain contracts owned by `ordering`.
- These definitions were not moved in the cart/customer-orders/service-requests phase because none of those modules should own table or station definitions.

### shared/i18n

Owns:

- Shared VI/EN copy used by the static app.

### shared/utils

Owns:

- Generic formatting and string helpers.

Must not own:

- Order-specific pricing rules.
- Menu-specific filtering rules.
- Payment rules.

### shared/backend

Owns:

- Backend mode/config normalization.
- Public/publishable Supabase client setup boundary.
- Connection state and backend health probe helpers.
- Supabase local development documentation.

Current location:

- `src/shared/backend/index.js`
- `src/shared/backend/config.js`
- `src/shared/backend/connection.js`

Does not own:

- Order/payment/table-session/KDS/service-request business rules.
- Staff login, RBAC, PIN, or permission UI.
- Authoritative writes or production realtime behavior.
- Service role keys, database credentials, JWT secrets, or private keys.

Notes:

- Default mode is `LOCAL_DEMO`.
- `SUPABASE` mode must be explicitly configured with public URL plus publishable key.
- Connection state must not report `ONLINE` from browser network status alone.
- DD-008B owns staff auth/RBAC and fail-closed staff route presentation. DD-008C/D own authoritative business command RPCs, realtime, and reconnect workflows.

### shared/db

Supabase/PostgreSQL schema foundation exists under `supabase/`, but it is not runtime-authoritative yet.

### shared/auth

Owns:

- Browser staff login/logout/auth gate presentation for `SUPABASE` mode through the `@supabase/supabase-js` managed lifecycle.
- Staff route-to-permission/workstation intent mapping.
- Client-side normalization for staff context and authorization RPC results.
- Opaque workstation identity storage after a server-issued one-time credential is registered.
- Documentation of role-to-permission matrix.

Current location:

- `src/shared/auth/index.js`
- `src/shared/auth/README.md`

Does not own:

- Authoritative permission decisions; those live in Supabase RPC/RLS helpers.
- Business mutations for orders, payments, KDS, service requests, or table sessions.
- Supabase access/refresh token copying, service role keys, admin Auth API calls, password/PIN storage, or production secrets.
- Visible normal-login device token entry or browser-generated workstation credentials.
- Staff invitation/MFA UX beyond documented future scope.

### shared/realtime

Not created yet. Current `BroadcastChannel` logic remains in the app shell until a durable realtime boundary is needed.

### shared/types

Not created yet. This repository is JavaScript, not TypeScript. Introduce this when TypeScript is added.

## Server Infrastructure

DD-008A adds committed Supabase local development infrastructure:

- `supabase/config.toml`
- `supabase/migrations/20260812000000_dd008a_backend_foundation.sql`
- `supabase/seed.sql`

The schema prepares tables, RLS, public-safe projections, idempotency support, and append-oriented audit/payment foundations. No server runtime or production deployment is added.

Future candidates:

- `server/supabase`
- `server/security`
- `server/logging`
- `server/rate-limit`

## Current Public APIs

Current:

- `src/shared/config/index.js`
- `src/shared/i18n/index.js`
- `src/shared/utils/index.js`
- `src/features/customer-menu/index.js`
- `src/features/product-options/index.js`
- `src/features/course-workflow/index.js`
- `src/features/ordering/index.js`
- `src/features/cart/index.js`
- `src/features/customer-orders/index.js`
- `src/features/service-requests/index.js`
- `src/features/staff-orders/index.js`
- `src/features/station-workflow/index.js`
- `src/features/table-session/index.js`
- `src/features/payments/index.js`
- `src/shared/backend/index.js`
- `src/shared/auth/index.js`

## Protected Modules By Common Task

Change customer menu layout:

- Target: `customer-menu`
- Protected: `ordering`, `payments`, `kitchen`, `bar`, `reports`, `admin-tables`

Change bill quantity reconciliation:

- Target: `ordering` plus cashier UI
- Protected: `customer-menu`, `admin-menu`, kitchen/bar display unless station counts change

Change payment method:

- Target: `payments` plus cashier UI
- Protected: `customer-menu`, `cart`, `kitchen`, `bar`, `admin-menu`

Change station workflow:

- Target: `station-workflow`, `staff-orders`, `course-workflow`, and `ordering` status/service contracts
- Protected: `customer-menu`, `admin-menu`, `payments` unless status affects payable state

Change table session or floor occupancy:

- Target: `table-session` plus app shell wiring for persistence/audit/DOM
- Protected: `station-workflow`, item-level serving, payment provider/split/refund rules, menu/admin CRUD, physical table CRUD, and table merge/join

Change staff auth/RBAC:

- Target: `shared/auth` plus Supabase auth/RBAC migrations/tests and app route gate wiring
- Protected: public QR/menu functions, LOCAL_DEMO behavior, order/payment/KDS/table-session business rules, service role/admin auth APIs, and DD-008A migration history
