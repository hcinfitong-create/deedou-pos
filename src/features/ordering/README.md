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
- Station status derivation.
- Aggregate readiness derivation from required station/item readiness.
- Machine-readable operational timestamps:
  - `createdAt`
  - `acceptedAt`
  - `prepStartedAt`
  - `readyAt`
  - `servedAt`
- Order and item status normalization.
- Order item count helpers.
- Deterministic direct order status transition guards.
- Optional contract hooks for course, hold/fire state, seat, target station, prep time, and ticket-age alerts.

## Does Not Own

- Customer menu UI.
- Cashier payment capture.
- Admin product editing.
- Kitchen/bar/dessert presentation.
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
- `applyOrderStatusTransition`
- `applyStationStatusUpdate`
- `deriveOrderStatusFromStations`
- `isOpenPhysicalTableOrder`

## Dependencies

No feature dependencies.

## Database Tables Used

None. Current persistence is browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

Keep this module pure and framework-independent. Do not add browser storage or DOM access here. Invalid direct status transitions and invalid station workflow updates should return a failed result without mutating the order.

## Tests

Module tests cover totals, bill quantity adjustment, status normalization, combo routing, service context validation, source normalization, machine-readable timestamp normalization, station-derived readiness, combo/meta readiness exclusion, and direct order transition guards.
