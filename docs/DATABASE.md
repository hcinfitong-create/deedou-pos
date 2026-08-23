# DeeDou Database

> PostgreSQL/Supabase schema map and database safety contract. Current migrations are authoritative; this document is an index, not a replacement for DDL.

## Authority and environments

- Database: PostgreSQL via Supabase.
- Hosted business authority: PostgreSQL.
- Local development: Supabase CLI migrations + `supabase/seed.sql` + SQL contracts.
- Hosted staging reference used by current deployment gates: `nwyhxdcslxxjirsmqnxo`.
- Production reference used by current production acceptance: `nwohsyzpmogqjbmknwbl`.
- Project references are identifiers, not credentials. Never commit service-role keys, DB passwords, JWT secrets or private keys.

## Migration policy

1. Use forward-only migrations.
2. Do not edit an already-applied hosted/production migration as the normal repair path.
3. Never reset/drop production to make tests pass.
4. Assess API/UI/contract consumers before column/constraint changes.
5. Preserve historical financial/order/security records; prefer disable/revoke/forward-fix.
6. Run fresh-database migration contracts before hosted rollout.
7. Hosted staging acceptance + cleanup precedes production when the issue requires it.

## Core business tables

Foundation introduced by DD-008A:

- `locations` — location identity/timezone/currency.
- `physical_tables` — table code/zone/QR token/active ordering point.
- `products` — authoritative product core.
- `product_variants` — product variant price deltas.
- `modifier_groups` — selection group/bounds.
- `modifier_options` — option values/price deltas.
- `product_modifier_groups` — product↔modifier-group assignments.
- `product_components` — combo/component routing definition; canonical component model.
- `table_sessions` — one active dining visit at a physical table.
- `orders` — order batch/service context/status/totals.
- `order_lines` — immutable submitted line/configured snapshots plus prep/serve/course state.
- `service_requests` — CALL_STAFF / BILL_REQUEST workflow.
- `payment_transactions` — append-only PAYMENT / PAYMENT_VOID / REFUND ledger.
- `idempotency_keys` — command replay foundation.
- `command_deduplication` — authoritative command dedup records.
- `audit_events` — append-oriented audit trail.

Key invariants from the foundation include:

- one OPEN table session per physical table;
- high-entropy unique QR token;
- non-negative product prices;
- valid service mode/fulfillment/source enums;
- KDS line prep states `QUEUED/ACKNOWLEDGED/PREPARING/READY`;
- payment history uses restrictive order/location references so order deletion cannot cascade-delete ledger history.

## Identity / RBAC tables

DD-008B adds:

- `staff_profiles` — Auth-linked staff profile.
- `roles` — OWNER/MANAGER/CASHIER/FLOOR_STAFF/KITCHEN/BAR/DESSERT/ADMIN_MENU.
- `permissions` — granular permission registry.
- `role_permissions` — role→permission mapping.
- `staff_location_assignments` — active staff access per location.
- `staff_role_assignments` — role per staff/location.
- `workstation_devices` — registered device identity/mode/revocation state.

Authorization is not determined by role name alone. Effective staff access combines authenticated user, active staff, active location assignment, permission, active registered device and allowed workstation mode.

## DD-011B identity/device additions

DD-011B migrations add/modify:

- `staff_profiles.username` — lowercase/case-insensitive unique login identifier.
- `staff_profiles.provisioning_status` — `ACTIVE`, `PENDING_FIRST_LOGIN`, `PENDING_OWNER_APPROVAL`, `DISABLED`.
- unique partial index enforcing at most one active `OWNER` assignment globally.
- `workstation_device_secrets` — backend-only current device credential.
- `workstation_device_sessions` — hashed HttpOnly-cookie session-token authority, expiry/revoke/last-seen state.
- `staff_activation_requests` — FIRST_LOGIN/NEW_DEVICE challenge, six-digit code, request-token hash, approval/reject/completion lifecycle.
- `dd011b_security_policy` — singleton enforcement state including `backend_device_sessions_required`.

These security tables have RLS enabled and are revoked from anon/authenticated table access; service-role backend code is the intended direct data actor.

## DD-012C combo/component schema

Production-complete migration: `dd012c_combo_components`.

Current Production migration-history version: `20260823235316`.

DD-012C extends the existing canonical `product_components` model rather than creating a second combo graph.

Schema/contract changes:

- `product_components.updated_at timestamptz not null` — optimistic concurrency token for Admin component updates/deletes;
- `dd008d_get_admin_menu_snapshot(...)` now includes a `components` projection for the requested location;
- authoritative component mutation RPCs:
  - `dd012_create_product_component(...)`;
  - `dd012_update_product_component(...)`;
  - `dd012_delete_product_component(...)`.

Component mutation invariants:

- parent product must exist in the same location;
- IDs/keys/names/quantity/station/display order are server-validated;
- update/delete require the expected `updated_at` value and reject stale writes;
- create/update/delete use the existing `menu.manage` command authority;
- idempotency, audit records and realtime refresh hints are preserved;
- mutation RPC EXECUTE is denied to `anon` and granted only to intended authenticated/backend roles;
- browser direct writes to `product_components` remain unsupported/denied.

Order-history invariant:

- submitted order-line component/configured snapshots are historical records;
- later `product_components` edits or deletes must not rewrite submitted order-line snapshots.

Production rollout verification after PR #46 confirmed:

- migration present;
- `updated_at` column present;
- all three component mutation functions present;
- anon EXECUTE denied on the mutation RPCs;
- unauthenticated Admin menu snapshot remains fail-closed;
- Production real data baseline remained one location / one staff profile / zero products / zero components / zero orders;
- DD-011B Owner/device-session enforcement remained intact.

## RLS / direct-write rule

RLS is enabled on core business/security tables and broad anon/authenticated table access is revoked. Browser flows must use approved public-safe functions or authenticated authoritative RPC/backend handlers.

Do not “fix” an RPC/permission problem by granting broad Data API CRUD to browser roles.

## Public-safe database contracts

Examples include:

- exact QR token resolution (`resolve_table_token`);
- public menu projections;
- public QR order/service-request commands;
- restricted staff snapshot/command RPCs;
- Admin table/catalog RPCs;
- security context/activation helpers.

See `docs/API_CONTRACTS.md` for client-facing boundaries.

## Catalog invariants

- Reuse existing product/variant/modifier/component graph.
- `product_components` remains the canonical combo/component graph.
- Direct browser catalog writes remain denied.
- Admin mutations require authenticated `menu.manage` + valid workstation/backend device-session context.
- Create/update uses server validation, idempotency, audit and optimistic concurrency where defined.
- Catalog changes do not rewrite historical `order_lines` option/component/price snapshots.

## Payment invariants

- Ledger is append-only in normal operation.
- PAYMENT_VOID / REFUND reference prior payment state rather than deleting it.
- Amounts are positive integer VND at the DB boundary unless a future accepted monetary contract supersedes it.
- A targeted refund cannot exceed remaining refundable amount.
- Closing/refunding must not mutate KDS prep history into a reopened workflow.

## Key migration families

Current repository includes migration families for:

- `dd008a_backend_foundation`;
- `dd008b_auth_rbac` and hosted function ACL;
- `dd008c_authoritative_commands_realtime`;
- `dd008d_cutover_resilience`, Admin menu/realtime/refund permission;
- `dd010a_admin_table_layout` + open-session layout lock;
- `dd011_security_hardening` and follow-up compatibility fixes;
- `dd011b_*` identity/device/activation/compatibility/sole-owner guard migrations;
- `dd012_admin_catalog_product_core`;
- `dd012b_variants_modifiers` + assignment normalization;
- `dd012c_combo_components`.

Always inspect the actual `supabase/migrations/` directory and hosted migration history for the latest state.

## Database validation checklist

For DB work:

- `npx supabase db reset` on a fresh local stack;
- run all relevant SQL contracts, not only the new one;
- run Auth/integration/browser regressions when authorization surfaces change;
- verify RLS/GRANT/EXECUTE behavior on hosted staging because hosted default privileges can differ from local expectations;
- verify fixture cleanup and baseline restoration after hosted smoke;
- document production migration evidence before marking production complete.
