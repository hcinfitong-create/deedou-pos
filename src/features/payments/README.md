# DeeDou Payments

This feature owns payment ledger business rules for the local DeeDou POS demo.

## Responsibilities

- Normalize legacy payment records into an append-only ledger.
- Derive payment totals, outstanding balance, refundable balance, and payment status.
- Record partial, split, mixed-tender, table-allocated payments.
- Record payment voids and targeted refunds without mutating historical transactions.
- Expose bill-locking and void eligibility guards for cashier flows.
- Maintain `paidVnd` as a compatibility projection from the ledger.

## Non-Responsibilities

- Order prep/service state transitions.
- KDS station workflow.
- Final menu pricing or billable quantity calculation.
- Table-session lifecycle rules.
- Payment provider integration or settlement callbacks.
- DOM rendering, localStorage, audit logs, or browser routing.

## Public API

Import from `src/features/payments/index.js`.

The module is framework-independent and expects callers to pass plain order objects. Mutating commands append ledger transactions to the provided order and then refresh payment projections.

