# customer-orders

Responsibility: customer-facing order status and submitted order history presentation.

Does not own order creation, menu UI, payment processing, or station workflow.

Allowed dependencies: `src/shared/*`; receive order arrays and copy/lang from callers.

Prohibited dependencies: payments, staff-orders, kitchen/bar/dessert internals, admin internals.

Public interface: export through `index.js`.

Tests: prioritize status label rendering and table-scoped order history.

