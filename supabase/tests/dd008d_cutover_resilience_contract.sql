-- DD-008D legacy migration, resilience, and production-readiness contract.
-- Runs inside one transaction and rolls back all fixtures.

begin;

-- Permission and RLS surface must exist without widening operational workstation modes.
do $$
begin
  if not exists (select 1 from public.permissions where permission_key = 'migration.manage') then
    raise exception 'migration.manage permission missing';
  end if;

  if public.workstation_mode_allows_permission('CASHIER', 'migration.manage') then
    raise exception 'CASHIER workstation must not allow migration.manage';
  end if;
  if not public.workstation_mode_allows_permission('ADMIN', 'migration.manage') then
    raise exception 'ADMIN workstation must allow migration.manage';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'legacy_import_batches' and c.relrowsecurity = true
  ) then
    raise exception 'legacy_import_batches RLS missing';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'legacy_id_map' and c.relrowsecurity = true
  ) then
    raise exception 'legacy_id_map RLS missing';
  end if;

  if has_function_privilege('anon', 'public.dd008d_import_legacy_data(text,jsonb,text,text,text,text)', 'EXECUTE') then
    raise exception 'anon must not execute legacy import';
  end if;
  if not has_function_privilege('authenticated', 'public.dd008d_import_legacy_data(text,jsonb,text,text,text,text)', 'EXECUTE') then
    raise exception 'authenticated role should have RPC execute; server auth still gates migration.manage';
  end if;
end $$;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values ('dd008d-table-l01', 'deedou-demo', 'L01', 'Legacy', 'dd008d-l01-token-4R7tXk92', 990)
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values (
  '00000000-0000-0000-0000-000000000000',
  '30000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'dd008d-manager@example.invalid',
  crypt('local-only-dd008d-manager', gen_salt('bf')), now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values ('dd008d-staff-manager', '30000000-0000-4000-8000-000000000001', 'DD-008D Manager', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values ('dd008d-staff-manager', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values ('dd008d-staff-manager', 'deedou-demo', 'MANAGER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values (
  'dd008d-dev-admin', 'deedou-demo', 'DD-008D Admin Migration', 'ADMIN',
  public.hash_device_credential('dd008d-admin-device'), true, 'dd008d-staff-manager'
)
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_payload jsonb := jsonb_build_object(
    'schemaVersion', 1,
    'source', 'DEEDOU_LOCAL_DEMO',
    'locationId', 'deedou-demo',
    'exportedAt', '2026-08-15T18:00:00.000Z',
    'tableSessions', jsonb_build_array(jsonb_build_object(
      'id', 'dd008d-legacy-ts-1',
      'tableCode', 'L01',
      'zone', 'Legacy',
      'status', 'CLOSED',
      'source', 'LOCAL_DEMO',
      'openedAt', '2026-08-15T10:00:00.000Z',
      'closedAt', '2026-08-15T11:15:00.000Z'
    )),
    'orders', jsonb_build_array(jsonb_build_object(
      'id', 'dd008d-legacy-order-1',
      'orderNo', 'LEGACY-D0001',
      'tableSessionId', 'dd008d-legacy-ts-1',
      'table', 'L01',
      'zone', 'Legacy',
      'serviceMode', 'TABLE_SERVICE',
      'fulfillmentType', 'DINE_IN',
      'orderSource', 'COUNTER',
      'status', 'PAID',
      'note', 'legacy preserved note',
      'total', 99000,
      'paidVnd', 99000,
      'paymentStatus', 'PAID',
      'createdAt', '2026-08-15T10:05:00.000Z',
      'acceptedAt', '2026-08-15T10:06:00.000Z',
      'prepStartedAt', '2026-08-15T10:08:00.000Z',
      'readyAt', '2026-08-15T10:18:00.000Z',
      'servedAt', '2026-08-15T10:20:00.000Z',
      'paidAt', '2026-08-15T11:10:00.000Z',
      'items', jsonb_build_array(jsonb_build_object(
        'id', 'fried-rice',
        'lineId', 'fried-rice:1:item',
        'station', 'KITCHEN_HOT',
        'nameVi', 'Cơm chiên hải sản',
        'nameEn', 'Seafood Fried Rice',
        'qty', 1,
        'billQty', 1,
        'servedQty', 1,
        'prepStatus', 'READY',
        'status', 'SERVED',
        'basePrice', 99000,
        'price', 99000,
        'isBillable', true,
        'isComponent', false,
        'configuredKey', 'fried-rice|v:regular',
        'configuredOptions', jsonb_build_object('variantId', 'regular'),
        'optionSnapshot', jsonb_build_object('variant', jsonb_build_object('id', 'regular'), 'modifierGroups', '[]'::jsonb),
        'course', '1',
        'holdState', 'FIRED',
        'firedAt', '2026-08-15T10:06:30.000Z',
        'queuedAt', '2026-08-15T10:06:30.000Z',
        'acknowledgedAt', '2026-08-15T10:07:00.000Z',
        'prepStartedAt', '2026-08-15T10:08:00.000Z',
        'readyAt', '2026-08-15T10:18:00.000Z',
        'servedAt', '2026-08-15T10:20:00.000Z'
      )),
      'payments', jsonb_build_array(jsonb_build_object(
        'id', 'dd008d-legacy-pay-1',
        'type', 'PAYMENT',
        'method', 'CASH',
        'provider', 'MANUAL',
        'amountVnd', 99000,
        'tenderGroupId', 'LEGACY-TG-1',
        'createdAt', '2026-08-15T11:10:00.000Z',
        'note', 'legacy cash payment'
      ))
    )),
    'serviceRequests', jsonb_build_array(jsonb_build_object(
      'id', 'dd008d-legacy-sr-1',
      'tableSessionId', 'dd008d-legacy-ts-1',
      'table', 'L01',
      'zone', 'Legacy',
      'type', 'CALL_STAFF',
      'status', 'COMPLETED',
      'createdAt', '2026-08-15T10:30:00.000Z',
      'completedAt', '2026-08-15T10:32:00.000Z'
    )),
    'audit', jsonb_build_array(jsonb_build_object(
      'id', 'dd008d-legacy-audit-1',
      'command', 'legacy_local_event',
      'targetType', 'order',
      'targetId', 'dd008d-legacy-order-1',
      'outcome', 'LEGACY',
      'correlationId', 'legacy:old-1',
      'createdAt', '2026-08-15T10:05:30.000Z',
      'metadata', jsonb_build_object('source', 'localStorage')
    )),
    'products', jsonb_build_array(jsonb_build_object('id', 'fried-rice', 'available', true))
  );
begin
  -- Import is impossible before an explicit preview.
  select * into v_result
  from public.dd008d_import_legacy_data(
    'deedou-demo', v_payload, 'dd008d-import-1', 'ADMIN', 'dd008d-admin-device', 'contract:import-before-preview'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'PREVIEW_REQUIRED' then
    raise exception 'expected PREVIEW_REQUIRED before import, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd008d_preview_legacy_import(
    'deedou-demo', v_payload, 'dd008d-import-1', 'ADMIN', 'dd008d-admin-device', 'contract:preview-1'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'expected preview accepted, got %/%', v_result.category, v_result.reason;
  end if;
  if (v_result.payload->'preview'->'counts'->>'orders')::integer <> 1
     or (v_result.payload->'preview'->'counts'->>'orderLines')::integer <> 1
     or (v_result.payload->'preview'->'counts'->>'payments')::integer <> 1 then
    raise exception 'unexpected preview counts: %', v_result.payload->'preview'->'counts';
  end if;
  if v_result.payload->'preview'->'policy'->>'existingRecords' <> 'SKIP_NO_OVERWRITE'
     or (v_result.payload->'preview'->'policy'->>'autoImport')::boolean <> false then
    raise exception 'legacy preview policy unsafe: %', v_result.payload->'preview'->'policy';
  end if;

  select * into v_result
  from public.dd008d_import_legacy_data(
    'deedou-demo', v_payload, 'dd008d-import-1', 'ADMIN', 'dd008d-admin-device', 'contract:import-1'
  ) limit 1;
  if v_result.ok <> true or v_result.reason not in ('IMPORTED', 'PARTIAL') then
    raise exception 'expected legacy import accepted, got %/%', v_result.category, v_result.reason;
  end if;
  if (v_result.payload->'inserted'->>'orders')::integer <> 1 then
    raise exception 'expected one imported order, got %', v_result.payload;
  end if;

  -- Exact replay returns the stored result and performs no second mutation.
  select * into v_result
  from public.dd008d_import_legacy_data(
    'deedou-demo', v_payload, 'dd008d-import-1', 'ADMIN', 'dd008d-admin-device', 'contract:import-replay'
  ) limit 1;
  if v_result.ok <> true or v_result.reason <> 'IDEMPOTENT_REPLAY' then
    raise exception 'expected idempotent replay, got %/%', v_result.category, v_result.reason;
  end if;

  -- Same import key cannot be rebound to another payload.
  select * into v_result
  from public.dd008d_preview_legacy_import(
    'deedou-demo', jsonb_set(v_payload, '{orders,0,note}', '"changed payload"'::jsonb),
    'dd008d-import-1', 'ADMIN', 'dd008d-admin-device', 'contract:changed-preview'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'IMPORT_KEY_REUSED' then
    raise exception 'expected IMPORT_KEY_REUSED for changed preview payload, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

-- Verify identifiers/snapshots/timestamps survived and imported audit uses explicit correlation.
do $$
declare
  v_order public.orders;
  v_line public.order_lines;
  v_payment public.payment_transactions;
  v_request public.service_requests;
  v_created_at timestamptz;
begin
  select * into v_order from public.orders where id = 'dd008d-legacy-order-1';
  if v_order.id is null or v_order.order_no <> 'LEGACY-D0001' or v_order.table_session_id <> 'dd008d-legacy-ts-1'
     or v_order.note <> 'legacy preserved note' then
    raise exception 'legacy order identity/context not preserved: %', row_to_json(v_order);
  end if;

  select * into v_line from public.order_lines
  where order_id = 'dd008d-legacy-order-1' and line_id = 'fried-rice:1:item';
  if v_line.id is null or v_line.configured_key <> 'fried-rice|v:regular'
     or v_line.option_snapshot->'variant'->>'id' <> 'regular'
     or v_line.course <> '1' or v_line.hold_state <> 'FIRED'
     or v_line.fired_at <> '2026-08-15T10:06:30.000Z'::timestamptz then
    raise exception 'legacy line operational snapshot not preserved';
  end if;

  select * into v_payment from public.payment_transactions where id = 'dd008d-legacy-pay-1';
  if v_payment.id is null or v_payment.order_id <> 'dd008d-legacy-order-1' or v_payment.amount_vnd <> 99000 then
    raise exception 'legacy payment not preserved';
  end if;

  select * into v_request from public.service_requests where id = 'dd008d-legacy-sr-1';
  if v_request.id is null or v_request.table_session_id <> 'dd008d-legacy-ts-1' or v_request.status <> 'COMPLETED' then
    raise exception 'legacy service request not preserved';
  end if;

  select created_at into v_created_at
  from public.audit_events
  where metadata->>'legacyEventId' = 'dd008d-legacy-audit-1';
  if v_created_at <> '2026-08-15T10:05:30.000Z'::timestamptz then
    raise exception 'legacy audit timestamp not preserved: %', v_created_at;
  end if;

  if not exists (
    select 1 from public.audit_events
    where command = 'dd008d_import_legacy_data'
      and target_type = 'legacy_import_batch'
      and correlation_id = 'contract:import-1'
      and staff_id = 'dd008d-staff-manager'
      and device_id = 'dd008d-dev-admin'
  ) then
    raise exception 'import audit correlation/staff/device missing';
  end if;
end $$;

-- Simulate newer authoritative state before importing another stale export.
update public.orders
set note = 'authoritative newer value', version = version + 1
where id = 'dd008d-legacy-order-1';

set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_payload jsonb := jsonb_build_object(
    'schemaVersion', 1,
    'source', 'DEEDOU_LOCAL_DEMO',
    'locationId', 'deedou-demo',
    'exportedAt', '2026-08-15T19:00:00.000Z',
    'tableSessions', '[]'::jsonb,
    'orders', jsonb_build_array(jsonb_build_object(
      'id', 'dd008d-legacy-order-1',
      'orderNo', 'LEGACY-D0001',
      'serviceMode', 'COUNTER_SERVICE',
      'fulfillmentType', 'TAKEAWAY',
      'orderSource', 'COUNTER',
      'status', 'PAID',
      'note', 'stale local overwrite attempt',
      'total', 99000,
      'paidVnd', 99000,
      'paymentStatus', 'PAID',
      'items', '[]'::jsonb,
      'payments', '[]'::jsonb
    )),
    'serviceRequests', '[]'::jsonb,
    'audit', '[]'::jsonb,
    'products', '[]'::jsonb
  );
begin
  select * into v_result
  from public.dd008d_preview_legacy_import(
    'deedou-demo', v_payload, 'dd008d-import-conflict', 'ADMIN', 'dd008d-admin-device', 'contract:preview-conflict'
  ) limit 1;
  if v_result.ok <> true or (v_result.payload->'preview'->'existingAuthoritative'->>'orders')::integer <> 1 then
    raise exception 'expected existing authoritative order in preview: %', v_result.payload;
  end if;

  select * into v_result
  from public.dd008d_import_legacy_data(
    'deedou-demo', v_payload, 'dd008d-import-conflict', 'ADMIN', 'dd008d-admin-device', 'contract:import-conflict'
  ) limit 1;
  if v_result.ok <> true or (v_result.payload->>'conflicts')::integer < 1 then
    raise exception 'expected stale legacy conflict, got %/%/%', v_result.ok, v_result.reason, v_result.payload;
  end if;

  select * into v_result
  from public.dd008d_production_readiness(
    'deedou-demo', 'ADMIN', 'dd008d-admin-device', 'contract:readiness'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'production readiness RPC failed: %/%', v_result.category, v_result.reason;
  end if;
  if (v_result.payload->'database'->>'rlsMissingCount')::integer <> 0
     or (v_result.payload->'database'->>'broadWriteGrantCount')::integer <> 0
     or (v_result.payload->'browser'->>'dualWriteAllowed')::boolean <> false then
    raise exception 'production readiness blocking contract failed: %', v_result.payload;
  end if;
end $$;

reset role;

do $$
declare
  v_note text;
  v_order_count integer;
begin
  select note into v_note from public.orders where id = 'dd008d-legacy-order-1';
  if v_note <> 'authoritative newer value' then
    raise exception 'stale local import overwrote authoritative order: %', v_note;
  end if;

  select count(*) into v_order_count from public.orders where id = 'dd008d-legacy-order-1';
  if v_order_count <> 1 then
    raise exception 'idempotent/conflict imports duplicated order: %', v_order_count;
  end if;
end $$;

rollback;
