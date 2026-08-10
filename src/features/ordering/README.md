# ordering

## Purpose

Owns framework-independent order and bill calculation rules.

## Owns

- Bill quantity clamping.
- Charged quantity.
- Line subtotal.
- Order total recalculation.
- Station status derivation.
- Order and item status normalization.
- Order item count helpers.

## Does Not Own

- Customer menu UI.
- Cashier payment capture.
- Admin product editing.
- Kitchen/bar/dessert presentation.

## Public API

Import from `src/features/ordering/index.js`.

## Dependencies

No feature dependencies.

## Database Tables Used

None. Current persistence is browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

Keep this module pure and framework-independent. Do not add browser storage or DOM access here.

## Tests

No module tests yet. This should be the first module to receive unit tests.

