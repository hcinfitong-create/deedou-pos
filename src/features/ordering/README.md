# ordering

## Purpose

Owns framework-independent order and bill calculation rules.

## Owns

- Hybrid service context normalization and validation:
  - `serviceMode`: `COUNTER_SERVICE` or `TABLE_SERVICE`.
  - `fulfillmentType`: `DINE_IN` or `TAKEAWAY`.
  - `orderSource`: `CUSTOMER_QR`, `STAFF`, or `COUNTER`.
  - `zone`/`table` only as physical service context.
- Bill quantity clamping.
- Charged quantity.
- Line subtotal.
- Order total recalculation.
- Stable per-order operational line identity (`lineId`).
- Preparation state normalization (`prepStatus`) as the canonical station/KDS source of truth.
- Serving progress (`servedQty`) independent from `billQty`.
- Station status compatibility summary derivation.
- Aggregate readiness/service derivation from required station/item readiness and served quantities.
- Machine-readable operational timestamps:
  - `createdAt`
  - `acceptedAt`
  - `prepStartedAt`
  - `readyAt`
  - `servedAt`
- Line-level operational timestamps:
  - `queuedAt`
  - `acknowledgedAt`
  - `prepStartedAt`
  - `readyAt`
  - `servedAt`
- Order and item status normalization.
- Order item count helpers.
- Deterministic direct order status transition guards.
- Optional contract hooks for course, hold/fire state, seat, target station, prep time, and ticket-age alerts.
- Configured order-line snapshots through the public `product-options` API.

## Does Not Own

- Customer menu UI.
- Cashier payment capture.
- Admin product editing.
- Kitchen/bar/dessert presentation.
- Staff/KDS DOM event binding.
- Payment provider, split, refund, or void behavior.

## Public API

Import from `src/features/ordering/index.js`.

Important DD-002.1 APIs:

- `normalizeOrderServiceContext`
- `buildCounterOrderServiceContext`
- `validateOrderServiceContext`
- `normalizeOrderSource`
- `normalizeOrderTimestamps`
- `normalizeOrderLineOperationalFields`
- `normalizePrepStatus`
- `normalizeServiceProgress`
- `getServiceProgress`
- `isLineFullyServed`
- `canServeLine`
- `serveLineQuantity`
- `serveAllReady`
- `deriveOrderOperationalStatus`
- `canTransitionPrepStatus`
- `applyPrepStatusTransition`
- `applyOrderStatusTransition`
- `applyStationStatusUpdate`
- `deriveOrderStatusFromStations`
- `isOpenPhysicalTableOrder`

## DD-003 Contract

Preparation state, serving progress, and billing progress are separate:

```text
prepStatus != servedQty != billQty
```

KDS preparation uses `QUEUED -> ACKNOWLEDGED -> PREPARING -> READY`. `SERVED` is not a preparation state. For legacy lines, `status: "SERVED"` normalizes to `prepStatus: "READY"` and `servedQty: qty`.

Table-service serving must use line/quantity service APIs. Counter/takeaway can use `serveAllReady(...)` as a deliberate handoff fast path. Direct `SERVED -> PAID` compatibility remains outside station workflow.

## Dependencies

Uses the public `product-options` API for configured line pricing/snapshots. Otherwise keep this module framework-independent and avoid UI/persistence dependencies.

## Database Tables Used

None. Current persistence is browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

Keep this module pure and framework-independent. Do not add browser storage or DOM access here. Invalid direct status transitions and invalid station workflow updates should return a failed result without mutating the order.

## Tests

Module tests cover totals, configured snapshots, bill quantity adjustment, status normalization, combo routing, service context validation, source normalization, machine-readable timestamp normalization, station-derived readiness, prep transition guards, item-level serving, partial service, combo/meta readiness exclusion, and direct order transition guards.
