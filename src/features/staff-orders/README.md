# staff-orders

This feature owns the staff-facing order board boundary for DeeDou.

DD-002 will move staff-specific presentation/selectors out of `app.js` while keeping persistence and application orchestration outside the feature.

The module must consume order transition rules through the public `ordering` API and must not own cashier payment logic or station queue workflow.
