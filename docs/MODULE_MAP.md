# DeeDou Module Map

This map adapts the requested feature-module architecture to the current static DeeDou QR Ordering app. It intentionally avoids empty architecture.

## Current Runtime Model

- Browser-only static app.
- Hash routes in `index.html`.
- State stored in `localStorage`.
- Cross-tab sync through `BroadcastChannel`.
- No backend, database, auth, migrations, React, Next.js, or build system yet.

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
- Order status normalization.
- Station status derivation.

Does not own:

- Customer product card UI.
- Cashier payment capture.
- Admin product editing.

Current files:

- `src/features/ordering/index.js` after Phase B.

### table-session

Owns:

- Business meaning of an active dining visit at a table.
- Opening, viewing, closing, and transferring table context when implemented.

Current location:

- Not yet implemented as a distinct data object. Table state is inferred from open orders.

### staff-orders

Owns:

- Staff board.
- Order acceptance/rejection.
- Served confirmation.
- Service request completion.

Current location:

- Still inside `app.js`.

### kitchen

Owns:

- Kitchen queue display.
- Kitchen station item transitions.

Current location:

- Still inside `app.js`, sharing station rendering with bar and dessert.

### bar

Owns:

- Bar queue display.
- Bar station item transitions.

Current location:

- Still inside `app.js`.

### dessert

Owns:

- Dessert queue display.
- Dessert station item transitions.

Current location:

- Still inside `app.js`.

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

- Payment requests.
- Payment method transitions.
- Split bill.
- Refund.
- Void at bill/payment layer.

Current location:

- Still inside cashier functions in `app.js`.

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

### shared/db

Not created yet. No database exists.

### shared/auth

Not created yet. No auth exists.

### shared/realtime

Not created yet. Current `BroadcastChannel` logic remains in the app shell until a durable realtime boundary is needed.

### shared/types

Not created yet. This repository is JavaScript, not TypeScript. Introduce this when TypeScript is added.

## Server Infrastructure

Not created yet. There is no server runtime in the current repository.

Future candidates:

- `server/supabase`
- `server/security`
- `server/logging`
- `server/rate-limit`

## Current Public APIs

After Phase B:

- `src/shared/config/index.js`
- `src/shared/i18n/index.js`
- `src/shared/utils/index.js`
- `src/features/customer-menu/index.js`
- `src/features/ordering/index.js`
- `src/features/cart/index.js`
- `src/features/customer-orders/index.js`
- `src/features/service-requests/index.js`

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

- Target: `staff-orders`, `kitchen`, `bar`, `dessert`, `ordering` status contracts
- Protected: `customer-menu`, `admin-menu`, `payments` unless status affects payable state
