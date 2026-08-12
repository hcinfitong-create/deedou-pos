# staff-orders

This feature owns the staff-facing order board boundary for DeeDou.

DD-002 moved staff-specific presentation, selectors, metrics, and action presentation out of `app.js` while keeping persistence and application orchestration outside the feature.

The module must consume order transition rules through the public `ordering` API and must not own cashier payment logic or station queue workflow.

DD-002.1 makes the staff board service-aware:

- Table-service dine-in orders remain tied to physical `zone`/`table`.
- Counter/cafe orders can be dine-in or takeaway and do not require a table.
- Takeaway is displayed as a fulfillment type, not counted as an open physical table.
- Overall `READY` is not a staff direct action from `IN_PREPARATION`; it is derived by `ordering` from station/item readiness.
- Cards display service mode, fulfillment type, source, location context, and waiting age when `createdAt` is available.
- DD-003 adds FOH serving presentation:
  - ready-to-serve line/quantity selectors;
  - item-level service progress (`servedQty / qty`);
  - partial quantity service controls;
  - counter/takeaway serve-all-ready handoff presentation.
- Staff serving controls call ordering service-progress APIs through the app shell. This module does not mutate orders directly.
- KDS preparation remains owned by `station-workflow` and must not set `SERVED`.
- DD-004 lets staff open-table metrics consume active table sessions when the app shell provides them. Without session state, selectors keep the legacy order-based fallback for compatibility.
- DD-005 displays configured variant/modifier summaries for order lines using the public `product-options` summary helper.
- DD-006 displays course assignment plus Hold/Fire controls for table-service dine-in orders using public `course-workflow` helpers. Staff can assign/change course before preparation starts, hold queued family lines, fire held family lines, and fire a whole held course.
- Course/hold/fire controls are presentation only here; the app shell calls `course-workflow` mutations and then refreshes derived ordering/station summaries.

Public API:

- `STAFF_ORDER_COLUMNS`
- `staffOrderMetrics`
- `selectNewOrders`
- `selectTableServiceOpenOrders`
- `selectCounterServiceOpenOrders`
- `selectReadyToServeOrders`
- `selectReadyToServeLines`
- `selectUnresolvedServiceRequests`
- `selectOpenTablesByPhysicalZone`
- `ordersByStaffColumn`
- `staffOrderActions`
- `renderStaffPage`
- `renderStaffOrderCard`
- `renderStaffEventCard`
- `orderElapsedMinutes`
- `formatOrderAge`
