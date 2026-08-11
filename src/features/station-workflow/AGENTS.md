# station-workflow instructions

This feature owns KDS/station preparation workflow only.

Keep preparation, serving, and billing concerns separate:

- Preparation: `QUEUED -> ACKNOWLEDGED -> PREPARING -> READY`.
- Serving: owned by FOH/staff flows through ordering service-progress APIs.
- Billing: owned by cashier/payment flows through bill quantity APIs.

Do not add localStorage, DOM event binding, payment behavior, admin CRUD, table management, or broad station taxonomy redesign here.

Import order-domain invariants through `src/features/ordering/index.js`. Use the public `product-options` summary helper only for displaying configured line options.
