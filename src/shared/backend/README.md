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
- Database password or connection string
- JWT signing secret
- Access token
- Private key
- Production credentials

## Local Supabase

Install the Supabase CLI separately, then run:

```sh
supabase start
supabase db reset
supabase stop
```

The database can be recreated from zero using:

```sh
supabase db reset
```

`supabase/seed.sql` seeds one deterministic DeeDou demo location, the current QR tables, and a small catalog/options graph for schema validation.

## Migration Workflow

1. Add a new SQL migration under `supabase/migrations/`.
2. Keep schema changes structural in DD-008A.
3. Run `supabase db reset` locally when the CLI is available.
4. Run `npm run check`, `npm test`, and `git diff --check`.

## Rollback / Removal

To remove DD-008A infrastructure before later stages:

1. Delete `src/shared/backend/`.
2. Delete `supabase/`.
3. Remove backend files from `package.json` check script.
4. Remove backend tests.

No local app runtime storage needs migration because DD-008A does not make Supabase authoritative.

## Known Limitations

- No staff login, role permissions, or PIN workflow.
- No authoritative order/payment commands.
- No production realtime KDS.
- No reconnect/refetch workflow beyond a basic probe helper.
- No real payment provider integration.
