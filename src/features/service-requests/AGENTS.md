# service-requests

Responsibility: customer call-staff/request-bill UI and local service request event creation.

Does not own payment processing, staff order workflow, table definitions, or staff-side completion.

Allowed dependencies: shared utilities only if needed; receive table context from callers.

Prohibited dependencies: payments, staff-orders internals, admin internals, table-session internals.

Public interface: export through `index.js`.

Tests: prioritize event shape and customer action rendering.

