# service-requests

## Purpose

Owns customer service request UI and event creation.

## Owns

- Customer "call staff" action.
- Customer "request bill" action.
- Service request event shape for the local-first app.
- Initial pending/done state for a customer service request.

## Does Not Own

- Payment processing.
- Staff order workflow.
- Table definitions.
- Staff-side completion UI.

## Public API

Import from `src/features/service-requests/index.js`.

## Dependencies

None. Table context is passed in by the app composition layer.

## Database Tables Used

None. Current persistence is browser `localStorage`.

## Realtime Events Used

None directly.

## Security Notes

Do not add payment-side behavior to `REQUEST_BILL`; it is only a customer service request in this module.

## Tests

No module tests yet.

