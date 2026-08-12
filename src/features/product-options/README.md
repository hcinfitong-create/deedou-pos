# product-options

## Purpose

Owns DeeDou product variants and modifier groups as pure domain rules.

## Owns

- Variant and modifier-group normalization.
- Product option configuration validation.
- Configured selection canonicalization.
- Configured cart identity.
- Catalog-derived configured unit price.
- Immutable order-line option snapshots.
- Option summary helpers for customer, staff, cashier, and KDS displays.

## Does Not Own

- Menu filtering or product card layout.
- Cart quantity state.
- Order status, preparation status, serving progress, or payment.
- Kitchen/bar/dessert workflow.
- Admin form DOM behavior.
- Persistence or `localStorage`.

## Contract

```text
Product != Variant != Modifier Group != Modifier Selection != Order Line Snapshot
```

If a product has variants, exactly one variant must be selected. Modifier groups may be required or optional and enforce `minSelect`/`maxSelect`. Modifier selections are canonicalized so equivalent multi-select orders produce the same configured cart identity.

Submitted order lines must carry snapshot data for the selected variant/modifiers and the final unit price. Historical orders should not change when the live catalog changes later.

## Admin Limitation

DD-005 keeps the admin editor intentionally constrained: variants and modifier groups are edited as validated JSON fields in the existing product form. A richer structured admin UI can be extracted later with `admin-menu`.

## Public API

Import from `src/features/product-options/index.js`.
