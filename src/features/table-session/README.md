# table-session

Owns DeeDou's active dining visit model for physical tables.

## Owns

- Table session normalization.
- Opening or reusing one open session per physical table.
- Stable session identity with injectable ID generation.
- Attaching table-service order batches to an active session.
- Selecting orders and floor-plan models by session.
- Closing and deterministic reconciliation.
- Moving one open session to a vacant physical table.
- Legacy active table-order backfill without localStorage access.

## Does Not Own

- Physical table configuration or QR token CRUD.
- Order creation UI.
- Payment, split, refund, or void business rules.
- KDS preparation lifecycle.
- Item-level serving.
- Persistence, audit logging, DOM binding, or realtime transport.
- Table merge/join.

## Contract

```text
Physical Table != Table Session != Order Batch
```

Table-service dine-in orders carry `tableSessionId`. Counter service and takeaway orders do not create or require a table session.

## Public API

Import from `src/features/table-session/index.js`.

- `normalizeTableSession`
- `normalizeTableSessions`
- `getActiveTableSession`
- `selectOpenTableSessions`
- `openOrReuseTableSession`
- `attachOrderToTableSession`
- `selectOrdersForTableSession`
- `deriveTableFloorModels`
- `canCloseTableSession`
- `closeTableSession`
- `reconcileTableSessions`
- `canTransferTableSession`
- `transferTableSession`
- `backfillLegacyTableSessions`

## Dependencies

Uses public `ordering` APIs for service context, open/closed order status, service progress, and item counts.

## Tests

Focused unit tests cover open/reuse, legacy backfill, floor models, close/reconciliation, transfer invariants, customer history scoping, service request session IDs, and DD-003 prep/serving regression behavior on session-linked orders.
