# customer-menu

Responsibility: customer menu structure, category metadata, demo catalog seeds, and customer-facing menu sort order.

Does not own cart rules, order creation, payments, station workflow, or admin editing behavior.

Allowed dependencies: `src/shared/*`.

Prohibited dependencies: `payments`, `kitchen`, `bar`, `staff-orders`, and admin internals.

Public interface: export through `index.js`.

Localization: keep VI/EN labels together for menu-owned labels.

Tests: add colocated tests when a test runner exists.

