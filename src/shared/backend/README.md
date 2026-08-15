# DeeDou Backend Foundation

DD-008A adds the Supabase/PostgreSQL foundation without switching DeeDou production behavior away from `localStorage`.

## Modes

- `LOCAL_DEMO`: default. Existing static app behavior remains unchanged.
- `SUPABASE`: available only when complete public configuration is supplied explicitly.

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
- Raw tables revoke anon/authenticated access unless a later authoritative backend stage adds explicit command boundaries.

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
`supabase/tests/dd008a_contract.sql` contains the DB-level review contract checks for public access, table-session invariants, and payment-ledger retention.

## Migration Workflow

1. Add a new SQL migration under `supabase/migrations/`.
2. Keep schema changes structural in DD-008A.
3. Run `npx supabase db reset` locally when the CLI and Docker are available.
4. Run `npm run check`, `npm test`, and `git diff --check`.

## Rollback / Removal

To remove DD-008A infrastructure before later stages:

1. Delete `src/shared/backend/`.
2. Delete `supabase/`.
3. Remove backend files from `package.json` check script.
4. Remove backend tests.

No local app runtime storage needs migration because DD-008A does not make Supabase authoritative.

## Known Limitations

- Staff login/RBAC is introduced separately in DD-008B through `src/shared/auth` and database helpers.
- No custom PIN workflow.
- No authoritative order/payment commands.
- No production realtime KDS.
- No reconnect/refetch workflow beyond a basic probe helper.
- No real payment provider integration.
