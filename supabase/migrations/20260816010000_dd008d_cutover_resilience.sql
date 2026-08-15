-- DD-008D legacy migration, cutover resilience, observability, and production-readiness foundation.
-- This migration is additive. It does not auto-import browser data and does not weaken DD-008C authority/RLS.

insert into public.permissions (id, permission_key, description)
values ('migration.manage', 'migration.manage', 'Preview/import DeeDou legacy local data and inspect production readiness')
on conflict (id) do update
set permission_key = excluded.permission_key,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
values
  ('OWNER', 'migration.manage'),
  ('MANAGER', 'migration.manage'),
  ('ADMIN_MENU', 'migration.manage')
on conflict do nothing;

create or replace function public.workstation_mode_allows_permission(p_mode text, p_permission_key text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_mode
    when 'CASHIER' then p_permission_key in (
      'menu.read',
      'orders.read',
      'orders.create_staff',
      'orders.void',
      'service_requests.read',
      'tables.read',
      'tables.manage_session',
      'payments.read',
      'payments.record',
      'payments.void',
      'payments.refund'
    )
    when 'STAFF' then p_permission_key in (
      'menu.read',
      'orders.read',
      'orders.accept',
      'service.serve',
      'service_requests.read',
      'service_requests.complete',
      'course.manage',
      'tables.read'
    )
    when 'KDS_KITCHEN' then p_permission_key in ('orders.read', 'kds.kitchen')
    when 'KDS_BAR' then p_permission_key in ('orders.read', 'kds.bar')
    when 'KDS_DESSERT' then p_permission_key in ('orders.read', 'kds.dessert')
    when 'ADMIN' then p_permission_key in (
      'menu.read',
      'menu.manage',
      'tables.read',
      'payments.read',
      'audit.read',
      'staff.read',
      'staff.manage',
      'devices.manage',
      'migration.manage'
    )
    else false
  end
$$;

create table if not exists public.legacy_import_batches (
  id uuid primary key default gen_random_uuid(),
  location_id text not null references public.locations(id) on delete cascade,
  import_key text not null,
  source_hash text not null,
  schema_version integer not null,
  source text not null,
  status text not null check (status in ('PREVIEWED', 'IMPORTED', 'PARTIAL', 'FAILED')),
  preview jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  staff_id text not null default '',
  device_id text not null default '',
  correlation_id text not null default '',
  created_at timestamptz not null default now(),
  imported_at timestamptz,
  unique (location_id, import_key)
);

create table if not exists public.legacy_id_map (
  id uuid primary key default gen_random_uuid(),
  location_id text not null references public.locations(id) on delete cascade,
  entity_type text not null,
  legacy_id text not null,
  authoritative_id text not null,
  import_batch_id uuid not null references public.legacy_import_batches(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (location_id, entity_type, legacy_id)
);

alter table public.legacy_import_batches enable row level security;
alter table public.legacy_id_map enable row level security;
revoke all on public.legacy_import_batches from anon, authenticated;
revoke all on public.legacy_id_map from anon, authenticated;

create or replace function public.dd008d_json_array(p_value jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select case when jsonb_typeof(p_value) = 'array' then p_value else '[]'::jsonb end
$$;

create or replace function public.dd008d_safe_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(p_value, '')), '') is null then
    return null;
  end if;
  return p_value::timestamptz;
exception
  when others then return null;
end
$$;

create or replace function public.dd008d_safe_nonnegative_integer(p_value text, p_default integer default 0)
returns integer
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_value numeric;
begin
  if coalesce(btrim(p_value), '') !~ '^[0-9]+$' then return p_default; end if;
  v_value := p_value::numeric;
  if v_value > 2147483647 then return p_default; end if;
  return v_value::integer;
exception
  when others then return p_default;
end
$$;

create or replace function public.dd008d_preview_payload(p_location_id text, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sessions jsonb := public.dd008d_json_array(p_payload->'tableSessions');
  v_orders jsonb := public.dd008d_json_array(p_payload->'orders');
  v_requests jsonb := public.dd008d_json_array(p_payload->'serviceRequests');
  v_audit jsonb := public.dd008d_json_array(p_payload->'audit');
  v_products jsonb := public.dd008d_json_array(p_payload->'products');
  v_malformed_sessions integer;
  v_malformed_orders integer;
  v_malformed_requests integer;
  v_existing_sessions integer;
  v_existing_orders integer;
  v_existing_requests integer;
  v_existing_payments integer;
  v_line_count integer;
  v_payment_count integer;
begin
  select count(*) into v_malformed_sessions
  from jsonb_array_elements(v_sessions) item
  where btrim(coalesce(item->>'id', '')) = ''
     or btrim(coalesce(item->>'tableCode', '')) = '';

  select count(*) into v_malformed_orders
  from jsonb_array_elements(v_orders) item
  where btrim(coalesce(item->>'id', '')) = ''
     or btrim(coalesce(item->>'orderNo', '')) = ''
     or jsonb_typeof(item->'items') <> 'array';

  select count(*) into v_malformed_requests
  from jsonb_array_elements(v_requests) item
  where btrim(coalesce(item->>'id', '')) = ''
     or btrim(coalesce(item->>'type', '')) = '';

  select count(*) into v_existing_sessions
  from jsonb_array_elements(v_sessions) item
  join public.table_sessions on public.table_sessions.id = item->>'id'
  where public.table_sessions.location_id = p_location_id;

  select count(*) into v_existing_orders
  from jsonb_array_elements(v_orders) item
  join public.orders on public.orders.id = item->>'id'
  where public.orders.location_id = p_location_id;

  select count(*) into v_existing_requests
  from jsonb_array_elements(v_requests) item
  join public.service_requests on public.service_requests.id = item->>'id'
  where public.service_requests.location_id = p_location_id;

  select count(*) into v_line_count
  from jsonb_array_elements(v_orders) item
  cross join lateral jsonb_array_elements(public.dd008d_json_array(item->'items')) line_item;

  select count(*) into v_payment_count
  from jsonb_array_elements(v_orders) item
  cross join lateral jsonb_array_elements(public.dd008d_json_array(item->'payments')) payment_item;

  select count(*) into v_existing_payments
  from jsonb_array_elements(v_orders) item
  cross join lateral jsonb_array_elements(public.dd008d_json_array(item->'payments')) payment_item
  join public.payment_transactions on public.payment_transactions.id = payment_item->>'id'
  where public.payment_transactions.location_id = p_location_id;

  return jsonb_build_object(
    'counts', jsonb_build_object(
      'tableSessions', jsonb_array_length(v_sessions),
      'orders', jsonb_array_length(v_orders),
      'orderLines', v_line_count,
      'payments', v_payment_count,
      'serviceRequests', jsonb_array_length(v_requests),
      'audit', jsonb_array_length(v_audit),
      'products', jsonb_array_length(v_products)
    ),
    'malformed', jsonb_build_object(
      'tableSessions', v_malformed_sessions,
      'orders', v_malformed_orders,
      'serviceRequests', v_malformed_requests
    ),
    'existingAuthoritative', jsonb_build_object(
      'tableSessions', v_existing_sessions,
      'orders', v_existing_orders,
      'payments', v_existing_payments,
      'serviceRequests', v_existing_requests
    ),
    'policy', jsonb_build_object(
      'existingRecords', 'SKIP_NO_OVERWRITE',
      'malformedRecords', 'SKIP_AND_REPORT',
      'products', 'PREVIEW_ONLY_ADMIN_COMMAND_REQUIRED',
      'autoImport', false,
      'dualWrite', false
    )
  );
end
$$;

create or replace function public.dd008d_preview_legacy_import(
  p_location_id text,
  p_payload jsonb,
  p_import_key text,
  p_workstation_mode text default '',
  p_device_credential text default '',
  p_correlation_id text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_import_key text := nullif(btrim(coalesce(p_import_key, '')), '');
  v_schema_version integer := public.dd008d_safe_nonnegative_integer(p_payload->>'schemaVersion', 0);
  v_source text := coalesce(p_payload->>'source', '');
  v_payload_location text := coalesce(p_payload->>'locationId', '');
  v_hash text := public.dd008c_hash_request(p_payload);
  v_existing public.legacy_import_batches;
  v_preview jsonb;
  v_batch public.legacy_import_batches;
  v_result jsonb;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'migration.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  if v_import_key is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'IMPORT_KEY_REQUIRED');
    return;
  end if;
  if v_schema_version <> 1 then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'UNSUPPORTED_SCHEMA_VERSION');
    return;
  end if;
  if v_source <> 'DEEDOU_LOCAL_DEMO' then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_LEGACY_SOURCE');
    return;
  end if;
  if v_payload_location <> '' and v_payload_location <> p_location_id then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'LOCATION_MISMATCH');
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('dd008d-preview:' || p_location_id || ':' || v_import_key));
  select * into v_existing
  from public.legacy_import_batches
  where location_id = p_location_id and import_key = v_import_key
  for update;
  if v_existing.id is not null and v_existing.source_hash <> v_hash then
    return query select * from public.dd008c_failure('CONFLICT', 'IMPORT_KEY_REUSED');
    return;
  end if;

  v_preview := public.dd008d_preview_payload(p_location_id, p_payload);
  insert into public.legacy_import_batches (
    location_id, import_key, source_hash, schema_version, source, status, preview,
    staff_id, device_id, correlation_id
  ) values (
    p_location_id, v_import_key, v_hash, v_schema_version, v_source, 'PREVIEWED', v_preview,
    v_authz.staff_profile_id, v_authz.device_id, left(coalesce(p_correlation_id, ''), 160)
  )
  on conflict (location_id, import_key) do update
  set preview = excluded.preview,
      staff_id = excluded.staff_id,
      device_id = excluded.device_id,
      correlation_id = excluded.correlation_id
  returning * into v_batch;

  perform public.dd008c_write_audit(
    p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd008d_preview_legacy_import', 'legacy_import_batch', v_batch.id::text, 'OK',
    jsonb_build_object('correlationId', p_correlation_id, 'importKey', v_import_key, 'sourceHash', v_hash)
  );

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'legacy_import_batch', v_batch.id::text, null,
    jsonb_build_object('preview', v_preview, 'sourceHash', v_hash, 'status', v_batch.status)
  );
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd008d_map_legacy_id(
  p_location_id text,
  p_entity_type text,
  p_legacy_id text,
  p_authoritative_id text,
  p_batch_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.legacy_id_map (location_id, entity_type, legacy_id, authoritative_id, import_batch_id)
  values (p_location_id, p_entity_type, p_legacy_id, p_authoritative_id, p_batch_id)
  on conflict (location_id, entity_type, legacy_id) do nothing
$$;

create or replace function public.dd008d_import_legacy_data(
  p_location_id text,
  p_payload jsonb,
  p_import_key text,
  p_workstation_mode text default '',
  p_device_credential text default '',
  p_correlation_id text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_import_key text := nullif(btrim(coalesce(p_import_key, '')), '');
  v_hash text := public.dd008c_hash_request(p_payload);
  v_batch public.legacy_import_batches;
  v_item jsonb;
  v_line jsonb;
  v_payment jsonb;
  v_table record;
  v_table_id text;
  v_table_code text;
  v_table_zone text;
  v_session_id text;
  v_order_id text;
  v_status text;
  v_service_mode text;
  v_fulfillment text;
  v_source text;
  v_payment_status text;
  v_opened_at timestamptz;
  v_closed_at timestamptz;
  v_created_at timestamptz;
  v_line_id text;
  v_line_row_id text;
  v_qty integer;
  v_bill_qty integer;
  v_served_qty integer;
  v_amount integer;
  v_inserted_sessions integer := 0;
  v_inserted_orders integer := 0;
  v_inserted_lines integer := 0;
  v_inserted_payments integer := 0;
  v_inserted_requests integer := 0;
  v_inserted_audit integer := 0;
  v_skipped integer := 0;
  v_conflicts integer := 0;
  v_result_payload jsonb;
  v_result jsonb;
  v_audit_id uuid;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'migration.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  if v_import_key is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'IMPORT_KEY_REQUIRED');
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('dd008d-import:' || p_location_id || ':' || v_import_key));
  select * into v_batch
  from public.legacy_import_batches
  where location_id = p_location_id and import_key = v_import_key
  for update;
  if v_batch.id is null then
    return query select * from public.dd008c_failure('INVALID_STATE', 'PREVIEW_REQUIRED');
    return;
  end if;
  if v_batch.source_hash <> v_hash then
    return query select * from public.dd008c_failure('CONFLICT', 'PREVIEW_PAYLOAD_CHANGED');
    return;
  end if;
  if v_batch.status in ('IMPORTED', 'PARTIAL') then
    v_result := public.dd008c_result_json(true, 'OK', 'IDEMPOTENT_REPLAY', 'legacy_import_batch', v_batch.id::text, null, v_batch.result);
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;

  for v_item in select * from jsonb_array_elements(public.dd008d_json_array(p_payload->'tableSessions'))
  loop
    begin
      if btrim(coalesce(v_item->>'id', '')) = '' or btrim(coalesce(v_item->>'tableCode', '')) = '' then
        v_skipped := v_skipped + 1; continue;
      end if;
      if exists (select 1 from public.table_sessions where id = v_item->>'id') then
        v_conflicts := v_conflicts + 1;
        perform public.dd008d_map_legacy_id(p_location_id, 'table_session', v_item->>'id', v_item->>'id', v_batch.id);
        continue;
      end if;
      select * into v_table from public.physical_tables
      where location_id = p_location_id and code = v_item->>'tableCode' and is_active = true limit 1;
      if v_table.id is null then v_skipped := v_skipped + 1; continue; end if;
      v_status := upper(coalesce(nullif(btrim(v_item->>'status'), ''), 'OPEN'));
      if v_status not in ('OPEN', 'CLOSED', 'VOIDED') then v_skipped := v_skipped + 1; continue; end if;
      if v_status = 'OPEN' and exists (
        select 1 from public.table_sessions where physical_table_id = v_table.id and status = 'OPEN'
      ) then v_conflicts := v_conflicts + 1; continue; end if;
      v_opened_at := coalesce(public.dd008d_safe_timestamptz(v_item->>'openedAt'), now());
      v_closed_at := public.dd008d_safe_timestamptz(v_item->>'closedAt');
      if v_status <> 'OPEN' and v_closed_at is null then v_skipped := v_skipped + 1; continue; end if;
      insert into public.table_sessions (
        id, location_id, physical_table_id, table_code, zone, status, source, opened_at, closed_at, created_at
      ) values (
        v_item->>'id', p_location_id, v_table.id, v_table.code, v_table.zone, v_status,
        coalesce(nullif(v_item->>'source', ''), 'LEGACY_IMPORT'), v_opened_at,
        case when v_status = 'OPEN' then null else v_closed_at end, v_opened_at
      );
      v_inserted_sessions := v_inserted_sessions + 1;
      perform public.dd008d_map_legacy_id(p_location_id, 'table_session', v_item->>'id', v_item->>'id', v_batch.id);
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  for v_item in select * from jsonb_array_elements(public.dd008d_json_array(p_payload->'orders'))
  loop
    begin
      v_order_id := btrim(coalesce(v_item->>'id', ''));
      if v_order_id = '' or btrim(coalesce(v_item->>'orderNo', '')) = '' or jsonb_typeof(v_item->'items') <> 'array' then
        v_skipped := v_skipped + 1; continue;
      end if;
      if exists (select 1 from public.orders where id = v_order_id or (location_id = p_location_id and order_no = v_item->>'orderNo')) then
        v_conflicts := v_conflicts + 1;
        if exists (select 1 from public.orders where id = v_order_id and location_id = p_location_id) then
          perform public.dd008d_map_legacy_id(p_location_id, 'order', v_order_id, v_order_id, v_batch.id);
        end if;
        continue;
      end if;

      v_fulfillment := upper(coalesce(nullif(v_item->>'fulfillmentType', ''), 'DINE_IN'));
      if v_fulfillment not in ('DINE_IN', 'TAKEAWAY') then v_fulfillment := 'DINE_IN'; end if;
      v_service_mode := upper(coalesce(nullif(v_item->>'serviceMode', ''), case when v_fulfillment = 'TAKEAWAY' then 'COUNTER_SERVICE' else 'TABLE_SERVICE' end));
      if v_service_mode not in ('COUNTER_SERVICE', 'TABLE_SERVICE') then v_service_mode := 'COUNTER_SERVICE'; end if;
      v_source := upper(coalesce(nullif(v_item->>'orderSource', ''), 'COUNTER'));
      if v_source not in ('CUSTOMER_QR', 'STAFF', 'COUNTER') then v_source := 'COUNTER'; end if;
      v_status := upper(coalesce(nullif(v_item->>'status', ''), 'PENDING_ACCEPTANCE'));
      if v_status not in ('PENDING_ACCEPTANCE','ACCEPTED','REJECTED','IN_PREPARATION','READY','SERVED','PAID','VOIDED','REFUNDED','PARTIALLY_REFUNDED') then
        v_skipped := v_skipped + 1; continue;
      end if;
      v_payment_status := upper(coalesce(nullif(v_item->>'paymentStatus', ''), case when v_status = 'PAID' then 'PAID' else 'UNPAID' end));
      if v_payment_status not in ('UNPAID','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED','REFUNDED') then v_payment_status := 'UNPAID'; end if;

      v_session_id := nullif(btrim(coalesce(v_item->>'tableSessionId', '')), '');
      v_table_id := null; v_table_code := ''; v_table_zone := '';
      if btrim(coalesce(v_item->>'table', '')) <> '' then
        select id, code, zone into v_table_id, v_table_code, v_table_zone from public.physical_tables
        where location_id = p_location_id and code = v_item->>'table' and is_active = true limit 1;
      end if;
      if v_service_mode = 'TABLE_SERVICE' then
        if v_session_id is null or not exists (select 1 from public.table_sessions where id = v_session_id and location_id = p_location_id) or v_table_id is null then
          v_skipped := v_skipped + 1; continue;
        end if;
      else
        v_session_id := null;
      end if;

      v_created_at := coalesce(public.dd008d_safe_timestamptz(v_item->>'createdAt'), now());
      insert into public.orders (
        id, location_id, order_no, table_session_id, physical_table_id, service_mode, fulfillment_type,
        order_source, zone, table_code, status, total_vnd, paid_vnd, payment_status, note,
        created_at, submitted_at, accepted_at, prep_started_at, ready_at, served_at, paid_at
      ) values (
        v_order_id, p_location_id, v_item->>'orderNo', v_session_id,
        case when v_service_mode = 'TABLE_SERVICE' then v_table_id else null end,
        v_service_mode, v_fulfillment, v_source,
        case when v_service_mode = 'TABLE_SERVICE' then v_table_zone else coalesce(v_item->>'zone', '') end,
        case when v_service_mode = 'TABLE_SERVICE' then v_table_code else '' end,
        v_status,
        public.dd008d_safe_nonnegative_integer(v_item->>'total', 0),
        public.dd008d_safe_nonnegative_integer(v_item->>'paidVnd', 0),
        v_payment_status, coalesce(v_item->>'note', ''), v_created_at,
        public.dd008d_safe_timestamptz(v_item->>'submittedAt'),
        public.dd008d_safe_timestamptz(v_item->>'acceptedAt'),
        public.dd008d_safe_timestamptz(v_item->>'prepStartedAt'),
        public.dd008d_safe_timestamptz(v_item->>'readyAt'),
        public.dd008d_safe_timestamptz(v_item->>'servedAt'),
        public.dd008d_safe_timestamptz(v_item->>'paidAt')
      );
      v_inserted_orders := v_inserted_orders + 1;
      perform public.dd008d_map_legacy_id(p_location_id, 'order', v_order_id, v_order_id, v_batch.id);

      for v_line in select * from jsonb_array_elements(public.dd008d_json_array(v_item->'items'))
      loop
        begin
          v_line_id := btrim(coalesce(v_line->>'lineId', ''));
          v_qty := public.dd008d_safe_nonnegative_integer(v_line->>'qty', 0);
          if v_line_id = '' or v_qty <= 0 or btrim(coalesce(v_line->>'station', '')) = '' then
            v_skipped := v_skipped + 1; continue;
          end if;
          v_bill_qty := least(v_qty, public.dd008d_safe_nonnegative_integer(v_line->>'billQty', v_qty));
          v_served_qty := least(v_qty, public.dd008d_safe_nonnegative_integer(v_line->>'servedQty', 0));
          v_line_row_id := 'LEG-' || substr(encode(extensions.digest(convert_to(v_order_id || ':' || v_line_id, 'utf8'), 'sha256'), 'hex'), 1, 40);
          insert into public.order_lines (
            id, order_id, line_id, product_id, station_code, name_vi, name_en, qty, bill_qty, served_qty,
            prep_status, item_status, base_price_vnd, price_vnd, is_billable, is_component,
            parent_combo_id, parent_line_id, parent_combo_name_vi, parent_combo_name_en,
            parent_combo_option_summary_vi, parent_combo_option_summary_en,
            configured_key, configured_options, option_snapshot, course, hold_state,
            held_at, fired_at, queued_at, acknowledged_at, prep_started_at, ready_at, served_at
          ) values (
            v_line_row_id, v_order_id, v_line_id, nullif(v_line->>'id', ''), v_line->>'station',
            coalesce(nullif(v_line->>'nameVi', ''), v_line->>'id', v_line_id),
            coalesce(nullif(v_line->>'nameEn', ''), v_line->>'id', v_line_id),
            v_qty, v_bill_qty, v_served_qty,
            case when upper(coalesce(v_line->>'prepStatus', 'QUEUED')) in ('QUEUED','ACKNOWLEDGED','PREPARING','READY') then upper(coalesce(v_line->>'prepStatus','QUEUED')) else 'QUEUED' end,
            coalesce(nullif(v_line->>'status', ''), 'QUEUED'),
            public.dd008d_safe_nonnegative_integer(v_line->>'basePrice', 0),
            public.dd008d_safe_nonnegative_integer(v_line->>'price', 0),
            coalesce((v_line->>'isBillable')::boolean, true),
            coalesce((v_line->>'isComponent')::boolean, false),
            coalesce(v_line->>'parentComboId', ''), coalesce(v_line->>'parentLineId', ''),
            coalesce(v_line->>'parentComboNameVi', ''), coalesce(v_line->>'parentComboNameEn', ''),
            coalesce(v_line->'parentComboOptionSummaryVi', '[]'::jsonb),
            coalesce(v_line->'parentComboOptionSummaryEn', '[]'::jsonb),
            coalesce(v_line->>'configuredKey', ''), v_line->'configuredOptions', v_line->'optionSnapshot',
            nullif(v_line->>'course', ''),
            case when upper(coalesce(v_line->>'holdState', 'FIRED')) = 'HELD' then 'HELD' else 'FIRED' end,
            public.dd008d_safe_timestamptz(v_line->>'heldAt'), public.dd008d_safe_timestamptz(v_line->>'firedAt'),
            public.dd008d_safe_timestamptz(v_line->>'queuedAt'), public.dd008d_safe_timestamptz(v_line->>'acknowledgedAt'),
            public.dd008d_safe_timestamptz(v_line->>'prepStartedAt'), public.dd008d_safe_timestamptz(v_line->>'readyAt'),
            public.dd008d_safe_timestamptz(v_line->>'servedAt')
          );
          v_inserted_lines := v_inserted_lines + 1;
          perform public.dd008d_map_legacy_id(p_location_id, 'order_line', v_order_id || ':' || v_line_id, v_line_row_id, v_batch.id);
        exception when others then
          v_skipped := v_skipped + 1;
        end;
      end loop;

      for v_payment in select * from jsonb_array_elements(public.dd008d_json_array(v_item->'payments'))
      loop
        begin
          v_amount := public.dd008d_safe_nonnegative_integer(v_payment->>'amountVnd', 0);
          if btrim(coalesce(v_payment->>'id', '')) = '' or v_amount <= 0 then v_skipped := v_skipped + 1; continue; end if;
          if exists (select 1 from public.payment_transactions where id = v_payment->>'id') then
            v_conflicts := v_conflicts + 1; continue;
          end if;
          insert into public.payment_transactions (
            id, location_id, order_id, type, method, provider, amount_vnd, related_payment_id,
            tender_group_id, created_at, note
          ) values (
            v_payment->>'id', p_location_id, v_order_id,
            case when upper(coalesce(v_payment->>'type','PAYMENT')) in ('PAYMENT','PAYMENT_VOID','REFUND') then upper(coalesce(v_payment->>'type','PAYMENT')) else 'PAYMENT' end,
            coalesce(nullif(v_payment->>'method',''), 'CASH'), coalesce(nullif(v_payment->>'provider',''), 'MANUAL'),
            v_amount, nullif(v_payment->>'relatedPaymentId',''), coalesce(v_payment->>'tenderGroupId',''),
            coalesce(public.dd008d_safe_timestamptz(v_payment->>'createdAt'), v_created_at), coalesce(v_payment->>'note','LEGACY_IMPORT')
          );
          v_inserted_payments := v_inserted_payments + 1;
          perform public.dd008d_map_legacy_id(p_location_id, 'payment', v_payment->>'id', v_payment->>'id', v_batch.id);
        exception when others then
          v_skipped := v_skipped + 1;
        end;
      end loop;
    exception when others then
      delete from public.orders where id = v_order_id and location_id = p_location_id;
      v_skipped := v_skipped + 1;
    end;
  end loop;

  for v_item in select * from jsonb_array_elements(public.dd008d_json_array(p_payload->'serviceRequests'))
  loop
    begin
      if btrim(coalesce(v_item->>'id','')) = '' or btrim(coalesce(v_item->>'type','')) = '' then v_skipped := v_skipped + 1; continue; end if;
      if exists (select 1 from public.service_requests where id = v_item->>'id') then v_conflicts := v_conflicts + 1; continue; end if;
      v_session_id := nullif(v_item->>'tableSessionId','');
      v_table_id := null; v_table_code := ''; v_table_zone := '';
      if btrim(coalesce(v_item->>'table','')) <> '' then
        select id, code, zone into v_table_id, v_table_code, v_table_zone from public.physical_tables where location_id = p_location_id and code = v_item->>'table' limit 1;
      end if;
      insert into public.service_requests (
        id, location_id, table_session_id, physical_table_id, table_code, zone, type, status, created_at, completed_at
      ) values (
        v_item->>'id', p_location_id,
        case when v_session_id is not null and exists (select 1 from public.table_sessions where id = v_session_id and location_id = p_location_id) then v_session_id else null end,
        v_table_id, coalesce(nullif(v_table_code,''), v_item->>'table', ''), coalesce(nullif(v_table_zone,''), v_item->>'zone', ''),
        case when upper(v_item->>'type') in ('BILL_REQUEST','REQUEST_BILL') then 'BILL_REQUEST' else 'CALL_STAFF' end,
        case when upper(coalesce(v_item->>'status','OPEN')) in ('OPEN','COMPLETED','VOIDED') then upper(coalesce(v_item->>'status','OPEN')) else 'OPEN' end,
        coalesce(public.dd008d_safe_timestamptz(v_item->>'createdAt'), now()), public.dd008d_safe_timestamptz(v_item->>'completedAt')
      );
      v_inserted_requests := v_inserted_requests + 1;
      perform public.dd008d_map_legacy_id(p_location_id, 'service_request', v_item->>'id', v_item->>'id', v_batch.id);
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  for v_item in select * from jsonb_array_elements(public.dd008d_json_array(p_payload->'audit'))
  loop
    begin
      if btrim(coalesce(v_item->>'id','')) = '' then v_skipped := v_skipped + 1; continue; end if;
      if exists (select 1 from public.legacy_id_map where location_id = p_location_id and entity_type = 'audit_event' and legacy_id = v_item->>'id') then
        v_conflicts := v_conflicts + 1; continue;
      end if;
      v_audit_id := gen_random_uuid();
      insert into public.audit_events (
        id, location_id, actor_type, actor_id, staff_id, device_id, command, target_type, target_id,
        outcome, correlation_id, metadata, created_at
      ) values (
        v_audit_id, p_location_id, 'LEGACY_IMPORT', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id,
        coalesce(nullif(v_item->>'command',''), 'legacy_event'), coalesce(v_item->>'targetType',''), coalesce(v_item->>'targetId',''),
        coalesce(nullif(v_item->>'outcome',''), 'LEGACY'), coalesce(v_item->>'correlationId',''),
        coalesce(v_item->'metadata','{}'::jsonb) || jsonb_build_object('legacyEventId', v_item->>'id'),
        coalesce(public.dd008d_safe_timestamptz(v_item->>'createdAt'), now())
      );
      v_inserted_audit := v_inserted_audit + 1;
      perform public.dd008d_map_legacy_id(p_location_id, 'audit_event', v_item->>'id', v_audit_id::text, v_batch.id);
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  v_result_payload := jsonb_build_object(
    'inserted', jsonb_build_object(
      'tableSessions', v_inserted_sessions,
      'orders', v_inserted_orders,
      'orderLines', v_inserted_lines,
      'payments', v_inserted_payments,
      'serviceRequests', v_inserted_requests,
      'audit', v_inserted_audit
    ),
    'skipped', v_skipped,
    'conflicts', v_conflicts,
    'policy', jsonb_build_object('overwriteExisting', false, 'productsImported', false, 'autoImport', false)
  );

  update public.legacy_import_batches
  set status = case when v_skipped > 0 or v_conflicts > 0 then 'PARTIAL' else 'IMPORTED' end,
      result = v_result_payload,
      imported_at = now(),
      staff_id = v_authz.staff_profile_id,
      device_id = v_authz.device_id,
      correlation_id = left(coalesce(p_correlation_id,''),160)
  where id = v_batch.id
  returning * into v_batch;

  perform public.dd008c_write_audit(
    p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd008d_import_legacy_data', 'legacy_import_batch', v_batch.id::text, v_batch.status,
    jsonb_build_object('correlationId', p_correlation_id, 'importKey', v_import_key, 'result', v_result_payload)
  );
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'legacy_import_batch', v_batch.id::text, jsonb_build_object('reason','LEGACY_IMPORT'));
  perform public.dd008c_emit_refresh(p_location_id, 'cashier', 'legacy_import_batch', v_batch.id::text, jsonb_build_object('reason','LEGACY_IMPORT'));

  v_result := public.dd008c_result_json(true, 'OK', v_batch.status, 'legacy_import_batch', v_batch.id::text, null, v_result_payload);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

-- Upgrade DD-008C audit writer so every server mutation has a safe correlation identifier.
-- Existing callers need no signature changes; explicit correlationId metadata wins, otherwise the DB transaction id is used.
create or replace function public.dd008c_write_audit(
  p_location_id text,
  p_actor_type text,
  p_actor_id text,
  p_staff_id text,
  p_device_id text,
  p_command text,
  p_target_type text,
  p_target_id text,
  p_outcome text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    location_id, actor_type, actor_id, staff_id, device_id, command, target_type, target_id,
    outcome, correlation_id, metadata
  ) values (
    p_location_id, coalesce(p_actor_type,''), coalesce(p_actor_id,''), coalesce(p_staff_id,''), coalesce(p_device_id,''),
    coalesce(p_command,''), coalesce(p_target_type,''), coalesce(p_target_id,''), coalesce(p_outcome,''),
    coalesce(nullif(coalesce(p_metadata,'{}'::jsonb)->>'correlationId',''), 'dbtx:' || txid_current()::text),
    coalesce(p_metadata,'{}'::jsonb)
  )
$$;

create or replace function public.dd008d_production_readiness(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default '',
  p_correlation_id text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_rls_missing integer;
  v_broad_write_grants integer;
  v_realtime_policy boolean;
  v_payload jsonb;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'migration.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason,'PERMISSION_DENIED'));
    return;
  end if;

  select count(*) into v_rls_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any(array[
      'locations','physical_tables','products','product_variants','modifier_groups','modifier_options',
      'product_modifier_groups','product_components','table_sessions','orders','order_lines','service_requests',
      'payment_transactions','idempotency_keys','audit_events','command_deduplication',
      'dd008c_refresh_hints','dd008c_realtime_subscription_tickets','legacy_import_batches','legacy_id_map'
    ])
    and c.relrowsecurity is distinct from true;

  select count(*) into v_broad_write_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon','authenticated')
    and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
    and table_name = any(array[
      'locations','physical_tables','products','product_variants','modifier_groups','modifier_options',
      'product_modifier_groups','product_components','table_sessions','orders','order_lines','service_requests',
      'payment_transactions','idempotency_keys','audit_events','command_deduplication','legacy_import_batches','legacy_id_map'
    ]);

  select exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'realtime' and tablename = 'messages' and policyname = 'dd008c_realtime_messages_staff_location_read'
  ) into v_realtime_policy;

  v_payload := jsonb_build_object(
    'database', jsonb_build_object(
      'rlsMissingCount', v_rls_missing,
      'broadWriteGrantCount', v_broad_write_grants,
      'privateRealtimePolicy', v_realtime_policy,
      'migrationLedgerRls', true
    ),
    'browser', jsonb_build_object(
      'serviceRoleKeyAllowed', false,
      'dualWriteAllowed', false,
      'legacyAutoImportAllowed', false
    ),
    'deploymentChecks', jsonb_build_object(
      'signupPolicy', 'VERIFY_PRODUCTION_PROJECT_CONFIG',
      'redirectOrigins', 'VERIFY_PRODUCTION_PROJECT_CONFIG',
      'backupsPitr', 'VERIFY_PLAN_AND_ENABLE_IF_AVAILABLE',
      'demoCredentials', 'MUST_BE_ABSENT',
      'sensitiveFunctionRateLimits', 'EDGE_OR_GATEWAY_REQUIRED',
      'auditRetention', 'DOCUMENTED_IN_RUNBOOK',
      'dependencyLock', 'PACKAGE_LOCK_REQUIRED'
    ),
    'blockingChecksOk', (v_rls_missing = 0 and v_broad_write_grants = 0 and v_realtime_policy)
  );

  return query select * from public.dd008c_success('production_readiness', p_location_id, null, v_payload);
end
$$;

revoke all on function public.dd008d_json_array(jsonb) from public;
revoke all on function public.dd008d_safe_timestamptz(text) from public;
revoke all on function public.dd008d_safe_nonnegative_integer(text, integer) from public;
revoke all on function public.dd008d_preview_payload(text, jsonb) from public;
revoke all on function public.dd008d_map_legacy_id(text, text, text, text, uuid) from public;
revoke all on function public.dd008d_preview_legacy_import(text, jsonb, text, text, text, text) from public;
revoke all on function public.dd008d_import_legacy_data(text, jsonb, text, text, text, text) from public;
revoke all on function public.dd008d_production_readiness(text, text, text, text) from public;

grant execute on function public.dd008d_preview_legacy_import(text, jsonb, text, text, text, text) to authenticated;
grant execute on function public.dd008d_import_legacy_data(text, jsonb, text, text, text, text) to authenticated;
grant execute on function public.dd008d_production_readiness(text, text, text, text) to authenticated;
