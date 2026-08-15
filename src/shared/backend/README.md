# DeeDou Backend Boundary

DD-008A adds the Supabase/PostgreSQL foundation. DD-008C adds the first server-authoritative command/query boundary for `SUPABASE` mode while preserving existing `LOCAL_DEMO` localStorage behavior.

## Modes

- `LOCAL_DEMO`: default. Existing static app behavior remains unchanged.
- `SUPABASE`: available only when complete public configuration is supplied explicitly. Operational mutations use server-confirmed RPCs instead of localStorage business writes.

Missing or partial Supabase config fails safely back to `LOCAL_DEMO`.

## Public Browser Configuration

The browser may only receive publishable Supabase configuration:

- `DEEDOU_BACKEND_MODE`
- `DEEDOU_SUPABASE_URL`
- `DEEDOU_SUPABASE_PUBLISHABLE_KEY`

Equivalent runtime object keys are:

- `mode`
- `supabaseUrl`
- `supabasePublishableKey`

Never put these in browser config:

- Supabase service role key
- Legacy Supabase JWT whose decoded `role` is anything other than `anon`
- Database password or connection string
- JWT signing secret
- Access token
- Private key
- Production credentials

## Public Read Boundary

Public QR/menu access is intentionally narrow:

- Table QR access uses `resolve_table_token(token)` for exact-token lookup only.
- There is no public list-all table-token view.
- Menu access uses location-scoped public functions: `list_public_menu_products(location_id)`, `list_public_menu_product_variants(location_id)`, `list_public_menu_modifier_groups(location_id)`, and `list_public_menu_modifier_options(location_id)`.
- Public menu functions do not expose station routing, payment data, audit data, idempotency data, or raw internal tables.
- Raw tables revoke anon/authenticated access. Authoritative writes are exposed only through narrow command RPCs with explicit grants.

## Authoritative Commands

`src/shared/backend/commands.js` is a browser infrastructure adapter. It owns RPC invocation, command result normalization, staff workstation context injection, and refresh-hint subscription plumbing.

It must not implement DeeDou business rules. Server authority lives in transactional SQL functions, and pure JavaScript business helpers remain in `src/features/`.

DD-008C command coverage includes:

- public QR order and service request creation;
- staff/counter order creation and order status decisions;
- KDS prep transitions, item serving, course hold/fire, and table visit operations;
- payment record, payment void, targeted refund, and table tender allocation.

Realtime events are refresh hints only. Clients must refetch authoritative snapshots after hints.

Private Realtime subscriptions are also server-authorized. The browser asks
for a short-lived refresh ticket with its authenticated staff identity,
location, registered device credential, and workstation mode. The server
issues an opaque ticket topic only after the effective access intersection
passes:

`identity + role permission + location + registered device + workstation mode`.

Realtime topics never contain device credentials, access tokens, refresh
tokens, passwords, or payment data. Payment/audit refreshes use narrower
audiences and still require authoritative refetch for data.

## Local Supabase

DD-008A pins the Supabase CLI as a dev dependency when tooling is available. Run:

```sh
npx supabase start
npx supabase db reset
npx supabase stop
```

The database can be recreated from zero using:

```sh
npx supabase db reset
```

`supabase/seed.sql` seeds one deterministic DeeDou demo location, the current QR tables, and a small catalog/options graph for schema validation.
`supabase/tests/dd008a_contract.sql` contains the DD-008A DB-level review contract checks for public access, table-session invariants, and payment-ledger retention.
`supabase/tests/dd008c_authoritative_commands_contract.sql` contains the DD-008C server-command contract checks.

## Migration Workflow

1. Add a new SQL migration under `supabase/migrations/`.
2. Keep each DD-008 migration additive; do not rewrite earlier migrations.
3. Run `npx supabase db reset` locally when the CLI and Docker are available.
4. Run `npm run check`, `npm test`, and `git diff --check`.

## Rollback / Removal

To remove DD-008A infrastructure before later stages:

1. Delete `src/shared/backend/`.
2. Delete `supabase/`.
3. Remove backend files from `package.json` check script.
4. Remove backend tests.

No local demo runtime storage needs migration because `LOCAL_DEMO` remains local-first.

## Known Limitations

- No custom PIN workflow.
- No service-role browser calls or production secrets.
- Admin/menu write RPCs are still deferred.
- Realtime is refresh-hint/refetch convergence, not event-sourced state.
- No real payment provider integration.
