# product-options

Responsibility: pure product option configuration, cart identity, configured pricing, and immutable order option snapshots.

Does not own menu presentation, cart quantity rules, order status, station/KDS workflow, payment, admin form rendering, persistence, or localStorage.

Allowed dependencies: none, unless a future helper is genuinely generic and comes from `src/shared/*`.

Prohibited dependencies: DOM, `localStorage`, customer menu filters, cashier payments, station workflow internals, table-session internals, or admin internals.

Public interface: export through `index.js`.

Tests: prioritize canonical selection keys, validation, configured unit pricing, immutable snapshots, and presentation summaries.
