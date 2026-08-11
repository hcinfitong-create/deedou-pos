# table-session

Responsibility: pure table-session domain rules for one active dining visit at one physical table.

Does not own physical table CRUD, payments, station/KDS prep workflow, item-level serving, DOM binding, localStorage, audit logging, or realtime sync.

Allowed dependencies: public APIs from `src/features/ordering/index.js` for order service context, open/closed status, service progress, and item counts.

Prohibited dependencies: DOM, `localStorage`, cashier payment internals, admin internals, station-workflow internals, or private files from another module.

Public interface: export through `index.js`; prefer explicit `{ ok, ... }` results and deterministic `now`/ID injection in tests.

Tests: prioritize one-open-session-per-table, table-service attachment, counter/takeaway no-session, customer-history isolation selectors, service request association, floor-plan view models, close/reconciliation, transfer invariants, and DD-003 prep/serving non-regression.
