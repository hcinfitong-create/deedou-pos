# customer-orders

## Purpose

Owns customer-facing order history and status presentation.

## Owns

- Submitted order status pills shown to customers.
- Customer order history/status strip.
- Customer-facing status labels.

## Does Not Own

- Kitchen/bar internal workflow.
- Payment processing.
- Menu presentation.
- Order creation.

## Public API

Import from `src/features/customer-orders/index.js`.

## Dependencies

- `src/shared/utils`
- Copy/lang are provided by the app composition layer.

## Database Tables Used

None. Current order data is in browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

This module renders customer-safe status summaries only; do not expose staff-only notes or payment internals here.

## Tests

No module tests yet.

