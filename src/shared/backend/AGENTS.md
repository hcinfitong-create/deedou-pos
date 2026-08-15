# Backend Module Instructions

This module owns the browser backend infrastructure boundary only.

Allowed:

- Runtime backend mode/config normalization.
- Public/publishable Supabase client setup boundary.
- Connection-state probing helpers.
- RPC/query adapter methods for approved authoritative server commands.
- Refresh-hint subscription plumbing that triggers authoritative refetches.
- Documentation for local Supabase development.

Not allowed:

- Order, payment, table-session, KDS, or service-request business rules.
- Staff auth or RBAC command authorization.
- Browser-side mutations that bypass server-confirmed command RPCs in `SUPABASE`.
- Service role keys, database passwords, JWT secrets, private keys, or production credentials.

Business feature modules must not import Supabase directly. They may only use public APIs exported from `src/shared/backend/index.js`.

Keep command adapters thin: validate transport-level inputs, call the server RPC, normalize the command envelope, and leave DeeDou domain decisions to feature modules or SQL command contracts.
