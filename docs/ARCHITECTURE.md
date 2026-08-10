# DeeDou Architecture

DeeDou is currently a browser-only static QR Ordering POS prototype. The code should evolve incrementally toward feature modules without rewriting the app from scratch.

## Architecture Goals

- Modularity.
- Feature isolation.
- Small change surface.
- Framework-independent business rules where practical.
- No empty folders for features that do not exist yet.

## Runtime

```text
index.html
  -> app.js
      -> shared/config
      -> shared/i18n
      -> shared/utils
      -> features/customer-menu
      -> features/ordering
      -> features/cart
      -> features/customer-orders
      -> features/service-requests
      -> features/staff-orders
```

The current router is hash-based:

- `#/t/<tableToken>` customer QR order.
- `#/cashier` cashier POS.
- `#/staff` staff board.
- `#/bar` bar queue.
- `#/kitchen` kitchen queue.
- `#/dessert` dessert queue.
- `#/admin` admin control center.

## Feature Module Rule

Each meaningful business capability should have an owner module under `src/features/`.

External code should import only from the feature module public API:

```js
import { billableTotal } from "./src/features/ordering/index.js";
```

Do not import from private implementation files once those exist.

## Shared Rule

Put code in `src/shared/` only when it is reusable across independent modules.

Allowed shared examples:

- Config constants.
- Storage keys.
- Generic formatting.
- HTML escaping.
- Generic i18n copy.

Not allowed in shared:

- Payment business rules.
- Order state transitions.
- Customer menu-only filtering.
- Admin product form rules.

## Change Isolation Workflow

Before non-trivial edits, identify:

- Target module.
- Files expected to change.
- Dependencies used.
- Protected/unrelated modules.
- Whether database migration is required.
- Whether public API changes.

## Current State

Phase A documentation has been added.

Phase B has extracted the first stable, low-risk modules:

- `shared/config`
- `shared/i18n`
- `shared/utils`
- `features/customer-menu`
- `features/ordering`
- `features/cart`
- `features/customer-orders`
- `features/service-requests`
- `features/staff-orders`

Larger UI decomposition should come later, after each phase validates.

## Current Known Coupling

`app.js` still owns broad page composition, event binding, localStorage orchestration, admin actions, cashier actions, payments, reports, and station workflow. Cart rules/UI, customer order status presentation, customer service request event creation, and staff board presentation/selectors now live behind feature public APIs.
