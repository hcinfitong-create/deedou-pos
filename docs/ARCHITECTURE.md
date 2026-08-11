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
      -> features/station-workflow
```

The current router is hash-based:

- `#/t/<tableToken>` customer QR order.
- `#/cashier` cashier POS.
- `#/staff` staff board.
- `#/bar` bar queue.
- `#/kitchen` kitchen queue.
- `#/dessert` dessert queue.
- `#/admin` admin control center.

## Hybrid Service Context

Orders now carry explicit service context so DeeDou can support both cafe/counter service and restaurant/table service without fake table records.

- `serviceMode` describes how the order is operated: `COUNTER_SERVICE` or `TABLE_SERVICE`.
- `fulfillmentType` describes how the guest receives the order: `DINE_IN` or `TAKEAWAY`.
- `orderSource` describes who captured it: `CUSTOMER_QR`, `STAFF`, or `COUNTER`.
- `zone` and `table` describe the physical service area only when a physical table is involved.
- Aggregate `order.status` is separate from station preparation, serving progress, and billing progress.
- Line-level `prepStatus` is the canonical preparation source of truth for KDS: `QUEUED -> ACKNOWLEDGED -> PREPARING -> READY`.
- Line-level `servedQty` tracks FOH delivery to guests and is independent from `billQty`.
- Overall `READY` is derived when all remaining unserved required lines are prep-ready. Overall `SERVED` is derived only when all serviceable quantities are fully served.

Counter/takeaway orders may have no table. Takeaway is a fulfillment type, not a physical service area.

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
- `features/station-workflow`

Larger UI decomposition should come later, after each phase validates.

## Current Known Coupling

`app.js` still owns broad page composition, event binding, localStorage orchestration, admin actions, cashier actions, payments, reports, and station persistence orchestration. Cart rules/UI, customer order status presentation, customer service request event creation, ordering contracts, staff board presentation/selectors, and station/KDS rendering/selectors now live behind feature public APIs.
