# Payments Feature Guardrails

Owns payment ledger normalization, summaries, allocation, void/refund, bill lock, and compatibility projections.

Allowed dependencies: shared primitives only when genuinely generic. Keep this module pure and independent from DOM, storage, table-session, station-workflow, kitchen/bar/dessert, staff UI, and admin UI.

Protected behavior:
- Ledger entries are append-only.
- Duplicate transaction ids must be no-ops.
- Refund amounts are positive and target original payment ids.
- `paidVnd` is derived from ledger totals.
- Payment status must not prematurely close operational orders before service is complete.

Tests should cover partial/mixed payments, split allocation, payment voids, refunds, legacy normalization, bill locking, and KDS/service-state separation.
