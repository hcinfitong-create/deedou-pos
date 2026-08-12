# Backend Module Instructions

This module owns backend infrastructure setup only.

Allowed:

- Runtime backend mode/config normalization.
- Public/publishable Supabase client setup boundary.
- Connection-state probing helpers.
- Documentation for local Supabase development.

Not allowed:

- Order, payment, table-session, KDS, or service-request business rules.
- Staff auth or RBAC command authorization.
- Production mutations that bypass the existing local-first app.
- Service role keys, database passwords, JWT secrets, private keys, or production credentials.

Business feature modules must not import Supabase directly. They may only use public APIs exported from `src/shared/backend/index.js` once a later DD-008 phase deliberately wires an adapter.
