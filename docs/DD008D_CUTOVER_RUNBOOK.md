# DD-008D production cutover and rollback runbook

This runbook defines the safe path from DeeDou `LOCAL_DEMO` to PostgreSQL/Supabase server authority. It is an operator/developer procedure, not an automatic browser migration.

## 1. Authority and cutover stages

DeeDou recognizes three explicit stages:

- `LOCAL_DEMO`: localStorage business state is permitted for demo-only operation.
- `SUPABASE_TEST`: server authority is exercised in a non-production environment. No dual-write is allowed.
- `SUPABASE_AUTHORITATIVE`: PostgreSQL + RLS + authenticated command RPCs are the source of truth. Browser localStorage is limited to preferences, device/auth support state, caches, and explicitly unsynced drafts.

Both Supabase stages have these invariants:

- no business dual-write;
- no automatic legacy upload during page load;
- a localStorage/storage/BroadcastChannel event may request an authoritative refresh but may not replace server business state;
- a command is committed only when the authoritative RPC confirms it;
- reconnect gaps are repaired by an authoritative refetch.

Existing runtime `mode: "SUPABASE"` is treated as `SUPABASE_AUTHORITATIVE` for backward compatibility. New deployments should also set an explicit cutover stage in deployment configuration.

## 2. Legacy migration workflow

Migration is deliberate and operator-driven:

1. Open the legacy/local demo version while its localStorage is still available.
2. Build/download a legacy export. Keep the JSON as the rollback/reference artifact.
3. Run local preview validation. Resolve obvious malformed rows before contacting production.
4. Sign in as an authorized OWNER/MANAGER/ADMIN_MENU user on an `ADMIN` workstation/device.
5. Call `dd008d_preview_legacy_import` with a unique import key.
6. Review the server preview:
   - total rows;
   - malformed counts;
   - existing authoritative conflicts;
   - `SKIP_NO_OVERWRITE` policy.
7. Only after operator review, call `dd008d_import_legacy_data` with the *same payload* and *same import key*.
8. Save the returned result report and correlation ID.
9. Refetch authoritative state and compare orders, table visits, payments, service requests, and key timestamps.
10. Retain the original export until the migration/cutover acceptance window is complete.

### Migration safety properties

- `PREVIEW_REQUIRED`: import cannot run without a prior preview ledger entry.
- `PREVIEW_PAYLOAD_CHANGED`: the payload used for import must hash to the exact previewed payload.
- an import key cannot be rebound to a different payload;
- replaying an already imported batch is idempotent;
- existing authoritative order/session/payment/service-request IDs are conflicts and are not overwritten;
- malformed entities are skipped/reported rather than aborting the whole batch where safe;
- legacy ID mapping is recorded in `legacy_id_map`;
- product availability data in a legacy export is preview/reference data only. It is not silently applied to the authoritative menu.

The migration preserves valid legacy identity and operational snapshots including order ID/order number, line ID, configured key/options, option snapshot, table-session ID, course/hold/fire timestamps, payment IDs, service-request IDs, and audit timestamps. Database constraints still win over malformed legacy values.

## 3. Connectivity state model

Staff-facing routes use backend/auth/realtime/refetch health rather than relying on `navigator.onLine`.

- `ONLINE`: backend healthy, staff authenticated, authorized realtime subscribed, and authoritative snapshot recently refreshed.
- `RECONNECTING`: a recovery sequence is currently running. UI state is not yet declared fresh.
- `OFFLINE`: backend probe/transport cannot reach authority.
- `DEGRADED`: backend is reachable but auth or realtime is incomplete/erroring.
- `STALE`: the last authoritative snapshot is older than the configured freshness threshold.

Customer QR pages should remain simple. Staff, cashier, KDS, and admin surfaces should expose a compact connection indicator and safe diagnostics.

## 4. Reconnect sequence

A client may return to `ONLINE` only after this sequence succeeds:

1. refresh/restore a valid Supabase Auth session;
2. re-authorize the workstation/device context;
3. re-establish the permitted private realtime subscription/ticket;
4. fetch the current authoritative location/table snapshot;
5. replace stale cached business state with that snapshot;
6. record the successful authoritative refresh timestamp/correlation ID;
7. mark the operational state `ONLINE`.

Realtime messages are refresh hints, not business records. A disconnected client must not assume it received all broadcasts.

Do not replay arbitrary failed browser mutations. Only a request with the same command payload and retained idempotency key may be retried where the command contract makes that safe.

## 5. Offline policy

Initial DeeDou production cutover is **not** a LAN-first or multi-device offline POS.

When server authority cannot be reached:

- cached state may remain visible as read-only with `OFFLINE`/`STALE` indication;
- payments, payment voids, refunds, menu/admin writes, table transfers, and table-session structural mutations fail closed;
- order/KDS/service writes that did not receive server confirmation must not appear globally committed;
- a future emergency draft mechanism, if introduced, must use a separate `UNSYNCED` model and explicit operator reconciliation. It must never masquerade as authoritative state or silently merge.

LAN-first coordination is a future capability and is outside DD-008D.

## 6. Observability and safe diagnostics

Operational diagnostics may expose:

- operational state;
- backend probe result/time;
- auth state;
- realtime subscription state;
- last successful authoritative refresh;
- stable command failure category/code;
- safe request/audit correlation ID.

Do **not** log or render:

- JWT/access/refresh tokens;
- passwords;
- workstation credentials;
- service-role keys or DB connection strings;
- cookies/auth headers;
- full card/bank/payment instrument data;
- arbitrary full command payloads containing customer-sensitive data.

DD-008D correlation IDs are for matching browser-safe diagnostics to `audit_events`. The server audit writer generates a transaction correlation when a command did not supply one explicitly.

## 7. Production hardening checklist

Run automated repository/DB checks first, then complete the external deployment gates.

### Automated / repository gates

- [ ] all exposed and DD-008 migration tables have RLS enabled;
- [ ] no broad anon/authenticated table write grants;
- [ ] private realtime ticket authorization policy exists;
- [ ] browser code contains no service-role/database/private-key material;
- [ ] final cutover policy forbids dual-write and legacy auto-import;
- [ ] SUPABASE business state/menu localStorage writes are blocked or server-authoritative;
- [ ] `package-lock.json` is committed and CI uses `npm ci`;
- [ ] DD-008A/B/C/D migrations reset cleanly from an empty local Supabase database;
- [ ] DD-008D DB migration/import contract passes;
- [ ] authoritative multi-client browser smoke passes.

### External production-project gates

These cannot be proven by a local Supabase CI stack and require operator verification in the real project:

- [ ] public signup is disabled unless intentionally approved;
- [ ] Site URL and redirect allowlist contain only approved HTTPS production origins;
- [ ] production backup/PITR capability and restoration procedure are documented/tested according to the Supabase plan;
- [ ] local `supabase/seed.sql` demo users/data are **not applied** to production;
- [ ] only the Supabase publishable/anon browser key is exposed to the frontend;
- [ ] sensitive public/auth/admin endpoints have rate limits at the platform/API/edge layer appropriate to expected traffic;
- [ ] audit retention/access policy is defined;
- [ ] production logging/redaction is verified;
- [ ] migration ledger/results are retained for the cutover acceptance window.

`supabase/config.toml` is the **local development** configuration. It is not proof of production Auth, redirect, backup, or rate-limit settings.

## 8. Admin/menu persistence gate

Before the DD-008 parent epic closes, production mode must never silently persist menu/table/admin business changes to localStorage.

Current safe behavior is either:

1. a server-authoritative admin RPC exists and the UI uses it; or
2. the action is explicitly blocked in `SUPABASE_AUTHORITATIVE` and communicates that server authority is required.

A disabled production action is preferable to a local-only change that other devices cannot see.

## 9. Final authoritative acceptance flow

Before merge/cutover, exercise separate browser contexts and prove:

1. QR customer opens a valid table token.
2. Customer submits a configured menu item.
3. Staff receives the pending order through realtime and accepts it.
4. Course Hold/Fire works.
5. Exact KDS course ticket transitions ACKNOWLEDGED → PREPARING → READY.
6. Staff serves the exact ready line.
7. A second order batch attaches to the same active table visit.
8. Cashier performs partial/mixed tender settlement.
9. Service completes and the table visit closes correctly after final settlement.
10. Targeted refund on a closed/settled order does not reopen the visit or KDS workflow.
11. Table transfer converges across clients.
12. An authoritative admin availability change is reflected on the public menu without exposing admin-only data, or the admin mutation remains explicitly blocked until its server command exists.
13. Unauthorized/direct-browser tampering is rejected by server RBAC/RLS/workstation checks.
14. Disconnect/reconnect one client and prove convergence through authoritative refetch before `ONLINE`.
15. Repeating the same command/idempotency key creates one mutation.

## 10. Rollback / forward-fix procedure

### Frontend rollback

1. Stop production writes only if the incident requires it; do not delete authoritative data.
2. Record the current production frontend SHA and incident correlation IDs.
3. Deploy the last frontend version that is **schema-compatible with the current database**.
4. Confirm auth, private realtime, authoritative reads, and fail-closed commands.
5. Never switch production authority back to legacy localStorage merely because an older frontend is deployed.

### Database migration policy

DD-008 migrations are append-only foundations. Prefer a tested **forward-fix migration** over destructive down-migrations after production data exists.

Before a risky DB change:

- verify backup/PITR posture;
- export critical authoritative data when appropriate;
- record migration version/SHA;
- use additive schema changes where possible.

If rollback is unavoidable, use a separately reviewed migration compatible with the actual production data. Never replace newer server data with a historical browser export.

### Legacy export during rollback

Legacy export files are evidence/migration inputs only. They cannot become authoritative after cutover. A stale export must never be uploaded over newer PostgreSQL records.

## 11. Parent DD-008 closure

Do not close parent #18 until:

- DD-008A/B/C/D are merged;
- exact-head CI is green;
- final production-authoritative smoke is documented;
- all external production-project gates above are explicitly acknowledged/verified for the deployment target.
