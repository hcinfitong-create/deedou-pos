# Auth Module Instructions

This module owns browser-facing staff authentication and access presentation helpers.

Allowed:

- Route-to-permission/workstation intent mapping.
- Supabase-managed email/password auth lifecycle through public publishable configuration.
- Browser auth gate rendering helpers.
- Staff context and authorization result normalization.

Not allowed:

- Service role keys, admin auth APIs, JWT signing secrets, or production credentials.
- Copying Supabase access/refresh tokens into DeeDou app state or cache keys.
- Visible normal-login device token entry.
- Order, payment, KDS, table-session, or menu mutation rules.
- Trusting route, query string, localStorage, or client-selected actor as authority.
- Replacing database authorization; browser checks are only presentation gates.

All authoritative staff/location/permission/device decisions must come from DD-008B database helpers.
