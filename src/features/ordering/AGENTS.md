# ordering

Responsibility: pure order contracts, status normalization, station status derivation, and bill calculation.

Does not own UI rendering, payment provider behavior, admin product editing, or kitchen/bar visual queues.

Allowed dependencies: shared utilities only when genuinely generic.

Prohibited dependencies: DOM, `localStorage`, payment capture internals, customer-menu internals.

Public interface: export through `index.js`; keep functions deterministic where practical.

Tests: prioritize module unit tests for totals, bill quantity adjustment, status transitions, and combo routing.

