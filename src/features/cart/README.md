# cart

## Purpose

Owns customer cart state rules and customer cart UI for the local-first app.

## Owns

- Adding menu items to cart.
- Decrementing/removing cart items.
- Clearing cart after successful order submission.
- Quantity limits.
- Cart subtotal before order submission.
- Cart submit validation.
- Cart panel and cart line presentation.
- Configured cart-line identity for products with variants/modifiers.
- Backward-compatible legacy `{ id, qty }` cart lines.

## Does Not Own

- Final server-authoritative order price.
- Order status.
- Payment.
- Kitchen/bar workflow.
- Menu catalog data.

## Public API

Import from `src/features/cart/index.js`.

## Dependencies

- `src/shared/utils`
- `src/features/product-options`
- Product lookup is injected by the app composition layer.

## Database Tables Used

None. Current persistence is browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

Cart totals are customer-side estimates only. Final payable order totals belong to `ordering` and later server-side validation.

## Tests

Module tests cover add/decrement/remove, configured merge/split identity, subtotal, stale option rejection, legacy cart readability, and submit validation.
