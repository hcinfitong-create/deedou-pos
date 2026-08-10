# staff-orders

This feature owns the staff-facing order board boundary for DeeDou.

DD-002 moved staff-specific presentation, selectors, metrics, and action presentation out of `app.js` while keeping persistence and application orchestration outside the feature.

The module must consume order transition rules through the public `ordering` API and must not own cashier payment logic or station queue workflow.

Public API:

- `STAFF_ORDER_COLUMNS`
- `staffOrderMetrics`
- `ordersByStaffColumn`
- `staffOrderActions`
- `renderStaffPage`
- `renderStaffOrderCard`
- `renderStaffEventCard`
