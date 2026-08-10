# staff-orders

Responsibility: staff-facing order board presentation, staff order selectors/metrics, and staff action presentation.

Does not own payment capture, cashier table aggregation, station queue internals, admin menu CRUD, or persistence.

Allowed dependencies: `src/shared/*` and public APIs from `src/features/ordering/` where needed.

Prohibited dependencies: direct `localStorage`, payment internals, admin internals, private implementation files from other features.

Public interface: export through `index.js`.

Tests: prioritize staff metrics/selectors, rendering decisions, and valid staff action availability.
