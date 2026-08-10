# DeeDou Modular Architecture Audit

Date: 2026-08-10

## 1. Current Directory Structure

```text
.
├── .agents/
├── .git/
├── app.js
├── index.html
├── README.md
└── styles.css
```

The current application is a local-first static web app. There is no React, Next.js app router, backend, Supabase client, build pipeline, or test runner in this repository yet.

## 2. Oversized Files

- `app.js`: about 1,700 lines. It contains data seeds, configuration, state normalization, routing, UI rendering, event binding, order business rules, payment rules, station workflow, admin menu editing, QR table links, and formatting helpers.
- `styles.css`: about 1,100 lines. It contains all customer, staff, cashier, station, admin, and responsive styling in one global stylesheet.

## 3. Components Containing Unrelated Responsibilities

This codebase does not use React components. The equivalent issue is large render functions and event binders in `app.js`.

- `shell`, `pageFor`, and per-page render functions combine route composition with markup strings.
- `customerPage`, `menuContent`, `itemCard`, `cartPanel`, and `cartLine` mix customer menu UI with cart state rules.
- `cashierPage`, `cashierTableDetail`, `tablePaymentPanel`, `cashierOrderCard`, and `counterOrderPanel` mix cashier layout, table order aggregation, bill adjustment, counter ordering, payment action rendering, and reconciliation display.
- `stationPage` and `stationTicket` mix station-specific presentation with station filtering.
- `adminPage`, `productForm`, and `adminProductRow` mix admin UI, product schema defaults, image preview handling, QR link rendering, and form behavior.

## 4. Business Logic Inside React Components

Not applicable: the repository does not contain React.

Current equivalent: business logic is embedded directly in markup-rendering functions and bind handlers in `app.js`.

Examples:

- Cart add/remove rules are in `addItem`, `decItem`, `cartPanel`, and `cartLine`.
- Order creation and combo expansion are in `submitOrder`, `submitCounterOrder`, and `expandCartLines`.
- Order status transitions are in `updateOrderStatus` and `updateStationStatus`.
- Payment, split, refund, pre-bill, and void rules are in cashier action functions.
- Bill quantity adjustment is in `adjustBillQty` and render helpers.
- Service request creation is in `serviceRequest`.

## 5. Business Logic Inside Next.js Route Files

Not applicable: there are no Next.js routes.

If DeeDou moves to Next.js later, `app/` route files should remain thin and import behavior through feature module public APIs.

## 6. Cross-Feature Imports

There are currently no imports. Everything lives in one global script scope, so all features can implicitly access all functions and state.

This is more tightly coupled than explicit imports because feature boundaries are invisible.

## 7. Circular Dependencies

No import graph exists yet, so there are no detectable circular imports. The logical dependency graph is still tangled because shared mutable state, config, rendering, and domain rules all live in `app.js`.

Primary logical cycles to avoid during refactor:

- customer menu -> cart -> ordering -> customer menu
- cashier -> ordering -> payments -> cashier
- station workflow -> ordering -> station workflow
- admin menu -> customer menu -> admin menu

## 8. Shared Files That Have Become Dumping Grounds

- `app.js` is the current dumping ground for all JavaScript concerns.
- `styles.css` is the current dumping ground for all visual concerns.

Future shared code must be narrow and genuinely reusable, for example `shared/config`, `shared/utils`, `shared/i18n`, and later `shared/db` only when a database exists.

## 9. Database Access Scattered Across UI Code

No database exists. Persistence is browser `localStorage`, currently accessed directly in `app.js`.

Current persistence concerns:

- Product storage: `PRODUCT_KEY`, `loadProducts`, `saveProducts`.
- App state storage: `STATE_KEY`, `loadState`, `saveState`.
- Counter draft storage: `COUNTER_DRAFT_KEY`, `loadCounterDraft`, `saveCounterDraft`.
- UI preferences: language, active menu kind, active cashier table, counter search.
- Realtime-like local sync: `BroadcastChannel`.

When production persistence is introduced, database access should be centralized under feature `queries/` or `server/supabase`, not inside UI render functions.

## 10. Functions Used By Multiple Unrelated Features

Current shared candidates:

- `formatMoney`
- `escapeHtml`
- `escapeAttr`
- `slugify`
- `normalizeSearch`
- `stationStatusFor`
- `billableTotal`
- `lineSubtotal`
- `chargedQty`
- `recalcOrderTotal`
- `countPrepItems`
- `countServedItems`
- `countStatusItems`
- `productById`
- `categoryLabel`
- `audit`
- `saveState`
- `render`

Only the genuinely generic helpers should move to `shared/`. Business-specific helpers should move to owning feature modules.

## 11. Areas Where One Feature Requires Touching Many Unrelated Files

Current examples:

- Changing customer menu card design requires inspecting `app.js` and `styles.css`, and risks cart/order rendering because all markup helpers are colocated.
- Changing cart rules requires editing the same file that owns admin, station, cashier, and payments.
- Changing order status transitions requires understanding staff board, kitchen/bar/dessert displays, cashier paid/open filters, and customer status pills.
- Changing payment behavior requires checking cashier UI, order totals, table aggregation, audit history, and paid order history in one file.
- Adding admin product fields requires touching product seeds, normalization, form rendering, product list rendering, localStorage persistence, and customer menu display in one file.

## 12. Existing Tests Affected By Refactoring

No test files or test commands exist in the repository.

Current validation options:

- Syntax check for `app.js` through a JavaScript parser.
- Manual/browser checks against `http://127.0.0.1:8099/index.html`.
- Future module unit tests should start with framework-independent domain functions in `features/ordering/tests/`.

## Primary Risks

- Moving too much at once can break the static app because global ordering currently matters.
- `localStorage` state migrations must preserve old browser data.
- `prompt()` and `confirm()` are browser-dialog dependencies; some in-app browser contexts may not support `prompt()`.
- `styles.css` selectors are global, so moving markup without scoped styles may create visual regressions.

## Recommended Incremental Refactor

1. Create docs and public module ownership rules.
2. Convert `app.js` to an ES module without changing UI behavior.
3. Extract stable config, i18n copy, generic utilities, and pure ordering calculations first.
4. Extract customer-menu render helpers next.
5. Extract cart and ordering actions after customer menu is stable.
6. Extract cashier/payments after ordering contracts are stable.
7. Extract station workflows.
8. Extract admin-menu.

