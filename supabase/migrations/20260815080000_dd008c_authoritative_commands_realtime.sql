-- DD-008C authoritative commands + realtime refresh hints.
-- DD-008A/DD-008B migrations remain append-only foundations.

alter table public.orders
  add column if not exists version integer not null default 1;

alter table public.table_sessions
  add column if not exists version integer not null default 1;

alter table public.service_requests
  add column if not exists version integer not null default 1;

create table if not exists public.dd008c_refresh_hints (
  id uuid primary key default gen_random_uuid(),
  location_id text not null references public.locations(id) on delete cascade,
  topic text not null,
  audience text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.dd008c_refresh_hints enable row level security;
revoke all on public.dd008c_refresh_hints from anon, authenticated;

drop policy if exists dd008c_refresh_hints_staff_location_read on public.dd008c_refresh_hints;
create policy dd008c_refresh_hints_staff_location_read
on public.dd008c_refresh_hints
for select
to authenticated
using (public.has_location_access(location_id));

grant select on public.dd008c_refresh_hints to authenticated;

do $$
begin
  execute $policy$
    create policy dd008c_realtime_messages_staff_location_read
    on realtime.messages
    for select
    to authenticated
    using (
      split_part(realtime.topic(), ':', 1) = 'location'
      and public.has_location_access(split_part(realtime.topic(), ':', 2))
    )
  $policy$;
exception
  when duplicate_object or invalid_schema_name or undefined_table or undefined_function then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.dd008c_refresh_hints;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

create or replace function public.dd008c_result_json(
  p_ok boolean,
  p_category text,
  p_reason text default '',
  p_entity_type text default '',
  p_entity_id text default '',
  p_version integer default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', p_ok,
    'category', coalesce(nullif(btrim(p_category), ''), case when p_ok then 'OK' else 'VALIDATION_ERROR' end),
    'reason', coalesce(p_reason, ''),
    'entityType', coalesce(p_entity_type, ''),
    'entityId', coalesce(p_entity_id, ''),
    'version', p_version,
    'payload', coalesce(p_payload, '{}'::jsonb)
  )
$$;

create or replace function public.dd008c_result_from_json(p_result jsonb)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((p_result->>'ok')::boolean, false),
    coalesce(p_result->>'category', 'BACKEND_UNAVAILABLE'),
    coalesce(p_result->>'reason', ''),
    coalesce(p_result->>'entityType', ''),
    coalesce(p_result->>'entityId', ''),
    nullif(p_result->>'version', '')::integer,
    coalesce(p_result->'payload', '{}'::jsonb)
$$;

create or replace function public.dd008c_success(
  p_entity_type text default '',
  p_entity_id text default '',
  p_version integer default null,
  p_payload jsonb default '{}'::jsonb
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.dd008c_result_from_json(
    public.dd008c_result_json(true, 'OK', '', p_entity_type, p_entity_id, p_version, p_payload)
  )
$$;

create or replace function public.dd008c_failure(
  p_category text,
  p_reason text,
  p_entity_type text default '',
  p_entity_id text default '',
  p_payload jsonb default '{}'::jsonb
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.dd008c_result_from_json(
    public.dd008c_result_json(false, p_category, p_reason, p_entity_type, p_entity_id, null, p_payload)
  )
$$;

create or replace function public.dd008c_hash_request(p_payload jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(coalesce(p_payload, '{}'::jsonb)::text, 'utf8'), 'sha256'), 'hex')
$$;

create or replace function public.dd008c_replay_command(
  p_location_id text,
  p_command text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_existing public.command_deduplication;
begin
  if v_key is null then
    return public.dd008c_result_json(false, 'VALIDATION_ERROR', 'IDEMPOTENCY_KEY_REQUIRED', '', '', null, '{}'::jsonb);
  end if;

  perform pg_advisory_xact_lock(hashtext(p_location_id || ':' || p_command || ':' || v_key));
  select * into v_existing
  from public.command_deduplication
  where public.command_deduplication.location_id = p_location_id
    and public.command_deduplication.command_key = v_key
    and public.command_deduplication.command = p_command
  for update;

  if v_existing.id is null then
    return null;
  end if;
  if v_existing.request_hash <> p_request_hash then
    return public.dd008c_result_json(false, 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED', '', '', null, '{}'::jsonb);
  end if;
  return v_existing.result_reference::jsonb;
end
$$;

create or replace function public.dd008c_store_command(
  p_location_id text,
  p_command text,
  p_idempotency_key text,
  p_actor_type text,
  p_actor_id text,
  p_request_hash text,
  p_result jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if v_key is null then
    return;
  end if;
  insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
  values (p_location_id, v_key, p_command, p_actor_type, p_actor_id, p_request_hash, p_result::text);
end
$$;

create or replace function public.dd008c_normalize_positive_integer(p_value jsonb)
returns integer
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_text text;
  v_number numeric;
begin
  if p_value is null or p_value = 'null'::jsonb then
    return null;
  end if;

  if jsonb_typeof(p_value) = 'number' then
    v_text := p_value #>> '{}';
    if v_text !~ '^[1-9][0-9]*$' then
      return null;
    end if;
    v_number := v_text::numeric;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := btrim(p_value #>> '{}');
    if v_text !~ '^[1-9][0-9]*$' then
      return null;
    end if;
    v_number := v_text::numeric;
  else
    return null;
  end if;

  if v_number > 2147483647 then
    return null;
  end if;

  return v_number::integer;
end
$$;

create or replace function public.dd008c_emit_refresh(
  p_location_id text,
  p_audience text,
  p_entity_type text,
  p_entity_id text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_topic text := 'location:' || p_location_id || ':' || coalesce(nullif(btrim(p_audience), ''), 'ops');
  v_payload jsonb := jsonb_build_object(
    'locationId', p_location_id,
    'audience', p_audience,
    'entityType', p_entity_type,
    'entityId', p_entity_id,
    'at', now()
  ) || coalesce(p_payload, '{}'::jsonb);
begin
  insert into public.dd008c_refresh_hints (location_id, topic, audience, entity_type, entity_id, payload)
  values (p_location_id, v_topic, coalesce(nullif(btrim(p_audience), ''), 'ops'), p_entity_type, p_entity_id, v_payload);

  perform pg_notify('dd008c_refresh', v_payload::text);

  begin
    perform realtime.send(v_payload, 'refresh', v_topic, true);
  exception
    when undefined_function or invalid_schema_name then null;
  end;
end
$$;

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
    location_id,
    actor_type,
    actor_id,
    staff_id,
    device_id,
    command,
    target_type,
    target_id,
    outcome,
    metadata
  )
  values (
    p_location_id,
    coalesce(p_actor_type, ''),
    coalesce(p_actor_id, ''),
    coalesce(p_staff_id, ''),
    coalesce(p_device_id, ''),
    coalesce(p_command, ''),
    coalesce(p_target_type, ''),
    coalesce(p_target_id, ''),
    coalesce(p_outcome, ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
$$;

create or replace function public.dd008c_payment_status_for_order(p_order_id text)
returns table (
  effective_paid_vnd integer,
  refunded_vnd integer,
  refundable_vnd integer,
  payment_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  with payments as (
    select public.payment_transactions.*
    from public.payment_transactions
    where public.payment_transactions.order_id = p_order_id
      and public.payment_transactions.status = 'SUCCEEDED'
  ),
  originals as (
    select p.*
    from payments p
    where p.type = 'PAYMENT'
      and not exists (
        select 1
        from payments v
        where v.type = 'PAYMENT_VOID'
          and v.related_payment_id = p.id
      )
  ),
  refund_totals as (
    select
      r.related_payment_id,
      least(o.amount_vnd, coalesce(sum(r.amount_vnd), 0)) as refunded_vnd
    from payments r
    join originals o on o.id = r.related_payment_id
    where r.type = 'REFUND'
    group by r.related_payment_id, o.amount_vnd
  ),
  totals as (
    select
      coalesce((select sum(amount_vnd) from originals), 0)::integer as effective_paid_vnd,
      coalesce((select sum(refunded_vnd) from refund_totals), 0)::integer as refunded_vnd
  )
  select
    totals.effective_paid_vnd,
    totals.refunded_vnd,
    greatest(0, totals.effective_paid_vnd - totals.refunded_vnd)::integer,
    case
      when totals.refunded_vnd > 0 and totals.refunded_vnd >= totals.effective_paid_vnd then 'REFUNDED'
      when totals.refunded_vnd > 0 then 'PARTIALLY_REFUNDED'
      when totals.effective_paid_vnd >= public.orders.total_vnd and public.orders.total_vnd > 0 then 'PAID'
      when totals.effective_paid_vnd > 0 then 'PARTIALLY_PAID'
      else 'UNPAID'
    end
  from totals
  join public.orders on public.orders.id = p_order_id
$$;

create or replace function public.dd008c_is_order_service_complete(p_order_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select bool_and(public.order_lines.served_qty >= public.order_lines.qty)
    from public.order_lines
    where public.order_lines.order_id = p_order_id
      and public.order_lines.station_code <> 'COMBO'
      and public.order_lines.is_meta = false
  ), false)
$$;

create or replace function public.dd008c_sync_payment_projection(p_order_id text, p_bump_version boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_summary record;
  v_service_complete boolean;
  v_current_status text;
begin
  select * into v_summary
  from public.dd008c_payment_status_for_order(p_order_id)
  limit 1;

  select public.orders.status into v_current_status
  from public.orders
  where public.orders.id = p_order_id;

  v_service_complete := v_current_status in ('SERVED', 'PAID', 'REFUNDED', 'PARTIALLY_REFUNDED')
    or public.dd008c_is_order_service_complete(p_order_id);

  update public.orders
  set paid_vnd = coalesce(v_summary.effective_paid_vnd, 0),
      payment_status = coalesce(v_summary.payment_status, 'UNPAID'),
      status = case
        when v_service_complete and coalesce(v_summary.payment_status, 'UNPAID') = 'REFUNDED' then 'REFUNDED'
        when v_service_complete and coalesce(v_summary.payment_status, 'UNPAID') = 'PAID' then 'PAID'
        when v_current_status = 'PAID' and not v_service_complete then 'SERVED'
        else v_current_status
      end,
      paid_at = case
        when v_service_complete and coalesce(v_summary.payment_status, 'UNPAID') = 'PAID' and public.orders.paid_at is null then now()
        else public.orders.paid_at
      end,
      version = case when p_bump_version then public.orders.version + 1 else public.orders.version end
  where public.orders.id = p_order_id;
end
$$;

create or replace function public.dd008c_refresh_order_status(p_order_id text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current text;
  v_required_count integer;
  v_served_count integer;
  v_remaining_count integer;
  v_remaining_ready_count integer;
  v_touched_count integer;
  v_next text;
begin
  select public.orders.status into v_current
  from public.orders
  where public.orders.id = p_order_id;

  if v_current in ('REJECTED', 'PAID', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED') then
    return v_current;
  end if;

  select
    count(*),
    count(*) filter (where public.order_lines.served_qty >= public.order_lines.qty),
    count(*) filter (where public.order_lines.served_qty < public.order_lines.qty),
    count(*) filter (where public.order_lines.served_qty < public.order_lines.qty and public.order_lines.prep_status = 'READY'),
    count(*) filter (where public.order_lines.prep_status in ('ACKNOWLEDGED', 'PREPARING', 'READY') or public.order_lines.served_qty > 0)
  into v_required_count, v_served_count, v_remaining_count, v_remaining_ready_count, v_touched_count
  from public.order_lines
  where public.order_lines.order_id = p_order_id
    and public.order_lines.station_code <> 'COMBO'
    and public.order_lines.is_meta = false;

  if coalesce(v_required_count, 0) = 0 then
    return v_current;
  elsif v_served_count = v_required_count then
    v_next := 'SERVED';
  elsif v_remaining_count > 0 and v_remaining_ready_count = v_remaining_count then
    v_next := 'READY';
  elsif v_touched_count > 0 or v_current in ('IN_PREPARATION', 'READY') then
    v_next := 'IN_PREPARATION';
  else
    v_next := v_current;
  end if;

  update public.orders
  set status = v_next,
      prep_started_at = case when v_next = 'IN_PREPARATION' and public.orders.prep_started_at is null then now() else public.orders.prep_started_at end,
      ready_at = case when v_next = 'READY' and public.orders.ready_at is null then now() else public.orders.ready_at end,
      served_at = case when v_next = 'SERVED' and public.orders.served_at is null then now() else public.orders.served_at end
  where public.orders.id = p_order_id;

  perform public.dd008c_sync_payment_projection(p_order_id, false);
  return v_next;
end
$$;

create or replace function public.dd008c_order_payload(p_order_id text, p_include_payments boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', public.orders.id,
    'orderNo', public.orders.order_no,
    'tableSessionId', coalesce(public.orders.table_session_id, ''),
    'table', coalesce(public.orders.table_code, ''),
    'zone', coalesce(public.orders.zone, ''),
    'serviceMode', public.orders.service_mode,
    'fulfillmentType', public.orders.fulfillment_type,
    'orderSource', public.orders.order_source,
    'channel', case
      when public.orders.order_source = 'CUSTOMER_QR' then 'QR'
      when public.orders.fulfillment_type = 'TAKEAWAY' then 'TAKEAWAY'
      else 'CASHIER'
    end,
    'status', public.orders.status,
    'stationStatus', public.orders.station_status,
    'total', public.orders.total_vnd,
    'paidVnd', public.orders.paid_vnd,
    'paymentStatus', public.orders.payment_status,
    'note', public.orders.note,
    'createdAt', public.orders.created_at,
    'submittedAt', public.orders.submitted_at,
    'acceptedAt', public.orders.accepted_at,
    'prepStartedAt', public.orders.prep_started_at,
    'readyAt', public.orders.ready_at,
    'servedAt', public.orders.served_at,
    'paidAt', public.orders.paid_at,
    'version', public.orders.version,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', coalesce(public.order_lines.product_id, ''),
        'lineId', public.order_lines.line_id,
        'qty', public.order_lines.qty,
        'billQty', public.order_lines.bill_qty,
        'servedQty', public.order_lines.served_qty,
        'station', public.order_lines.station_code,
        'nameVi', public.order_lines.name_vi,
        'nameEn', public.order_lines.name_en,
        'basePrice', public.order_lines.base_price_vnd,
        'price', public.order_lines.price_vnd,
        'status', public.order_lines.item_status,
        'prepStatus', public.order_lines.prep_status,
        'isBillable', public.order_lines.is_billable,
        'isComponent', public.order_lines.is_component,
        'parentComboId', public.order_lines.parent_combo_id,
        'parentLineId', public.order_lines.parent_line_id,
        'parentComboNameVi', public.order_lines.parent_combo_name_vi,
        'parentComboNameEn', public.order_lines.parent_combo_name_en,
        'parentComboOptionSummaryVi', public.order_lines.parent_combo_option_summary_vi,
        'parentComboOptionSummaryEn', public.order_lines.parent_combo_option_summary_en,
        'configuredKey', public.order_lines.configured_key,
        'configuredOptions', public.order_lines.configured_options,
        'optionSnapshot', public.order_lines.option_snapshot,
        'course', coalesce(public.order_lines.course, ''),
        'holdState', public.order_lines.hold_state,
        'heldAt', public.order_lines.held_at,
        'firedAt', public.order_lines.fired_at,
        'queuedAt', public.order_lines.queued_at,
        'acknowledgedAt', public.order_lines.acknowledged_at,
        'prepStartedAt', public.order_lines.prep_started_at,
        'readyAt', public.order_lines.ready_at,
        'servedAt', public.order_lines.served_at
      ) order by public.order_lines.id)
      from public.order_lines
      where public.order_lines.order_id = public.orders.id
    ), '[]'::jsonb),
    'payments', case when p_include_payments then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', public.payment_transactions.id,
        'type', public.payment_transactions.type,
        'method', public.payment_transactions.method,
        'provider', public.payment_transactions.provider,
        'amountVnd', public.payment_transactions.amount_vnd,
        'status', public.payment_transactions.status,
        'relatedPaymentId', coalesce(public.payment_transactions.related_payment_id, ''),
        'tenderGroupId', public.payment_transactions.tender_group_id,
        'createdAt', public.payment_transactions.created_at,
        'note', public.payment_transactions.note
      ) order by public.payment_transactions.created_at, public.payment_transactions.id)
      from public.payment_transactions
      where public.payment_transactions.order_id = public.orders.id
    ), '[]'::jsonb) else '[]'::jsonb end
  )
  from public.orders
  where public.orders.id = p_order_id
$$;

create or replace function public.dd008c_table_session_payload(p_session_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', public.table_sessions.id,
    'tableCode', public.table_sessions.table_code,
    'zone', public.table_sessions.zone,
    'status', public.table_sessions.status,
    'openedAt', public.table_sessions.opened_at,
    'closedAt', public.table_sessions.closed_at,
    'openedSource', public.table_sessions.source,
    'version', public.table_sessions.version
  )
  from public.table_sessions
  where public.table_sessions.id = p_session_id
$$;

create or replace function public.dd008c_get_location_snapshot(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_can_read_payments boolean := false;
  v_payload jsonb;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'orders.read', p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;

  select exists (
    select 1
    from public.authorize_staff_access(p_location_id, 'payments.read', p_workstation_mode, p_device_credential) as pay_auth
    where pay_auth.ok = true
  ) into v_can_read_payments;

  select jsonb_build_object(
    'locationId', p_location_id,
    'orders', coalesce((
      select jsonb_agg(public.dd008c_order_payload(public.orders.id, v_can_read_payments) order by public.orders.created_at desc, public.orders.id)
      from public.orders
      where public.orders.location_id = p_location_id
    ), '[]'::jsonb),
    'tableSessions', coalesce((
      select jsonb_agg(public.dd008c_table_session_payload(public.table_sessions.id) order by public.table_sessions.opened_at desc, public.table_sessions.id)
      from public.table_sessions
      where public.table_sessions.location_id = p_location_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', public.service_requests.id,
        'tableSessionId', coalesce(public.service_requests.table_session_id, ''),
        'table', public.service_requests.table_code,
        'zone', public.service_requests.zone,
        'type', case when public.service_requests.type = 'BILL_REQUEST' then 'REQUEST_BILL' else public.service_requests.type end,
        'done', public.service_requests.status <> 'OPEN',
        'createdAt', public.service_requests.created_at,
        'completedAt', public.service_requests.completed_at,
        'version', public.service_requests.version
      ) order by public.service_requests.created_at desc, public.service_requests.id)
      from public.service_requests
      where public.service_requests.location_id = p_location_id
    ), '[]'::jsonb)
  ) into v_payload;

  return query select * from public.dd008c_success('location', p_location_id, null, v_payload);
end
$$;

create or replace function public.dd008c_get_public_table_snapshot(p_qr_token text)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_session_id text;
  v_payload jsonb;
begin
  select * into v_table
  from public.resolve_table_token(p_qr_token)
  limit 1;

  if v_table.location_id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TABLE_TOKEN_NOT_FOUND');
    return;
  end if;

  select public.table_sessions.id into v_session_id
  from public.table_sessions
  join public.physical_tables on public.physical_tables.id = public.table_sessions.physical_table_id
  where public.physical_tables.qr_token = p_qr_token
    and public.table_sessions.status = 'OPEN'
  order by public.table_sessions.opened_at desc
  limit 1;

  select jsonb_build_object(
    'locationId', v_table.location_id,
    'table', jsonb_build_object('code', v_table.code, 'zone', v_table.zone),
    'tableSession', case when v_session_id is null then null else public.dd008c_table_session_payload(v_session_id) end,
    'orders', coalesce((
      select jsonb_agg(public.dd008c_order_payload(public.orders.id, false) order by public.orders.created_at desc, public.orders.id)
      from public.orders
      where public.orders.table_session_id = v_session_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', public.service_requests.id,
        'tableSessionId', coalesce(public.service_requests.table_session_id, ''),
        'table', public.service_requests.table_code,
        'zone', public.service_requests.zone,
        'type', case when public.service_requests.type = 'BILL_REQUEST' then 'REQUEST_BILL' else public.service_requests.type end,
        'done', public.service_requests.status <> 'OPEN',
        'createdAt', public.service_requests.created_at,
        'completedAt', public.service_requests.completed_at
      ) order by public.service_requests.created_at desc, public.service_requests.id)
      from public.service_requests
      where public.service_requests.table_session_id = v_session_id
         or (public.service_requests.table_session_id is null and public.service_requests.table_code = v_table.code and public.service_requests.status = 'OPEN')
    ), '[]'::jsonb)
  ) into v_payload;

  return query select * from public.dd008c_success('table', v_table.code, null, v_payload);
end
$$;

create or replace function public.dd008c_open_or_reuse_table_session(
  p_location_id text,
  p_physical_table_id text,
  p_source text default 'STAFF'
)
returns public.table_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_session public.table_sessions;
begin
  select * into v_table
  from public.physical_tables
  where public.physical_tables.id = p_physical_table_id
    and public.physical_tables.location_id = p_location_id
    and public.physical_tables.is_active = true
  limit 1;

  if v_table.id is null then
    raise exception 'TABLE_NOT_FOUND';
  end if;

  insert into public.table_sessions (
    id,
    location_id,
    physical_table_id,
    table_code,
    zone,
    status,
    source,
    opened_at
  )
  values (
    'TS-' || replace(extensions.gen_random_uuid()::text, '-', ''),
    p_location_id,
    v_table.id,
    v_table.code,
    v_table.zone,
    'OPEN',
    coalesce(nullif(btrim(p_source), ''), 'STAFF'),
    now()
  )
  on conflict (physical_table_id) where status = 'OPEN'
  do update set
    table_code = excluded.table_code,
    zone = excluded.zone,
    version = public.table_sessions.version + 1
  returning * into v_session;

  return v_session;
end
$$;

create or replace function public.dd008c_insert_order_from_items(
  p_location_id text,
  p_physical_table_id text,
  p_table_session_id text,
  p_service_mode text,
  p_fulfillment_type text,
  p_order_source text,
  p_status text,
  p_items jsonb,
  p_note text default ''
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order_id text := 'ORD-' || replace(extensions.gen_random_uuid()::text, '-', '');
  v_order_no text := 'D' || to_char(now(), 'HH24MISS') || '-' || upper(substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 4));
  v_table record;
  v_item jsonb;
  v_index integer := 0;
  v_product record;
  v_qty integer;
  v_unit_price integer;
  v_variant_key text;
  v_variant record;
  v_selection jsonb;
  v_modifiers jsonb;
  v_group record;
  v_selected_options text[];
  v_selected_count integer;
  v_option record;
  v_option_snapshot jsonb;
  v_modifier_snapshot jsonb;
  v_configured_key text;
  v_total integer := 0;
  v_parent_line_id text;
  v_parent_summary_vi jsonb;
  v_parent_summary_en jsonb;
  v_component record;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUIRED';
  end if;

  if p_physical_table_id is not null then
    select * into v_table
    from public.physical_tables
    where public.physical_tables.id = p_physical_table_id
      and public.physical_tables.location_id = p_location_id
    limit 1;
  end if;

  insert into public.orders (
    id,
    location_id,
    order_no,
    table_session_id,
    physical_table_id,
    service_mode,
    fulfillment_type,
    order_source,
    zone,
    table_code,
    status,
    total_vnd,
    paid_vnd,
    payment_status,
    note,
    created_at,
    submitted_at,
    accepted_at
  )
  values (
    v_order_id,
    p_location_id,
    v_order_no,
    nullif(p_table_session_id, ''),
    p_physical_table_id,
    p_service_mode,
    p_fulfillment_type,
    p_order_source,
    coalesce(v_table.zone, ''),
    coalesce(v_table.code, ''),
    p_status,
    0,
    0,
    'UNPAID',
    coalesce(p_note, ''),
    now(),
    now(),
    case when p_status = 'ACCEPTED' then now() else null end
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_index := v_index + 1;
    v_qty := public.dd008c_normalize_positive_integer(to_jsonb(coalesce(v_item->>'qty', '1')));
    if v_qty is null or v_qty > 99 then
      raise exception 'INVALID_QUANTITY';
    end if;

    select * into v_product
    from public.products
    where public.products.id = coalesce(v_item->>'productId', v_item->>'id')
      and public.products.location_id = p_location_id
      and public.products.available = true
    limit 1;
    if v_product.id is null then
      raise exception 'PRODUCT_UNAVAILABLE';
    end if;

    v_selection := coalesce(v_item->'selection', '{}'::jsonb);
    v_modifiers := coalesce(v_selection->'modifierSelections', '{}'::jsonb);
    v_unit_price := v_product.price_vnd;
    v_variant_key := coalesce(v_selection->>'variantId', v_selection->>'variant', '');
    v_option_snapshot := jsonb_build_object('variant', null, 'modifierGroups', '[]'::jsonb);
    v_configured_key := v_product.id;

    if exists (select 1 from public.product_variants where product_id = v_product.id) then
      if v_variant_key = '' then
        raise exception 'VARIANT_REQUIRED';
      end if;
      select * into v_variant
      from public.product_variants
      where public.product_variants.product_id = v_product.id
        and public.product_variants.variant_key = v_variant_key
      limit 1;
      if v_variant.id is null or v_variant.available = false then
        raise exception 'VARIANT_UNAVAILABLE';
      end if;
      v_unit_price := v_unit_price + v_variant.price_delta_vnd;
      v_option_snapshot := jsonb_set(v_option_snapshot, '{variant}', jsonb_build_object(
        'id', v_variant.variant_key,
        'vi', v_variant.name_vi,
        'en', v_variant.name_en,
        'priceDelta', v_variant.price_delta_vnd
      ));
      v_configured_key := v_configured_key || '|v:' || v_variant.variant_key;
    elsif v_variant_key <> '' then
      raise exception 'VARIANT_NOT_ALLOWED';
    end if;

    for v_group in
      select public.modifier_groups.*
      from public.product_modifier_groups
      join public.modifier_groups on public.modifier_groups.id = public.product_modifier_groups.modifier_group_id
      where public.product_modifier_groups.product_id = v_product.id
      order by public.product_modifier_groups.display_order, public.modifier_groups.display_order
    loop
      select coalesce(array_agg(value order by ordinality), array[]::text[])
      into v_selected_options
      from jsonb_array_elements_text(coalesce(v_modifiers -> v_group.group_key, '[]'::jsonb)) with ordinality as selected(value, ordinality);

      v_selected_count := coalesce(array_length(v_selected_options, 1), 0);
      if v_selected_count < v_group.min_select then
        raise exception 'OPTION_COUNT_INVALID';
      end if;
      if v_selected_count > v_group.max_select or (v_group.multiple = false and v_selected_count > 1) then
        raise exception 'OPTION_COUNT_INVALID';
      end if;

      v_modifier_snapshot := jsonb_build_object(
        'id', v_group.group_key,
        'vi', v_group.name_vi,
        'en', v_group.name_en,
        'options', '[]'::jsonb
      );

      foreach v_variant_key in array v_selected_options
      loop
        select public.modifier_options.* into v_option
        from public.modifier_options
        where public.modifier_options.modifier_group_id = v_group.id
          and public.modifier_options.option_key = v_variant_key
        limit 1;

        if v_option.id is null or v_option.available = false then
          raise exception 'MODIFIER_OPTION_UNAVAILABLE';
        end if;

        v_unit_price := v_unit_price + v_option.price_delta_vnd;
        v_modifier_snapshot := jsonb_set(
          v_modifier_snapshot,
          '{options}',
          (v_modifier_snapshot->'options') || jsonb_build_array(jsonb_build_object(
            'id', v_option.option_key,
            'vi', v_option.name_vi,
            'en', v_option.name_en,
            'priceDelta', v_option.price_delta_vnd
          ))
        );
      end loop;

      if v_selected_count > 0 then
        v_option_snapshot := jsonb_set(
          v_option_snapshot,
          '{modifierGroups}',
          (v_option_snapshot->'modifierGroups') || jsonb_build_array(v_modifier_snapshot)
        );
        v_configured_key := v_configured_key || '|m:' || v_group.group_key || '=' || array_to_string(v_selected_options, ',');
      end if;
    end loop;

    if v_unit_price < 0 then
      raise exception 'NEGATIVE_UNIT_PRICE';
    end if;

    v_parent_line_id := v_product.id || ':' || v_index || ':item';
    v_parent_summary_vi := coalesce((
      select jsonb_agg(line)
      from (
        select 'Phiên bản: ' || (v_option_snapshot->'variant'->>'vi') as line
        where v_option_snapshot->'variant' is not null
        union all
        select (group_item->>'vi') || ': ' || (
          select string_agg(option_item->>'vi', ', ')
          from jsonb_array_elements(group_item->'options') as option_item
        )
        from jsonb_array_elements(v_option_snapshot->'modifierGroups') as group_item
      ) lines
    ), '[]'::jsonb);
    v_parent_summary_en := coalesce((
      select jsonb_agg(line)
      from (
        select 'Variant: ' || (v_option_snapshot->'variant'->>'en') as line
        where v_option_snapshot->'variant' is not null
        union all
        select (group_item->>'en') || ': ' || (
          select string_agg(option_item->>'en', ', ')
          from jsonb_array_elements(group_item->'options') as option_item
        )
        from jsonb_array_elements(v_option_snapshot->'modifierGroups') as group_item
      ) lines
    ), '[]'::jsonb);

    insert into public.order_lines (
      id,
      order_id,
      line_id,
      product_id,
      station_code,
      name_vi,
      name_en,
      qty,
      bill_qty,
      served_qty,
      prep_status,
      item_status,
      base_price_vnd,
      price_vnd,
      is_billable,
      is_component,
      parent_combo_id,
      parent_line_id,
      configured_key,
      configured_options,
      option_snapshot,
      hold_state,
      queued_at
    )
    values (
      'OL-' || replace(extensions.gen_random_uuid()::text, '-', ''),
      v_order_id,
      v_parent_line_id,
      v_product.id,
      case when exists (select 1 from public.product_components where parent_product_id = v_product.id) then 'COMBO' else v_product.station_code end,
      v_product.name_vi,
      v_product.name_en,
      v_qty,
      v_qty,
      0,
      'QUEUED',
      'QUEUED',
      v_product.price_vnd,
      v_unit_price,
      true,
      false,
      '',
      '',
      v_configured_key,
      v_selection,
      v_option_snapshot,
      'FIRED',
      case when p_status = 'ACCEPTED' then now() else null end
    );

    v_total := v_total + (v_qty * v_unit_price);

    for v_component in
      select *
      from public.product_components
      where public.product_components.parent_product_id = v_product.id
      order by public.product_components.display_order, public.product_components.id
    loop
      insert into public.order_lines (
        id,
        order_id,
        line_id,
        product_id,
        station_code,
        name_vi,
        name_en,
        qty,
        bill_qty,
        served_qty,
        prep_status,
        item_status,
        base_price_vnd,
        price_vnd,
        is_billable,
        is_component,
        parent_combo_id,
        parent_line_id,
        parent_combo_name_vi,
        parent_combo_name_en,
        parent_combo_option_summary_vi,
        parent_combo_option_summary_en,
        hold_state,
        queued_at
      )
      values (
        'OL-' || replace(extensions.gen_random_uuid()::text, '-', ''),
        v_order_id,
        v_parent_line_id || ':component-' || v_component.display_order,
        v_product.id,
        v_component.station_code,
        v_component.name_vi,
        v_component.name_en,
        v_qty * v_component.qty,
        0,
        0,
        'QUEUED',
        'QUEUED',
        0,
        0,
        false,
        true,
        v_product.id,
        v_parent_line_id,
        v_product.name_vi,
        v_product.name_en,
        v_parent_summary_vi,
        v_parent_summary_en,
        'FIRED',
        case when p_status = 'ACCEPTED' then now() else null end
      );
    end loop;
  end loop;

  update public.orders
  set total_vnd = v_total,
      station_status = '{}'::jsonb,
      version = public.orders.version + 1
  where public.orders.id = v_order_id;

  return v_order_id;
end
$$;

create or replace function public.submit_qr_order(
  p_qr_token text,
  p_items jsonb,
  p_note text default '',
  p_idempotency_key text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_session public.table_sessions;
  v_order_id text;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_hash text;
  v_existing record;
  v_result jsonb;
begin
  select pt.*
  into v_table
  from public.physical_tables pt
  where pt.qr_token = p_qr_token
    and pt.is_active = true
  limit 1;

  if v_table.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TABLE_TOKEN_NOT_FOUND');
    return;
  end if;
  if v_key = '' then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'IDEMPOTENCY_KEY_REQUIRED');
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object('qrToken', p_qr_token, 'items', p_items, 'note', p_note));
  perform pg_advisory_xact_lock(hashtext(v_table.location_id || ':submit_qr_order:' || v_key));
  select * into v_existing
  from public.command_deduplication
  where location_id = v_table.location_id
    and command_key = v_key
    and command = 'submit_qr_order'
  limit 1;
  if v_existing.id is not null then
    if v_existing.request_hash <> v_hash then
      return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT');
      return;
    end if;
    return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
    return;
  end if;

  begin
    v_session := public.dd008c_open_or_reuse_table_session(v_table.location_id, v_table.id, 'CUSTOMER_QR');
    v_order_id := public.dd008c_insert_order_from_items(
      v_table.location_id,
      v_table.id,
      v_session.id,
      'TABLE_SERVICE',
      'DINE_IN',
      'CUSTOMER_QR',
      'PENDING_ACCEPTANCE',
      p_items,
      p_note
    );
  exception
    when others then
      return query select * from public.dd008c_failure('VALIDATION_ERROR', SQLERRM);
      return;
  end;

  v_result := public.dd008c_result_json(
    true,
    'OK',
    '',
    'order',
    v_order_id,
    (select public.orders.version from public.orders where public.orders.id = v_order_id),
    jsonb_build_object('order', public.dd008c_order_payload(v_order_id, false), 'tableSession', public.dd008c_table_session_payload(v_session.id))
  );

  insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
  values (v_table.location_id, v_key, 'submit_qr_order', 'PUBLIC_QR', v_table.code, v_hash, v_result::text);

  perform public.dd008c_write_audit(v_table.location_id, 'PUBLIC_QR', v_table.code, '', '', 'submit_qr_order', 'order', v_order_id, 'OK');
  perform public.dd008c_emit_refresh(v_table.location_id, 'ops', 'order', v_order_id, jsonb_build_object('reason', 'ORDER_SUBMITTED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.create_service_request(
  p_qr_token text,
  p_type text,
  p_idempotency_key text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_session_id text;
  v_type text;
  v_id text := 'SR-' || replace(extensions.gen_random_uuid()::text, '-', '');
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_hash text;
  v_existing record;
  v_result jsonb;
begin
  select pt.* into v_table
  from public.physical_tables pt
  where pt.qr_token = p_qr_token
    and pt.is_active = true
  limit 1;
  if v_table.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TABLE_TOKEN_NOT_FOUND');
    return;
  end if;
  if v_key = '' then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'IDEMPOTENCY_KEY_REQUIRED');
    return;
  end if;
  v_type := case upper(btrim(coalesce(p_type, '')))
    when 'REQUEST_BILL' then 'BILL_REQUEST'
    when 'BILL_REQUEST' then 'BILL_REQUEST'
    else 'CALL_STAFF'
  end;
  v_hash := public.dd008c_hash_request(jsonb_build_object('qrToken', p_qr_token, 'type', v_type));
  perform pg_advisory_xact_lock(hashtext(v_table.location_id || ':create_service_request:' || v_key));
  select * into v_existing
  from public.command_deduplication
  where location_id = v_table.location_id
    and command_key = v_key
    and command = 'create_service_request'
  limit 1;
  if v_existing.id is not null then
    if v_existing.request_hash <> v_hash then
      return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT');
      return;
    end if;
    return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
    return;
  end if;

  select public.table_sessions.id into v_session_id
  from public.table_sessions
  where public.table_sessions.physical_table_id = v_table.id
    and public.table_sessions.status = 'OPEN'
  order by public.table_sessions.opened_at desc
  limit 1;

  insert into public.service_requests (id, location_id, table_session_id, physical_table_id, table_code, zone, type, status)
  values (v_id, v_table.location_id, v_session_id, v_table.id, v_table.code, v_table.zone, v_type, 'OPEN');

  v_result := public.dd008c_result_json(true, 'OK', '', 'service_request', v_id, 1, jsonb_build_object('id', v_id, 'type', v_type));
  insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
  values (v_table.location_id, v_key, 'create_service_request', 'PUBLIC_QR', v_table.code, v_hash, v_result::text);

  perform public.dd008c_write_audit(v_table.location_id, 'PUBLIC_QR', v_table.code, '', '', 'create_service_request', 'service_request', v_id, 'OK');
  perform public.dd008c_emit_refresh(v_table.location_id, 'ops', 'service_request', v_id, jsonb_build_object('reason', 'SERVICE_REQUEST'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd008c_authorize_command(
  p_location_id text,
  p_permission text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (
  ok boolean,
  reason text,
  staff_profile_id text,
  location_id text,
  device_id text,
  workstation_mode text
)
language sql
stable
security definer
set search_path = ''
as $$
  select *
  from public.authorize_staff_access(p_location_id, p_permission, p_workstation_mode, p_device_credential)
$$;

create or replace function public.create_staff_order(
  p_location_id text,
  p_items jsonb,
  p_table_code text default '',
  p_fulfillment_type text default 'DINE_IN',
  p_note text default '',
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_table record;
  v_session public.table_sessions;
  v_order_id text;
  v_service_mode text;
  v_fulfillment text := case when upper(btrim(coalesce(p_fulfillment_type, ''))) = 'TAKEAWAY' then 'TAKEAWAY' else 'DINE_IN' end;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_hash text;
  v_existing record;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'orders.create_staff', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  if v_key = '' then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'IDEMPOTENCY_KEY_REQUIRED');
    return;
  end if;
  if btrim(coalesce(p_table_code, '')) <> '' and v_fulfillment = 'DINE_IN' then
    select * into v_table from public.physical_tables
    where location_id = p_location_id and code = btrim(p_table_code) and is_active = true
    limit 1;
    if v_table.id is null then
      return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TABLE_NOT_FOUND');
      return;
    end if;
    v_service_mode := 'TABLE_SERVICE';
  else
    v_service_mode := 'COUNTER_SERVICE';
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object('items', p_items, 'tableCode', p_table_code, 'fulfillmentType', v_fulfillment, 'note', p_note));
  perform pg_advisory_xact_lock(hashtext(p_location_id || ':create_staff_order:' || v_key));
  select * into v_existing from public.command_deduplication
  where location_id = p_location_id and command_key = v_key and command = 'create_staff_order'
  limit 1;
  if v_existing.id is not null then
    if v_existing.request_hash <> v_hash then
      return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT');
      return;
    end if;
    return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
    return;
  end if;

  begin
    if v_service_mode = 'TABLE_SERVICE' then
      v_session := public.dd008c_open_or_reuse_table_session(p_location_id, v_table.id, 'COUNTER');
    end if;
    v_order_id := public.dd008c_insert_order_from_items(
      p_location_id,
      v_table.id,
      coalesce(v_session.id, ''),
      v_service_mode,
      v_fulfillment,
      'COUNTER',
      'ACCEPTED',
      p_items,
      p_note
    );
  exception
    when others then
      return query select * from public.dd008c_failure('VALIDATION_ERROR', SQLERRM);
      return;
  end;

  v_result := public.dd008c_result_json(true, 'OK', '', 'order', v_order_id, (select public.orders.version from public.orders where public.orders.id = v_order_id), jsonb_build_object('order', public.dd008c_order_payload(v_order_id, true)));
  insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
  values (p_location_id, v_key, 'create_staff_order', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);

  perform public.dd008c_write_audit(p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id, 'create_staff_order', 'order', v_order_id, 'OK');
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', v_order_id, jsonb_build_object('reason', 'STAFF_ORDER_CREATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.set_order_status(
  p_location_id text,
  p_order_id text,
  p_status text,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_next text := upper(btrim(coalesce(p_status, '')));
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'status', upper(btrim(coalesce(p_status, ''))), 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'orders.accept', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'set_order_status', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and location_id = p_location_id
  for update;
  if v_order.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND');
    return;
  end if;
  if p_expected_version is not null and v_order.version <> p_expected_version then
    return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION', 'order', p_order_id, jsonb_build_object('currentVersion', v_order.version));
    return;
  end if;

  if not (
    (v_order.status = 'PENDING_ACCEPTANCE' and v_next in ('ACCEPTED', 'REJECTED'))
    or (v_order.status = 'ACCEPTED' and v_next = 'REJECTED')
  ) then
    return query select * from public.dd008c_failure('INVALID_STATE', 'INVALID_STATUS_TRANSITION', 'order', p_order_id);
    return;
  end if;

  update public.orders
  set status = v_next,
      accepted_at = case when v_next = 'ACCEPTED' and accepted_at is null then now() else accepted_at end,
      station_status = case when v_next = 'REJECTED' then '{}'::jsonb else station_status end,
      version = public.orders.version + 1
  where id = p_order_id
  returning * into v_order;

  if v_next = 'ACCEPTED' then
    update public.order_lines
    set queued_at = case when hold_state = 'FIRED' and queued_at is null then now() else queued_at end
    where order_id = p_order_id
      and station_code <> 'COMBO';
  end if;

  perform public.dd008c_write_audit(p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id, 'set_order_status', 'order', p_order_id, 'OK', jsonb_build_object('status', v_next));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'ORDER_STATUS'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, v_order.version, jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  perform public.dd008c_store_command(p_location_id, 'set_order_status', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd008c_station_permission(p_station_code text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when upper(coalesce(p_station_code, '')) like 'BAR%' then 'kds.bar'
    when upper(coalesce(p_station_code, '')) like 'DESSERT%' then 'kds.dessert'
    else 'kds.kitchen'
  end
$$;

create or replace function public.update_kds_line_prep(
  p_location_id text,
  p_order_id text,
  p_line_ids text[],
  p_next_prep_status text,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_station text;
  v_permission text;
  v_authz record;
  v_next text := upper(btrim(coalesce(p_next_prep_status, '')));
  v_distinct_stations integer;
  v_distinct_courses integer;
  v_invalid_count integer;
  v_new_status text;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'lineIds', p_line_ids, 'nextPrepStatus', upper(btrim(coalesce(p_next_prep_status, ''))), 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
begin
  if v_next not in ('ACKNOWLEDGED', 'PREPARING', 'READY') then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_PREP_STATUS');
    return;
  end if;
  select * into v_order
  from public.orders
  where id = p_order_id and location_id = p_location_id
  for update;
  if v_order.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND');
    return;
  end if;
  if p_expected_version is not null and v_order.version <> p_expected_version then
    return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION', 'order', p_order_id, jsonb_build_object('currentVersion', v_order.version));
    return;
  end if;
  if v_order.status not in ('ACCEPTED', 'IN_PREPARATION', 'READY') then
    return query select * from public.dd008c_failure('INVALID_STATE', 'ORDER_NOT_IN_STATION_WORKFLOW');
    return;
  end if;

  select count(distinct station_code), count(distinct coalesce(course, '')), min(station_code)
  into v_distinct_stations, v_distinct_courses, v_station
  from public.order_lines
  where order_id = p_order_id
    and line_id = any(p_line_ids)
    and station_code <> 'COMBO'
    and is_meta = false;

  if coalesce(v_distinct_stations, 0) <> 1 then
    return query select * from public.dd008c_failure('INVALID_STATE', 'CROSS_TICKET_LINE_IDS');
    return;
  end if;
  if coalesce(v_distinct_courses, 0) > 1 then
    return query select * from public.dd008c_failure('INVALID_STATE', 'CROSS_COURSE_LINE_IDS');
    return;
  end if;

  v_permission := public.dd008c_station_permission(v_station);
  select * into v_authz from public.dd008c_authorize_command(p_location_id, v_permission, p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'update_kds_line_prep', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select count(*) into v_invalid_count
  from public.order_lines
  where order_id = p_order_id
    and line_id = any(p_line_ids)
    and (
      hold_state <> 'FIRED'
      or (prep_status = 'QUEUED' and v_next <> 'ACKNOWLEDGED')
      or (prep_status = 'ACKNOWLEDGED' and v_next <> 'PREPARING')
      or (prep_status = 'PREPARING' and v_next <> 'READY')
      or prep_status = 'READY'
    );
  if v_invalid_count > 0 then
    return query select * from public.dd008c_failure('INVALID_STATE', 'INVALID_PREP_STATUS_TRANSITION');
    return;
  end if;

  update public.order_lines
  set prep_status = v_next,
      item_status = v_next,
      queued_at = coalesce(queued_at, now()),
      acknowledged_at = case when v_next in ('ACKNOWLEDGED', 'PREPARING', 'READY') then coalesce(acknowledged_at, now()) else acknowledged_at end,
      prep_started_at = case when v_next in ('PREPARING', 'READY') then coalesce(prep_started_at, now()) else prep_started_at end,
      ready_at = case when v_next = 'READY' then coalesce(ready_at, now()) else ready_at end
  where order_id = p_order_id
    and line_id = any(p_line_ids);

  update public.orders
  set version = public.orders.version + 1
  where public.orders.id = p_order_id
    and public.orders.location_id = p_location_id;

  v_new_status := public.dd008c_refresh_order_status(p_order_id);
  perform public.dd008c_write_audit(p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id, 'update_kds_line_prep', 'order', p_order_id, 'OK', jsonb_build_object('prepStatus', v_next, 'lineIds', p_line_ids));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'KDS_PREP', 'station', v_station));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, false), 'status', v_new_status));
  perform public.dd008c_store_command(p_location_id, 'update_kds_line_prep', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.serve_order_line(
  p_location_id text,
  p_order_id text,
  p_line_id text,
  p_qty integer default 1,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_line public.order_lines;
  v_new_status text;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'lineId', p_line_id, 'qty', p_qty, 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'service.serve', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'serve_order_line', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND');
    return;
  end if;
  if p_expected_version is not null and v_order.version <> p_expected_version then
    return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION', 'order', p_order_id, jsonb_build_object('currentVersion', v_order.version));
    return;
  end if;
  select * into v_line from public.order_lines where order_id = p_order_id and line_id = p_line_id for update;
  if v_line.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'LINE_NOT_FOUND');
    return;
  end if;
  if v_line.prep_status <> 'READY' or v_line.station_code = 'COMBO' then
    return query select * from public.dd008c_failure('INVALID_STATE', 'LINE_NOT_READY');
    return;
  end if;
  if p_qty <= 0 or v_line.served_qty + p_qty > v_line.qty then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'SERVED_QTY_EXCEEDS_REMAINING');
    return;
  end if;

  update public.order_lines
  set served_qty = served_qty + p_qty,
      served_at = now(),
      item_status = case when served_qty + p_qty >= qty then 'SERVED' else item_status end
  where id = v_line.id;

  update public.orders
  set version = public.orders.version + 1
  where public.orders.id = p_order_id
    and public.orders.location_id = p_location_id;

  v_new_status := public.dd008c_refresh_order_status(p_order_id);
  perform public.dd008c_write_audit(p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id, 'serve_order_line', 'order_line', v_line.line_id, 'OK');
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'LINE_SERVED'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true), 'status', v_new_status));
  perform public.dd008c_store_command(p_location_id, 'serve_order_line', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.serve_all_ready(
  p_location_id text,
  p_order_id text,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_count integer;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'service.serve', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'serve_all_ready', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then
    return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND');
    return;
  end if;
  if p_expected_version is not null and v_order.version <> p_expected_version then
    return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION', 'order', p_order_id, jsonb_build_object('currentVersion', v_order.version));
    return;
  end if;
  update public.order_lines
  set served_qty = qty,
      served_at = now(),
      item_status = 'SERVED'
  where order_id = p_order_id
    and station_code <> 'COMBO'
    and prep_status = 'READY'
    and served_qty < qty;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    return query select * from public.dd008c_failure('INVALID_STATE', 'NO_READY_LINES');
    return;
  end if;

  update public.orders
  set version = public.orders.version + 1
  where public.orders.id = p_order_id
    and public.orders.location_id = p_location_id;

  perform public.dd008c_refresh_order_status(p_order_id);
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'READY_LINES_SERVED'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  perform public.dd008c_store_command(p_location_id, 'serve_all_ready', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd008c_family_mutable(p_order_id text, p_family_line_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.order_lines
    where public.order_lines.order_id = p_order_id
      and public.order_lines.station_code <> 'COMBO'
      and coalesce(nullif(public.order_lines.parent_line_id, ''), public.order_lines.line_id) = p_family_line_id
      and (
        public.order_lines.prep_status <> 'QUEUED'
        or public.order_lines.served_qty > 0
        or public.order_lines.acknowledged_at is not null
        or public.order_lines.prep_started_at is not null
        or public.order_lines.ready_at is not null
      )
  )
$$;

create or replace function public.assign_order_family_course(
  p_location_id text,
  p_order_id text,
  p_family_line_id text,
  p_course text,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_course text := nullif(btrim(coalesce(p_course, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'familyLineId', p_family_line_id, 'course', nullif(btrim(coalesce(p_course, '')), '')));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'course.manage', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'assign_order_family_course', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  if v_course is not null and v_course !~ '^[1-9][0-9]*$' then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_COURSE'); return; end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  if not exists (select 1 from public.order_lines where order_id = p_order_id and line_id = p_family_line_id) then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'LINE_NOT_FOUND'); return; end if;
  if not public.dd008c_family_mutable(p_order_id, p_family_line_id) then return query select * from public.dd008c_failure('INVALID_STATE', 'FAMILY_PREP_STARTED'); return; end if;
  update public.order_lines set course = v_course where order_id = p_order_id and (line_id = p_family_line_id or parent_line_id = p_family_line_id);
  update public.orders set version = public.orders.version + 1 where id = p_order_id and location_id = p_location_id;
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'COURSE_ASSIGNED'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  perform public.dd008c_store_command(p_location_id, 'assign_order_family_course', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.hold_order_family(
  p_location_id text,
  p_order_id text,
  p_family_line_id text,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'familyLineId', p_family_line_id));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'course.manage', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'hold_order_family', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  if not exists (select 1 from public.order_lines where order_id = p_order_id and line_id = p_family_line_id) then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'LINE_NOT_FOUND'); return; end if;
  if not public.dd008c_family_mutable(p_order_id, p_family_line_id) then return query select * from public.dd008c_failure('INVALID_STATE', 'FAMILY_PREP_STARTED'); return; end if;
  update public.order_lines
  set hold_state = 'HELD', held_at = now(), fired_at = null, queued_at = null, acknowledged_at = null, prep_started_at = null, ready_at = null, prep_status = 'QUEUED', item_status = 'QUEUED'
  where order_id = p_order_id and (line_id = p_family_line_id or parent_line_id = p_family_line_id);
  update public.orders set version = public.orders.version + 1 where id = p_order_id and location_id = p_location_id;
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'FAMILY_HELD'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  perform public.dd008c_store_command(p_location_id, 'hold_order_family', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.fire_order_family(
  p_location_id text,
  p_order_id text,
  p_family_line_id text,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order_status text;
  v_already_fired boolean;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'familyLineId', p_family_line_id));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'course.manage', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'fire_order_family', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  select status into v_order_status from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order_status is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  if not exists (select 1 from public.order_lines where order_id = p_order_id and line_id = p_family_line_id) then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'LINE_NOT_FOUND'); return; end if;
  select bool_and(hold_state = 'FIRED') into v_already_fired from public.order_lines where order_id = p_order_id and (line_id = p_family_line_id or parent_line_id = p_family_line_id);
  if v_already_fired then
    v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('noOp', true, 'reason', 'ALREADY_FIRED', 'order', public.dd008c_order_payload(p_order_id, true)));
    perform public.dd008c_store_command(p_location_id, 'fire_order_family', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;
  if not public.dd008c_family_mutable(p_order_id, p_family_line_id) then return query select * from public.dd008c_failure('INVALID_STATE', 'FIRE_NOT_ALLOWED'); return; end if;
  update public.order_lines
  set hold_state = 'FIRED',
      fired_at = coalesce(fired_at, now()),
      queued_at = case when v_order_status in ('ACCEPTED', 'IN_PREPARATION', 'READY') and station_code <> 'COMBO' then coalesce(queued_at, now()) else queued_at end
  where order_id = p_order_id and (line_id = p_family_line_id or parent_line_id = p_family_line_id);
  update public.orders set version = public.orders.version + 1 where id = p_order_id and location_id = p_location_id;
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'FAMILY_FIRED'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  perform public.dd008c_store_command(p_location_id, 'fire_order_family', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.fire_order_course(
  p_location_id text,
  p_order_id text,
  p_course text,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_course text := btrim(coalesce(p_course, ''));
  v_order_status text;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'course', btrim(coalesce(p_course, ''))));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'course.manage', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'fire_order_course', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  if v_course !~ '^[1-9][0-9]*$' then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'COURSE_REQUIRED'); return; end if;
  select status into v_order_status from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order_status is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  if not exists (
    select 1 from public.order_lines
    where order_id = p_order_id and course = v_course and hold_state = 'HELD'
  ) then
    v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('noOp', true, 'reason', 'ALREADY_FIRED', 'order', public.dd008c_order_payload(p_order_id, true)));
    perform public.dd008c_store_command(p_location_id, 'fire_order_course', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;
  if exists (
    select 1 from public.order_lines
    where order_id = p_order_id and course = v_course and hold_state = 'HELD'
      and not public.dd008c_family_mutable(p_order_id, coalesce(nullif(parent_line_id, ''), line_id))
  ) then
    return query select * from public.dd008c_failure('INVALID_STATE', 'FIRE_NOT_ALLOWED');
    return;
  end if;
  update public.order_lines
  set hold_state = 'FIRED',
      fired_at = coalesce(fired_at, now()),
      queued_at = case when v_order_status in ('ACCEPTED', 'IN_PREPARATION', 'READY') and station_code <> 'COMBO' then coalesce(queued_at, now()) else queued_at end
  where order_id = p_order_id and course = v_course and hold_state = 'HELD';
  update public.orders set version = public.orders.version + 1 where id = p_order_id and location_id = p_location_id;
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'order', p_order_id, jsonb_build_object('reason', 'COURSE_FIRED'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  perform public.dd008c_store_command(p_location_id, 'fire_order_course', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.open_table_visit(
  p_location_id text,
  p_table_code text,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_table record;
  v_session public.table_sessions;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'tableCode', p_table_code));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'tables.manage_session', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'open_table_visit', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  select * into v_table from public.physical_tables where location_id = p_location_id and code = p_table_code and is_active = true limit 1;
  if v_table.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TABLE_NOT_FOUND'); return; end if;
  v_session := public.dd008c_open_or_reuse_table_session(p_location_id, v_table.id, 'STAFF');
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'table_session', v_session.id, jsonb_build_object('reason', 'TABLE_OPEN'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'table_session', v_session.id, v_session.version, jsonb_build_object('tableSession', public.dd008c_table_session_payload(v_session.id)));
  perform public.dd008c_store_command(p_location_id, 'open_table_visit', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.transfer_table_visit(
  p_location_id text,
  p_table_session_id text,
  p_to_table_code text,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_session public.table_sessions;
  v_destination record;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'tableSessionId', p_table_session_id, 'toTableCode', p_to_table_code, 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'tables.manage_session', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'transfer_table_visit', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  select * into v_session from public.table_sessions where id = p_table_session_id and location_id = p_location_id for update;
  if v_session.id is null or v_session.status <> 'OPEN' then return query select * from public.dd008c_failure('INVALID_STATE', 'SESSION_NOT_OPEN'); return; end if;
  if p_expected_version is not null and v_session.version <> p_expected_version then return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION'); return; end if;
  select * into v_destination from public.physical_tables where location_id = p_location_id and code = p_to_table_code and is_active = true limit 1;
  if v_destination.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'DESTINATION_TABLE_NOT_FOUND'); return; end if;
  if exists (select 1 from public.table_sessions where physical_table_id = v_destination.id and status = 'OPEN' and id <> p_table_session_id) then
    return query select * from public.dd008c_failure('CONFLICT', 'DESTINATION_OCCUPIED');
    return;
  end if;
  begin
    update public.table_sessions
    set physical_table_id = v_destination.id,
        table_code = v_destination.code,
        zone = v_destination.zone,
        version = public.table_sessions.version + 1
    where id = p_table_session_id
    returning * into v_session;
  exception
    when unique_violation then
      return query select * from public.dd008c_failure('CONFLICT', 'DESTINATION_OCCUPIED', 'table_session', p_table_session_id);
      return;
  end;
  update public.orders set physical_table_id = v_destination.id, table_code = v_destination.code, zone = v_destination.zone, version = public.orders.version + 1 where table_session_id = p_table_session_id and location_id = p_location_id;
  update public.service_requests set physical_table_id = v_destination.id, table_code = v_destination.code, zone = v_destination.zone, version = public.service_requests.version + 1 where table_session_id = p_table_session_id and status = 'OPEN';
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'table_session', p_table_session_id, jsonb_build_object('reason', 'TABLE_TRANSFER'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'table_session', p_table_session_id, v_session.version, jsonb_build_object('tableSession', public.dd008c_table_session_payload(p_table_session_id)));
  perform public.dd008c_store_command(p_location_id, 'transfer_table_visit', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.close_table_visit(
  p_location_id text,
  p_table_session_id text,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_session public.table_sessions;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'tableSessionId', p_table_session_id, 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'tables.manage_session', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  v_replay := public.dd008c_replay_command(p_location_id, 'close_table_visit', p_idempotency_key, v_hash);
  if v_replay is not null then return query select * from public.dd008c_result_from_json(v_replay); return; end if;
  select * into v_session from public.table_sessions where id = p_table_session_id and location_id = p_location_id for update;
  if v_session.id is null or v_session.status <> 'OPEN' then return query select * from public.dd008c_failure('INVALID_STATE', 'SESSION_NOT_OPEN'); return; end if;
  if p_expected_version is not null and v_session.version <> p_expected_version then return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION'); return; end if;
  if exists (select 1 from public.orders where table_session_id = p_table_session_id and status in ('PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PREPARATION', 'READY', 'SERVED')) then
    return query select * from public.dd008c_failure('INVALID_STATE', 'ACTIVE_ORDERS');
    return;
  end if;
  update public.table_sessions set status = 'CLOSED', closed_at = now(), version = public.table_sessions.version + 1 where id = p_table_session_id returning * into v_session;
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'table_session', p_table_session_id, jsonb_build_object('reason', 'TABLE_CLOSE'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'table_session', p_table_session_id, v_session.version, jsonb_build_object('tableSession', public.dd008c_table_session_payload(p_table_session_id)));
  perform public.dd008c_store_command(p_location_id, 'close_table_visit', p_idempotency_key, 'STAFF', v_authz.staff_profile_id, v_hash, v_result);
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.complete_service_request(
  p_location_id text,
  p_request_id text,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_request public.service_requests;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'requestId', p_request_id, 'expectedVersion', p_expected_version));
  v_existing public.command_deduplication;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'service_requests.complete', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtext('complete_service_request:' || p_location_id || ':' || v_key));
    select * into v_existing from public.command_deduplication
    where location_id = p_location_id and command_key = v_key and command = 'complete_service_request'
    for update;
    if v_existing.id is not null then
      if v_existing.request_hash <> v_hash then return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'); return; end if;
      return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
      return;
    end if;
  end if;
  select * into v_request from public.service_requests where id = p_request_id and location_id = p_location_id for update;
  if v_request.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'SERVICE_REQUEST_NOT_FOUND'); return; end if;
  if p_expected_version is not null and v_request.version <> p_expected_version then return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION'); return; end if;
  if v_request.status <> 'OPEN' then
    v_result := public.dd008c_result_json(true, 'OK', 'ALREADY_COMPLETED', 'service_request', v_request.id, v_request.version, jsonb_build_object('id', v_request.id));
    if v_key is not null then
      insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
      values (p_location_id, v_key, 'complete_service_request', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
    end if;
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;
  update public.service_requests
  set status = 'COMPLETED',
      completed_at = now(),
      version = public.service_requests.version + 1
  where id = p_request_id
  returning * into v_request;
  v_result := public.dd008c_result_json(true, 'OK', '', 'service_request', v_request.id, v_request.version, jsonb_build_object('id', v_request.id));
  if v_key is not null then
    insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
    values (p_location_id, v_key, 'complete_service_request', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
  end if;
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'service_request', v_request.id, jsonb_build_object('reason', 'SERVICE_REQUEST_COMPLETED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.update_order_line_bill_qty(
  p_location_id text,
  p_order_id text,
  p_line_id text,
  p_bill_qty integer,
  p_expected_version integer default null,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_line public.order_lines;
  v_total integer;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'lineId', p_line_id, 'billQty', p_bill_qty, 'expectedVersion', p_expected_version));
  v_existing public.command_deduplication;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'payments.record', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  if p_bill_qty is null or p_bill_qty < 0 then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_BILL_QTY'); return; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtext('update_order_line_bill_qty:' || p_location_id || ':' || v_key));
    select * into v_existing from public.command_deduplication
    where location_id = p_location_id and command_key = v_key and command = 'update_order_line_bill_qty'
    for update;
    if v_existing.id is not null then
      if v_existing.request_hash <> v_hash then return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'); return; end if;
      return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
      return;
    end if;
  end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  if p_expected_version is not null and v_order.version <> p_expected_version then return query select * from public.dd008c_failure('CONFLICT', 'STALE_VERSION'); return; end if;
  if v_order.status in ('PAID', 'REJECTED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED') then return query select * from public.dd008c_failure('INVALID_STATE', 'ORDER_TERMINAL'); return; end if;
  if exists (select 1 from public.payment_transactions where order_id = p_order_id) then return query select * from public.dd008c_failure('INVALID_STATE', 'PAYMENT_EXISTS'); return; end if;
  select * into v_line from public.order_lines where order_id = p_order_id and line_id = p_line_id for update;
  if v_line.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'LINE_NOT_FOUND'); return; end if;
  if not v_line.is_billable then return query select * from public.dd008c_failure('INVALID_STATE', 'LINE_NOT_BILLABLE'); return; end if;
  if p_bill_qty > v_line.qty then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'BILL_QTY_EXCEEDS_QTY'); return; end if;
  update public.order_lines
  set bill_qty = p_bill_qty
  where id = v_line.id;
  select coalesce(sum(public.order_lines.bill_qty * public.order_lines.price_vnd) filter (where public.order_lines.is_billable), 0)
  into v_total
  from public.order_lines
  where public.order_lines.order_id = p_order_id;
  update public.orders
  set total_vnd = coalesce(v_total, 0),
      version = public.orders.version + 1
  where id = p_order_id
  returning * into v_order;
  perform public.dd008c_sync_payment_projection(p_order_id, false);
  v_result := public.dd008c_result_json(true, 'OK', '', 'order', p_order_id, v_order.version, jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  if v_key is not null then
    insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
    values (p_location_id, v_key, 'update_order_line_bill_qty', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
  end if;
  perform public.dd008c_emit_refresh(p_location_id, 'cashier', 'order', p_order_id, jsonb_build_object('reason', 'BILL_QTY_UPDATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.record_order_payment(
  p_location_id text,
  p_order_id text,
  p_method text,
  p_amount_vnd integer,
  p_tender_group_id text default '',
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_summary record;
  v_payment_id text := 'PAY-' || replace(extensions.gen_random_uuid()::text, '-', '');
  v_method text := upper(btrim(coalesce(p_method, 'CASH')));
  v_provider text;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'method', upper(btrim(coalesce(p_method, 'CASH'))), 'amountVnd', p_amount_vnd, 'tenderGroupId', coalesce(p_tender_group_id, '')));
  v_existing public.command_deduplication;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'payments.record', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  if p_amount_vnd is null or p_amount_vnd <= 0 then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_PAYMENT_AMOUNT'); return; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtext('record_order_payment:' || p_location_id || ':' || v_key));
    select * into v_existing from public.command_deduplication
    where location_id = p_location_id and command_key = v_key and command = 'record_order_payment'
    for update;
    if v_existing.id is not null then
      if v_existing.request_hash <> v_hash then return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'); return; end if;
      return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
      return;
    end if;
  end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  if v_order.status in ('REJECTED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED') then return query select * from public.dd008c_failure('INVALID_STATE', 'ORDER_TERMINAL'); return; end if;
  select * into v_summary from public.dd008c_payment_status_for_order(p_order_id) limit 1;
  if p_amount_vnd > greatest(0, v_order.total_vnd - v_summary.effective_paid_vnd) then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'PAYMENT_EXCEEDS_OUTSTANDING'); return; end if;
  v_provider := case when v_method in ('VNPAY', 'MOMO', 'ZALOPAY') then v_method else 'MANUAL' end;
  insert into public.payment_transactions (id, location_id, order_id, type, method, provider, amount_vnd, tender_group_id, note)
  values (v_payment_id, p_location_id, p_order_id, 'PAYMENT', v_method, v_provider, p_amount_vnd, coalesce(p_tender_group_id, ''), 'DD-008C authoritative payment');
  perform public.dd008c_sync_payment_projection(p_order_id, true);
  perform public.dd008c_write_audit(p_location_id, 'STAFF', v_authz.staff_profile_id, v_authz.staff_profile_id, v_authz.device_id, 'record_order_payment', 'payment', v_payment_id, 'OK');
  perform public.dd008c_emit_refresh(p_location_id, 'cashier', 'payment', v_payment_id, jsonb_build_object('reason', 'PAYMENT_RECORDED'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'payment', v_payment_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  if v_key is not null then
    insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
    values (p_location_id, v_key, 'record_order_payment', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
  end if;
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.void_order_payment(
  p_location_id text,
  p_order_id text,
  p_payment_id text,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_payment public.payment_transactions;
  v_void_id text := 'VOID-' || replace(extensions.gen_random_uuid()::text, '-', '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'paymentId', p_payment_id));
  v_existing public.command_deduplication;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'payments.void', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtext('void_order_payment:' || p_location_id || ':' || v_key));
    select * into v_existing from public.command_deduplication
    where location_id = p_location_id and command_key = v_key and command = 'void_order_payment'
    for update;
    if v_existing.id is not null then
      if v_existing.request_hash <> v_hash then return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'); return; end if;
      return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
      return;
    end if;
  end if;
  select * into v_payment from public.payment_transactions where id = p_payment_id and order_id = p_order_id and location_id = p_location_id and type = 'PAYMENT' for update;
  if v_payment.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'PAYMENT_NOT_FOUND'); return; end if;
  if exists (select 1 from public.payment_transactions where related_payment_id = p_payment_id and type = 'PAYMENT_VOID') then return query select * from public.dd008c_failure('INVALID_STATE', 'PAYMENT_ALREADY_VOIDED'); return; end if;
  if exists (select 1 from public.payment_transactions where related_payment_id = p_payment_id and type = 'REFUND') then return query select * from public.dd008c_failure('INVALID_STATE', 'PAYMENT_ALREADY_REFUNDED'); return; end if;
  insert into public.payment_transactions (id, location_id, order_id, type, method, provider, amount_vnd, related_payment_id, tender_group_id, note)
  values (v_void_id, p_location_id, p_order_id, 'PAYMENT_VOID', v_payment.method, v_payment.provider, v_payment.amount_vnd, p_payment_id, v_payment.tender_group_id, 'DD-008C authoritative payment void');
  perform public.dd008c_sync_payment_projection(p_order_id, true);
  perform public.dd008c_emit_refresh(p_location_id, 'cashier', 'payment', v_void_id, jsonb_build_object('reason', 'PAYMENT_VOID'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'payment', v_void_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  if v_key is not null then
    insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
    values (p_location_id, v_key, 'void_order_payment', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
  end if;
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.refund_order_payment(
  p_location_id text,
  p_order_id text,
  p_payment_id text,
  p_amount_vnd integer,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_order public.orders;
  v_payment public.payment_transactions;
  v_summary record;
  v_refunded integer;
  v_refund_id text := 'REF-' || replace(extensions.gen_random_uuid()::text, '-', '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'orderId', p_order_id, 'paymentId', p_payment_id, 'amountVnd', p_amount_vnd));
  v_existing public.command_deduplication;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'payments.refund', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  if p_amount_vnd is null or p_amount_vnd <= 0 then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_REFUND_AMOUNT'); return; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtext('refund_order_payment:' || p_location_id || ':' || v_key));
    select * into v_existing from public.command_deduplication
    where location_id = p_location_id and command_key = v_key and command = 'refund_order_payment'
    for update;
    if v_existing.id is not null then
      if v_existing.request_hash <> v_hash then return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'); return; end if;
      return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
      return;
    end if;
  end if;
  select * into v_order from public.orders where id = p_order_id and location_id = p_location_id for update;
  if v_order.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'ORDER_NOT_FOUND'); return; end if;
  select * into v_summary from public.dd008c_payment_status_for_order(p_order_id) limit 1;
  if v_summary.effective_paid_vnd < v_order.total_vnd or v_order.total_vnd <= 0 then return query select * from public.dd008c_failure('INVALID_STATE', 'BILL_NOT_SETTLED'); return; end if;
  select * into v_payment from public.payment_transactions where id = p_payment_id and order_id = p_order_id and location_id = p_location_id and type = 'PAYMENT' for update;
  if v_payment.id is null then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'PAYMENT_NOT_FOUND'); return; end if;
  if exists (select 1 from public.payment_transactions where related_payment_id = p_payment_id and type = 'PAYMENT_VOID') then return query select * from public.dd008c_failure('INVALID_STATE', 'PAYMENT_VOIDED'); return; end if;
  select coalesce(sum(amount_vnd), 0) into v_refunded from public.payment_transactions where related_payment_id = p_payment_id and type = 'REFUND';
  if p_amount_vnd > v_payment.amount_vnd - v_refunded then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'REFUND_EXCEEDS_REMAINING'); return; end if;
  insert into public.payment_transactions (id, location_id, order_id, type, method, provider, amount_vnd, related_payment_id, tender_group_id, note)
  values (v_refund_id, p_location_id, p_order_id, 'REFUND', 'REFUND', v_payment.provider, p_amount_vnd, p_payment_id, v_payment.tender_group_id, 'DD-008C authoritative targeted refund');
  perform public.dd008c_sync_payment_projection(p_order_id, true);
  perform public.dd008c_emit_refresh(p_location_id, 'cashier', 'payment', v_refund_id, jsonb_build_object('reason', 'PAYMENT_REFUND'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'payment', v_refund_id, (select public.orders.version from public.orders where public.orders.id = p_order_id), jsonb_build_object('order', public.dd008c_order_payload(p_order_id, true)));
  if v_key is not null then
    insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
    values (p_location_id, v_key, 'refund_order_payment', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
  end if;
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.record_table_tender(
  p_location_id text,
  p_table_session_id text,
  p_method text,
  p_amount_vnd integer,
  p_idempotency_key text default '',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_session public.table_sessions;
  v_remaining integer := p_amount_vnd;
  v_order record;
  v_summary record;
  v_pay_amount integer;
  v_outstanding integer := 0;
  v_group text := 'TG-' || replace(extensions.gen_random_uuid()::text, '-', '');
  v_method text := upper(btrim(coalesce(p_method, 'CASH')));
  v_provider text := case when upper(btrim(coalesce(p_method, 'CASH'))) in ('VNPAY', 'MOMO', 'ZALOPAY') then upper(btrim(coalesce(p_method, 'CASH'))) else 'MANUAL' end;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'tableSessionId', p_table_session_id, 'method', upper(btrim(coalesce(p_method, 'CASH'))), 'amountVnd', p_amount_vnd));
  v_existing public.command_deduplication;
  v_result jsonb;
begin
  select * into v_authz from public.dd008c_authorize_command(p_location_id, 'payments.record', p_workstation_mode, p_device_credential) limit 1;
  if v_authz.ok is distinct from true then return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')); return; end if;
  if p_amount_vnd is null or p_amount_vnd <= 0 then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'INVALID_TENDER_AMOUNT'); return; end if;
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtext('record_table_tender:' || p_location_id || ':' || v_key));
    select * into v_existing from public.command_deduplication
    where location_id = p_location_id and command_key = v_key and command = 'record_table_tender'
    for update;
    if v_existing.id is not null then
      if v_existing.request_hash <> v_hash then return query select * from public.dd008c_failure('CONFLICT', 'IDEMPOTENCY_KEY_REUSED'); return; end if;
      return query select * from public.dd008c_result_from_json(v_existing.result_reference::jsonb);
      return;
    end if;
  end if;
  select * into v_session from public.table_sessions where id = p_table_session_id and location_id = p_location_id for update;
  if v_session.id is null or v_session.status <> 'OPEN' then return query select * from public.dd008c_failure('INVALID_STATE', 'SESSION_NOT_OPEN'); return; end if;
  select coalesce(sum(greatest(0, public.orders.total_vnd - payment_status.effective_paid_vnd)), 0)::integer
  into v_outstanding
  from public.orders
  cross join lateral public.dd008c_payment_status_for_order(public.orders.id) as payment_status
  where public.orders.table_session_id = p_table_session_id
    and public.orders.location_id = p_location_id
    and public.orders.status not in ('REJECTED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED');
  if v_outstanding <= 0 then return query select * from public.dd008c_failure('INVALID_STATE', 'NO_OUTSTANDING_BALANCE'); return; end if;
  if p_amount_vnd > v_outstanding then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TENDER_EXCEEDS_OUTSTANDING'); return; end if;
  for v_order in select * from public.orders where table_session_id = p_table_session_id and location_id = p_location_id order by created_at, id
  loop
    exit when v_remaining <= 0;
    select * into v_summary from public.dd008c_payment_status_for_order(v_order.id) limit 1;
    v_pay_amount := least(greatest(0, v_order.total_vnd - v_summary.effective_paid_vnd), v_remaining);
    if v_pay_amount > 0 then
      insert into public.payment_transactions (id, location_id, order_id, type, method, provider, amount_vnd, tender_group_id, note)
      values ('PAY-' || replace(extensions.gen_random_uuid()::text, '-', ''), p_location_id, v_order.id, 'PAYMENT', v_method, v_provider, v_pay_amount, v_group, 'DD-008C table tender');
      perform public.dd008c_sync_payment_projection(v_order.id, true);
      v_remaining := v_remaining - v_pay_amount;
    end if;
  end loop;
  if v_remaining > 0 then return query select * from public.dd008c_failure('VALIDATION_ERROR', 'TENDER_EXCEEDS_OUTSTANDING'); return; end if;
  perform public.dd008c_emit_refresh(p_location_id, 'cashier', 'table_session', p_table_session_id, jsonb_build_object('reason', 'TABLE_TENDER'));
  v_result := public.dd008c_result_json(true, 'OK', '', 'table_session', p_table_session_id, v_session.version, jsonb_build_object('tenderGroupId', v_group));
  if v_key is not null then
    insert into public.command_deduplication (location_id, command_key, command, actor_type, actor_id, request_hash, result_reference)
    values (p_location_id, v_key, 'record_table_tender', 'STAFF', v_authz.staff_profile_id, v_hash, v_result::text);
  end if;
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd008c_result_json(boolean, text, text, text, text, integer, jsonb) from public;
revoke all on function public.dd008c_result_from_json(jsonb) from public;
revoke all on function public.dd008c_success(text, text, integer, jsonb) from public;
revoke all on function public.dd008c_failure(text, text, text, text, jsonb) from public;
revoke all on function public.dd008c_hash_request(jsonb) from public;
revoke all on function public.dd008c_replay_command(text, text, text, text) from public;
revoke all on function public.dd008c_store_command(text, text, text, text, text, text, jsonb) from public;
revoke all on function public.dd008c_normalize_positive_integer(jsonb) from public;
revoke all on function public.dd008c_emit_refresh(text, text, text, text, jsonb) from public;
revoke all on function public.dd008c_write_audit(text, text, text, text, text, text, text, text, text, jsonb) from public;
revoke all on function public.dd008c_payment_status_for_order(text) from public;
revoke all on function public.dd008c_is_order_service_complete(text) from public;
revoke all on function public.dd008c_sync_payment_projection(text, boolean) from public;
revoke all on function public.dd008c_refresh_order_status(text) from public;
revoke all on function public.dd008c_order_payload(text, boolean) from public;
revoke all on function public.dd008c_table_session_payload(text) from public;
revoke all on function public.dd008c_open_or_reuse_table_session(text, text, text) from public;
revoke all on function public.dd008c_insert_order_from_items(text, text, text, text, text, text, text, jsonb, text) from public;
revoke all on function public.dd008c_authorize_command(text, text, text, text) from public;
revoke all on function public.dd008c_station_permission(text) from public;
revoke all on function public.dd008c_family_mutable(text, text) from public;

revoke all on function public.submit_qr_order(text, jsonb, text, text) from public;
revoke all on function public.create_service_request(text, text, text) from public;
revoke all on function public.dd008c_get_public_table_snapshot(text) from public;
revoke all on function public.dd008c_get_location_snapshot(text, text, text) from public;
revoke all on function public.create_staff_order(text, jsonb, text, text, text, text, text, text) from public;
revoke all on function public.set_order_status(text, text, text, integer, text, text, text) from public;
revoke all on function public.update_kds_line_prep(text, text, text[], text, integer, text, text, text) from public;
revoke all on function public.serve_order_line(text, text, text, integer, integer, text, text, text) from public;
revoke all on function public.serve_all_ready(text, text, integer, text, text, text) from public;
revoke all on function public.assign_order_family_course(text, text, text, text, text, text, text) from public;
revoke all on function public.hold_order_family(text, text, text, text, text, text) from public;
revoke all on function public.fire_order_family(text, text, text, text, text, text) from public;
revoke all on function public.fire_order_course(text, text, text, text, text, text) from public;
revoke all on function public.open_table_visit(text, text, text, text, text) from public;
revoke all on function public.transfer_table_visit(text, text, text, integer, text, text, text) from public;
revoke all on function public.close_table_visit(text, text, integer, text, text, text) from public;
revoke all on function public.complete_service_request(text, text, integer, text, text, text) from public;
revoke all on function public.update_order_line_bill_qty(text, text, text, integer, integer, text, text, text) from public;
revoke all on function public.record_order_payment(text, text, text, integer, text, text, text, text) from public;
revoke all on function public.void_order_payment(text, text, text, text, text, text) from public;
revoke all on function public.refund_order_payment(text, text, text, integer, text, text, text) from public;
revoke all on function public.record_table_tender(text, text, text, integer, text, text, text) from public;

grant execute on function public.submit_qr_order(text, jsonb, text, text) to anon, authenticated;
grant execute on function public.create_service_request(text, text, text) to anon, authenticated;
grant execute on function public.dd008c_get_public_table_snapshot(text) to anon, authenticated;

grant execute on function public.dd008c_get_location_snapshot(text, text, text) to authenticated;
grant execute on function public.create_staff_order(text, jsonb, text, text, text, text, text, text) to authenticated;
grant execute on function public.set_order_status(text, text, text, integer, text, text, text) to authenticated;
grant execute on function public.update_kds_line_prep(text, text, text[], text, integer, text, text, text) to authenticated;
grant execute on function public.serve_order_line(text, text, text, integer, integer, text, text, text) to authenticated;
grant execute on function public.serve_all_ready(text, text, integer, text, text, text) to authenticated;
grant execute on function public.assign_order_family_course(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.hold_order_family(text, text, text, text, text, text) to authenticated;
grant execute on function public.fire_order_family(text, text, text, text, text, text) to authenticated;
grant execute on function public.fire_order_course(text, text, text, text, text, text) to authenticated;
grant execute on function public.open_table_visit(text, text, text, text, text) to authenticated;
grant execute on function public.transfer_table_visit(text, text, text, integer, text, text, text) to authenticated;
grant execute on function public.close_table_visit(text, text, integer, text, text, text) to authenticated;
grant execute on function public.complete_service_request(text, text, integer, text, text, text) to authenticated;
grant execute on function public.update_order_line_bill_qty(text, text, text, integer, integer, text, text, text) to authenticated;
grant execute on function public.record_order_payment(text, text, text, integer, text, text, text, text) to authenticated;
grant execute on function public.void_order_payment(text, text, text, text, text, text) to authenticated;
grant execute on function public.refund_order_payment(text, text, text, integer, text, text, text) to authenticated;
grant execute on function public.record_table_tender(text, text, text, integer, text, text, text) to authenticated;
