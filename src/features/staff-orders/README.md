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

Public API:

- `STAFF_ORDER_COLUMNS`
- `staffOrderMetrics`
- `selectNewOrders`
- `selectTableServiceOpenOrders`
- `selectCounterServiceOpenOrders`
- `selectReadyToServeOrders`
- `selectUnresolvedServiceRequests`
- `selectOpenTablesByPhysicalZone`
- `ordersByStaffColumn`
- `staffOrderActions`
- `renderStaffPage`
- `renderStaffOrderCard`
- `renderStaffEventCard`
- `orderElapsedMinutes`
- `formatOrderAge`
