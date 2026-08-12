# cart

Responsibility: customer cart state rules and cart UI.

Does not own order submission, final order pricing, payment, station workflow, or menu catalog ownership.

Allowed dependencies: `src/shared/*` and the public `src/features/product-options/index.js` API; receive product lookup and order status HTML from callers.

Prohibited dependencies: DOM storage, table definitions, payments, kitchen/bar/dessert internals, admin internals.

Public interface: export through `index.js`.

Tests: prioritize add/decrement/remove, configured merge/split identity, subtotal, stale option rejection, legacy cart readability, and submit validation.
