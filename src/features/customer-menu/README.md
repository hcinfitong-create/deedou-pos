# customer-menu

## Purpose

Owns customer-facing menu structure and demo catalog seeds for the local-first app.

## Owns

- Menu kinds.
- Menu categories.
- Category aliases for legacy data.
- Demo products and combo component seeds.
- Menu sort order.
- Demo products may include variant/modifier configuration data, but option rules belong to `product-options`.

## Does Not Own

- Cart quantity rules.
- Order creation.
- Payment.
- Station preparation workflow.
- Admin product form behavior.

## Public API

Import from `src/features/customer-menu/index.js`.

## Dependencies

No feature dependencies.

## Database Tables Used

None. Current persistence is browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

Do not add privileged product mutation here. Admin mutations belong to `admin-menu`.

## Tests

No module tests yet.
