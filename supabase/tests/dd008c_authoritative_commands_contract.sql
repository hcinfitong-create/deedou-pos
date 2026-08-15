-- DD-008C authoritative command and realtime contract.
-- Runs against local Supabase/Postgres in CI; no production credentials.

begin;

create temporary table dd008c_contract_ids (
  key text primary key,
  value text not null
) on commit drop;
grant all on dd008c_contract_ids to anon, authenticated;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values
  ('dd008c-table-d01', 'deedou-demo', 'D01', 'Contract', 'dd008c-d01-token-47VLmz', 901),
  ('dd008c-table-d02', 'deedou-demo', 'D02', 'Contract', 'dd008c-d02-token-47VLmz', 902),
  ('dd008c-table-d03', 'deedou-demo', 'D03', 'Contract', 'dd008c-d03-token-47VLmz', 903),
  ('dd008c-table-d04', 'deedou-demo', 'D04', 'Contract', 'dd008c-d04-token-47VLmz', 904),
  ('dd008c-table-d05', 'deedou-demo', 'D05', 'Contract', 'dd008c-d05-token-47VLmz', 905)
on conflict (id) do nothing;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin
)
values
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dd008c-cashier@example.invalid', crypt('local-only-dd008c-cashier', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dd008c-floor@example.invalid', crypt('local-only-dd008c-floor', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'dd008c-kitchen@example.invalid', crypt('local-only-dd008c-kitchen', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'dd008c-bar@example.invalid', crypt('local-only-dd008c-bar', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'dd008c-manager@example.invalid', crypt('local-only-dd008c-manager', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd008c-staff-cashier', '20000000-0000-4000-8000-000000000001', 'DD-008C Cashier', true),
  ('dd008c-staff-floor', '20000000-0000-4000-8000-000000000002', 'DD-008C Floor', true),
  ('dd008c-staff-kitchen', '20000000-0000-4000-8000-000000000003', 'DD-008C Kitchen', true),
  ('dd008c-staff-bar', '20000000-0000-4000-8000-000000000004', 'DD-008C Bar', true),
  ('dd008c-staff-manager', '20000000-0000-4000-8000-000000000005', 'DD-008C Manager', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd008c-staff-cashier', 'deedou-demo', true),
  ('dd008c-staff-floor', 'deedou-demo', true),
  ('dd008c-staff-kitchen', 'deedou-demo', true),
  ('dd008c-staff-bar', 'deedou-demo', true),
  ('dd008c-staff-manager', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd008c-staff-cashier', 'deedou-demo', 'CASHIER', true),
  ('dd008c-staff-floor', 'deedou-demo', 'FLOOR_STAFF', true),
  ('dd008c-staff-kitchen', 'deedou-demo', 'KITCHEN', true),
  ('dd008c-staff-bar', 'deedou-demo', 'BAR', true),
  ('dd008c-staff-manager', 'deedou-demo', 'MANAGER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  ('dd008c-dev-cashier', 'deedou-demo', 'DD-008C Cashier', 'CASHIER', public.hash_device_credential('dd008c-cashier-device'), true, 'dd008c-staff-cashier'),
  ('dd008c-dev-staff', 'deedou-demo', 'DD-008C Floor Staff', 'STAFF', public.hash_device_credential('dd008c-staff-device'), true, 'dd008c-staff-floor'),
  ('dd008c-dev-kitchen', 'deedou-demo', 'DD-008C Kitchen KDS', 'KDS_KITCHEN', public.hash_device_credential('dd008c-kitchen-device'), true, 'dd008c-staff-kitchen'),
  ('dd008c-dev-bar', 'deedou-demo', 'DD-008C Bar KDS', 'KDS_BAR', public.hash_device_credential('dd008c-bar-device'), true, 'dd008c-staff-bar')
on conflict (id) do nothing;

set local role anon;
set local request.jwt.claim.sub = '';

do $$
declare
  v_result record;
  v_order_id text;
  v_count integer;
begin
  select * into v_result
  from public.submit_qr_order(
    'dd008c-d01-token-47VLmz',
    '[{"productId":"fried-rice","qty":2,"price":1}]'::jsonb,
    'DD-008C QR ignores client price',
    'dd008c-public-qr-1'
  )
  limit 1;

  if v_result.ok <> true then
    raise exception 'expected public QR submit accepted, got %/%', v_result.category, v_result.reason;
  end if;

  v_order_id := v_result.entity_id;
  select count(*) into v_count
  from public.submit_qr_order(
    'dd008c-d01-token-47VLmz',
    '[{"productId":"fried-rice","qty":2,"price":1}]'::jsonb,
    'DD-008C QR ignores client price',
    'dd008c-public-qr-1'
  )
  where ok = true and entity_id = v_order_id;
  if v_count <> 1 then
    raise exception 'expected public QR duplicate idempotency replay';
  end if;

  select * into v_result
  from public.submit_qr_order(
    'dd008c-d01-token-47VLmz',
    '[{"productId":"fried-rice","qty":2}]'::jsonb,
    'different payload',
    'dd008c-public-qr-1'
  )
  limit 1;
  if v_result.ok <> false or v_result.category <> 'CONFLICT' then
    raise exception 'expected idempotency key reuse conflict, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.submit_qr_order(
    'dd008c-d01-token-47VLmz',
    '[{"productId":"mango-tea","qty":1,"selection":{"variantId":"regular","modifierSelections":{}}}]'::jsonb,
    'missing required modifier',
    'dd008c-public-qr-missing-option'
  )
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'OPTION_COUNT_INVALID' then
    raise exception 'expected required option count rejection, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd008c_get_public_table_snapshot('not-the-token')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'TABLE_TOKEN_NOT_FOUND' then
    raise exception 'expected exact-token public resolver failure, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare
  v_order_id text;
  v_total integer;
  v_open_sessions integer;
begin
  select entity_id into v_order_id
  from public.command_deduplication
  cross join lateral public.dd008c_result_from_json(public.command_deduplication.result_reference::jsonb)
  where command = 'submit_qr_order'
    and command_key = 'dd008c-public-qr-1'
  limit 1;

  select total_vnd into v_total from public.orders where id = v_order_id;
  if v_total <> 198000 then
    raise exception 'expected authoritative price 198000, got %', v_total;
  end if;

  select count(*) into v_open_sessions
  from public.table_sessions
  where physical_table_id = 'dd008c-table-d01'
    and status = 'OPEN';
  if v_open_sessions <> 1 then
    raise exception 'expected one open session for QR table, got %', v_open_sessions;
  end if;
end $$;

insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status, source)
values
  ('dd008c-session-d02', 'deedou-demo', 'dd008c-table-d02', 'D02', 'Contract', 'OPEN', 'CONTRACT')
on conflict (id) do nothing;

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
  version
)
values
  ('dd008c-order-pending', 'deedou-demo', 'DD008C-PENDING', 'dd008c-session-d02', 'dd008c-table-d02', 'TABLE_SERVICE', 'DINE_IN', 'CUSTOMER_QR', 'Contract', 'D02', 'PENDING_ACCEPTANCE', 198000, 1),
  ('dd008c-order-skip', 'deedou-demo', 'DD008C-SKIP', 'dd008c-session-d02', 'dd008c-table-d02', 'TABLE_SERVICE', 'DINE_IN', 'CUSTOMER_QR', 'Contract', 'D02', 'PENDING_ACCEPTANCE', 99000, 1),
  ('dd008c-order-multi', 'deedou-demo', 'DD008C-MULTI', 'dd008c-session-d02', 'dd008c-table-d02', 'TABLE_SERVICE', 'DINE_IN', 'CUSTOMER_QR', 'Contract', 'D02', 'ACCEPTED', 154000, 1)
on conflict (id) do nothing;

insert into public.order_lines (id, order_id, line_id, product_id, station_code, name_vi, name_en, qty, bill_qty, price_vnd, prep_status, item_status, hold_state, queued_at)
values
  ('dd008c-line-pending-rice', 'dd008c-order-pending', 'fried-rice:1:item', 'fried-rice', 'KITCHEN_HOT', 'Com chien hai san', 'Seafood Fried Rice', 2, 2, 99000, 'QUEUED', 'QUEUED', 'FIRED', null),
  ('dd008c-line-skip-rice', 'dd008c-order-skip', 'fried-rice:1:item', 'fried-rice', 'KITCHEN_HOT', 'Com chien hai san', 'Seafood Fried Rice', 1, 1, 99000, 'QUEUED', 'QUEUED', 'FIRED', null),
  ('dd008c-line-multi-hot', 'dd008c-order-multi', 'fried-rice:1:item', 'fried-rice', 'KITCHEN_HOT', 'Com chien hai san', 'Seafood Fried Rice', 1, 1, 99000, 'QUEUED', 'QUEUED', 'FIRED', now()),
  ('dd008c-line-multi-tea', 'dd008c-order-multi', 'mango-tea:2:item', 'mango-tea', 'BAR_TEA', 'Tra xoai', 'Mango Tea', 1, 1, 55000, 'QUEUED', 'QUEUED', 'FIRED', now())
on conflict (order_id, line_id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.set_order_status('deedou-demo', 'dd008c-order-skip', 'READY', 1, 'dd008c-status-skip', 'STAFF', 'dd008c-staff-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'INVALID_STATUS_TRANSITION' then
    raise exception 'expected PENDING -> READY rejected, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.set_order_status('deedou-demo', 'dd008c-order-pending', 'ACCEPTED', 1, 'dd008c-status-accept', 'STAFF', 'dd008c-staff-device')
  limit 1;
  if v_result.ok <> true or v_result.version <> 2 then
    raise exception 'expected ACCEPTED version 2, got %/%/%', v_result.ok, v_result.reason, v_result.version;
  end if;

  select * into v_result
  from public.set_order_status('deedou-demo', 'dd008c-order-pending', 'ACCEPTED', 1, 'dd008c-status-accept', 'STAFF', 'dd008c-staff-device')
  limit 1;
  if v_result.ok <> true or v_result.version <> 2 then
    raise exception 'expected duplicate ACCEPT replay without version bump, got %/%/%', v_result.ok, v_result.reason, v_result.version;
  end if;
end $$;

reset role;

do $$
declare
  v_status text;
  v_version integer;
begin
  select status, version into v_status, v_version from public.orders where id = 'dd008c-order-skip';
  if v_status <> 'PENDING_ACCEPTANCE' or v_version <> 1 then
    raise exception 'invalid transition mutated order: %/%', v_status, v_version;
  end if;

  if exists (
    select 1 from public.order_lines
    where order_id = 'dd008c-order-pending'
      and station_code <> 'COMBO'
      and queued_at is null
  ) then
    raise exception 'acceptance should queue fired station lines';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000003';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.update_kds_line_prep('deedou-demo', 'dd008c-order-pending', array['fried-rice:1:item'], 'READY', 2, 'dd008c-kds-skip', 'KDS_KITCHEN', 'dd008c-kitchen-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'INVALID_PREP_STATUS_TRANSITION' then
    raise exception 'expected KDS skip rejected, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-pending', array['fried-rice:1:item'], 'ACKNOWLEDGED', 2, 'dd008c-kds-ack', 'KDS_KITCHEN', 'dd008c-kitchen-device') limit 1;
  if v_result.ok <> true or v_result.version <> 3 then raise exception 'expected KDS ACK version 3, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-pending', array['fried-rice:1:item'], 'PREPARING', 3, 'dd008c-kds-prep', 'KDS_KITCHEN', 'dd008c-kitchen-device') limit 1;
  if v_result.ok <> true or v_result.version <> 4 then raise exception 'expected KDS PREPARING version 4, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-pending', array['fried-rice:1:item'], 'READY', 4, 'dd008c-kds-ready', 'KDS_KITCHEN', 'dd008c-kitchen-device') limit 1;
  if v_result.ok <> true or v_result.version <> 5 then raise exception 'expected KDS READY version 5, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;

  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-multi', array['fried-rice:1:item'], 'ACKNOWLEDGED', 1, 'dd008c-multi-hot-ack', 'KDS_KITCHEN', 'dd008c-kitchen-device') limit 1;
  if v_result.ok <> true or v_result.version <> 2 then raise exception 'expected multi hot ACK version 2, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-multi', array['fried-rice:1:item'], 'PREPARING', 2, 'dd008c-multi-hot-prep', 'KDS_KITCHEN', 'dd008c-kitchen-device') limit 1;
  if v_result.ok <> true or v_result.version <> 3 then raise exception 'expected multi hot PREPARING version 3, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-multi', array['fried-rice:1:item'], 'READY', 3, 'dd008c-multi-hot-ready', 'KDS_KITCHEN', 'dd008c-kitchen-device') limit 1;
  if v_result.ok <> true or v_result.version <> 4 then raise exception 'expected multi hot READY version 4, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
end $$;

reset role;

do $$
declare
  v_status text;
  v_served integer;
begin
  select status into v_status from public.orders where id = 'dd008c-order-multi';
  if v_status = 'READY' then
    raise exception 'overall order became READY before all required stations were ready';
  end if;

  select served_qty into v_served
  from public.order_lines
  where order_id = 'dd008c-order-pending'
    and line_id = 'fried-rice:1:item';
  if v_served <> 0 then
    raise exception 'KDS prep mutated served quantity: %', v_served;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000004';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
begin
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-multi', array['mango-tea:2:item'], 'ACKNOWLEDGED', 4, 'dd008c-multi-tea-ack', 'KDS_BAR', 'dd008c-bar-device') limit 1;
  if v_result.ok <> true or v_result.version <> 5 then raise exception 'expected multi tea ACK version 5, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-multi', array['mango-tea:2:item'], 'PREPARING', 5, 'dd008c-multi-tea-prep', 'KDS_BAR', 'dd008c-bar-device') limit 1;
  if v_result.ok <> true or v_result.version <> 6 then raise exception 'expected multi tea PREPARING version 6, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
  select * into v_result from public.update_kds_line_prep('deedou-demo', 'dd008c-order-multi', array['mango-tea:2:item'], 'READY', 6, 'dd008c-multi-tea-ready', 'KDS_BAR', 'dd008c-bar-device') limit 1;
  if v_result.ok <> true or v_result.version <> 7 then raise exception 'expected multi tea READY version 7, got %/%/%', v_result.ok, v_result.reason, v_result.version; end if;
end $$;

reset role;

do $$
declare
  v_status text;
begin
  select status into v_status from public.orders where id = 'dd008c-order-multi';
  if v_status <> 'READY' then
    raise exception 'expected multi-station order READY after all stations ready, got %', v_status;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.serve_order_line('deedou-demo', 'dd008c-order-pending', 'fried-rice:1:item', 1, 5, 'dd008c-serve-1', 'STAFF', 'dd008c-staff-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected partial serve allowed, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.serve_order_line('deedou-demo', 'dd008c-order-pending', 'fried-rice:1:item', 2, 6, 'dd008c-serve-over', 'STAFF', 'dd008c-staff-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'SERVED_QTY_EXCEEDS_REMAINING' then
    raise exception 'expected overserve rejected, got %/%', v_result.category, v_result.reason;
  end if;

  perform public.serve_order_line('deedou-demo', 'dd008c-order-pending', 'fried-rice:1:item', 1, 6, 'dd008c-serve-2', 'STAFF', 'dd008c-staff-device');
end $$;

reset role;

do $$
declare
  v_served integer;
  v_status text;
begin
  select served_qty into v_served
  from public.order_lines
  where order_id = 'dd008c-order-pending'
    and line_id = 'fried-rice:1:item';
  select status into v_status from public.orders where id = 'dd008c-order-pending';
  if v_served <> 2 or v_status <> 'SERVED' then
    raise exception 'expected served progress 2/SERVED, got %/%', v_served, v_status;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_payment_id text;
begin
  select * into v_result
  from public.record_order_payment('deedou-demo', 'dd008c-order-pending', 'CASH', 0, '', 'dd008c-pay-zero', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'INVALID_PAYMENT_AMOUNT' then
    raise exception 'expected zero payment rejected, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.record_order_payment('deedou-demo', 'dd008c-order-pending', 'CASH', 198001, '', 'dd008c-pay-over', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'PAYMENT_EXCEEDS_OUTSTANDING' then
    raise exception 'expected overpayment rejected, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.record_order_payment('deedou-demo', 'dd008c-order-pending', 'CASH', 198000, '', 'dd008c-pay-full', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected full payment accepted, got %/%', v_result.category, v_result.reason;
  end if;
  v_payment_id := v_result.entity_id;

  select * into v_result
  from public.record_order_payment('deedou-demo', 'dd008c-order-pending', 'CASH', 198000, '', 'dd008c-pay-full', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true or v_result.entity_id <> v_payment_id then
    raise exception 'expected duplicate payment replay to return same payment, got %/%/%', v_result.ok, v_result.reason, v_result.entity_id;
  end if;

  insert into dd008c_contract_ids (key, value)
  values ('pending-payment', v_payment_id)
  on conflict (key) do update set value = excluded.value;

  select * into v_result
  from public.refund_order_payment('deedou-demo', 'dd008c-order-pending', v_payment_id, 1000, 'dd008c-refund-cashier-denied', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' or v_result.reason <> 'PERMISSION_DENIED' then
    raise exception 'expected cashier refund denied by RBAC, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare
  v_payment_count integer;
begin
  select count(*) into v_payment_count
  from public.payment_transactions
  where order_id = 'dd008c-order-pending'
    and type = 'PAYMENT';
  if v_payment_count <> 1 then
    raise exception 'expected duplicate payment replay to create one payment, got %', v_payment_count;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000005';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_payment_id text;
begin
  select value into v_payment_id from dd008c_contract_ids where key = 'pending-payment';
  if v_payment_id is null then
    raise exception 'expected pending-payment id captured before refund checks';
  end if;

  select * into v_result
  from public.refund_order_payment('deedou-demo', 'dd008c-order-pending', 'not-a-payment', 1000, 'dd008c-refund-unknown', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.category <> 'VALIDATION_ERROR' or v_result.reason <> 'PAYMENT_NOT_FOUND' then
    raise exception 'expected unknown payment refund blocked, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.refund_order_payment('deedou-demo', 'dd008c-order-pending', v_payment_id, 200000, 'dd008c-refund-over', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.category <> 'VALIDATION_ERROR' or v_result.reason <> 'REFUND_EXCEEDS_REMAINING' then
    raise exception 'expected over-refund blocked, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.refund_order_payment('deedou-demo', 'dd008c-order-pending', v_payment_id, 50000, 'dd008c-refund-partial', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected manager targeted refund accepted, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare
  v_payment_id text;
  v_payment_count integer;
  v_refund_count integer;
  v_refund_amount bigint;
  v_refund_payment_id text;
begin
  select value into v_payment_id from dd008c_contract_ids where key = 'pending-payment';

  select count(*) into v_payment_count
  from public.payment_transactions
  where order_id = 'dd008c-order-pending'
    and type = 'PAYMENT';
  if v_payment_count <> 1 then
    raise exception 'expected one original payment after refund checks, got %', v_payment_count;
  end if;

  select count(*), coalesce(sum(amount_vnd), 0), min(related_payment_id)
  into v_refund_count, v_refund_amount, v_refund_payment_id
  from public.payment_transactions
  where order_id = 'dd008c-order-pending'
    and type = 'REFUND';
  if v_refund_count <> 1 or v_refund_payment_id <> v_payment_id or v_refund_amount <> 50000 then
    raise exception 'expected one 50000 refund against %, got count % related % amount %', v_payment_id, v_refund_count, v_refund_payment_id, v_refund_amount;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_order_a text;
  v_order_b text;
  v_result record;
begin
  select * into v_result
  from public.create_staff_order('deedou-demo', '[{"productId":"espresso","qty":1}]'::jsonb, '', 'TAKEAWAY', 'takeaway A', 'dd008c-takeaway-a', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected takeaway A created, got %/%', v_result.category, v_result.reason;
  end if;
  v_order_a := v_result.entity_id;

  select * into v_result
  from public.create_staff_order('deedou-demo', '[{"productId":"mango-tea","qty":1,"selection":{"variantId":"regular","modifierSelections":{"sugar":["sugar-50"]}}}]'::jsonb, '', 'TAKEAWAY', 'takeaway B', 'dd008c-takeaway-b', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected takeaway B created, got %/%', v_result.category, v_result.reason;
  end if;
  v_order_b := v_result.entity_id;

  insert into dd008c_contract_ids (key, value)
  values
    ('takeaway-a', v_order_a),
    ('takeaway-b', v_order_b)
  on conflict (key) do update set value = excluded.value;

  select * into v_result
  from public.record_order_payment('deedou-demo', v_order_a, 'VNPAY', 39000, '', 'dd008c-takeaway-pay-a', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected takeaway A payment accepted, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.record_table_tender('deedou-demo', 'dd008c-session-d02', 'CASH', 9999999, 'dd008c-table-overpay', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'TENDER_EXCEEDS_OUTSTANDING' then
    raise exception 'expected table tender overpay rejected, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare
  v_order_a text;
  v_order_b text;
begin
  select value into v_order_a from dd008c_contract_ids where key = 'takeaway-a';
  select value into v_order_b from dd008c_contract_ids where key = 'takeaway-b';

  if v_order_a is null or v_order_b is null then
    raise exception 'expected takeaway ids captured by command result';
  end if;

  if exists (select 1 from public.orders where id in (v_order_a, v_order_b) and table_session_id is not null) then
    raise exception 'takeaway orders must not create table sessions';
  end if;

  if exists (select 1 from public.orders where id in (v_order_a, v_order_b) and physical_table_id is not null) then
    raise exception 'takeaway orders must not attach to physical tables';
  end if;

  if exists (select 1 from public.orders where id in (v_order_a, v_order_b) and service_mode <> 'COUNTER_SERVICE') then
    raise exception 'takeaway orders must use counter service mode';
  end if;

  if exists (select 1 from public.orders where id in (v_order_a, v_order_b) and fulfillment_type <> 'TAKEAWAY') then
    raise exception 'takeaway orders must keep TAKEAWAY fulfillment type';
  end if;

  if (select paid_vnd from public.orders where id = v_order_a) <> 39000 then
    raise exception 'expected takeaway A paid_vnd 39000 after isolated payment';
  end if;

  if (select paid_vnd from public.orders where id = v_order_b) <> 0 then
    raise exception 'paying takeaway A mutated takeaway B';
  end if;

  if exists (select 1 from public.payment_transactions where order_id = v_order_b) then
    raise exception 'paying takeaway A created payment ledger rows on takeaway B';
  end if;
end $$;

insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status, source)
values ('dd008c-session-tender', 'deedou-demo', 'dd008c-table-d03', 'D03', 'Contract', 'OPEN', 'CONTRACT')
on conflict (id) do nothing;

insert into public.orders (id, location_id, order_no, table_session_id, physical_table_id, service_mode, fulfillment_type, order_source, zone, table_code, status, total_vnd, version)
values
  ('dd008c-order-tender-a', 'deedou-demo', 'DD008C-TENDER-A', 'dd008c-session-tender', 'dd008c-table-d03', 'TABLE_SERVICE', 'DINE_IN', 'STAFF', 'Contract', 'D03', 'SERVED', 39000, 1),
  ('dd008c-order-tender-b', 'deedou-demo', 'DD008C-TENDER-B', 'dd008c-session-tender', 'dd008c-table-d03', 'TABLE_SERVICE', 'DINE_IN', 'STAFF', 'Contract', 'D03', 'SERVED', 55000, 1)
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
begin
  perform public.record_table_tender('deedou-demo', 'dd008c-session-tender', 'BANK_TRANSFER', 94000, 'dd008c-table-tender-full', 'CASHIER', 'dd008c-cashier-device');
end $$;

reset role;

do $$
declare
  v_groups integer;
  v_payments integer;
begin
  select count(*), count(distinct tender_group_id)
  into v_payments, v_groups
  from public.payment_transactions
  where order_id in ('dd008c-order-tender-a', 'dd008c-order-tender-b')
    and type = 'PAYMENT';

  if v_payments <> 2 or v_groups <> 1 then
    raise exception 'expected one table tender group across two payments, got payments %, groups %', v_payments, v_groups;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_session_id text;
  v_version integer;
begin
  perform public.open_table_visit('deedou-demo', 'D04', 'dd008c-open-d04', 'CASHIER', 'dd008c-cashier-device');
  perform public.open_table_visit('deedou-demo', 'D04', 'dd008c-open-d04', 'CASHIER', 'dd008c-cashier-device');

  select session_payload.payload->>'id', (session_payload.payload->>'version')::integer
  into v_session_id, v_version
  from public.dd008c_get_location_snapshot('deedou-demo', 'CASHIER', 'dd008c-cashier-device')
  cross join lateral jsonb_array_elements(payload->'tableSessions') as session_payload(payload)
  where session_payload.payload->>'tableCode' = 'D04'
    and session_payload.payload->>'status' = 'OPEN'
  limit 1;

  if v_session_id is null then
    raise exception 'expected D04 session from open_table_visit';
  end if;

  perform public.create_service_request('dd008c-d04-token-47VLmz', 'CALL_STAFF', 'dd008c-service-before-transfer');
  select * into v_result
  from public.transfer_table_visit('deedou-demo', v_session_id, 'D02', v_version, 'dd008c-transfer-d04-d02', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.reason <> 'DESTINATION_OCCUPIED' then
    raise exception 'expected transfer to occupied D02 rejected, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.transfer_table_visit('deedou-demo', v_session_id, 'D05', v_version, 'dd008c-transfer-d04-d05', 'CASHIER', 'dd008c-cashier-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected transfer to vacant D05, got %/%', v_result.category, v_result.reason;
  end if;

  perform public.close_table_visit('deedou-demo', v_session_id, v_result.version, 'dd008c-close-d05', 'CASHIER', 'dd008c-cashier-device');
  perform public.close_table_visit('deedou-demo', v_session_id, v_result.version, 'dd008c-close-d05', 'CASHIER', 'dd008c-cashier-device');
end $$;

reset role;

do $$
declare
  v_session public.table_sessions;
  v_request public.service_requests;
begin
  select * into v_session
  from public.table_sessions
  where id = (
    select entity_id
    from public.command_deduplication
    cross join lateral public.dd008c_result_from_json(public.command_deduplication.result_reference::jsonb)
    where command_key = 'dd008c-open-d04'
    limit 1
  );

  if v_session.status <> 'CLOSED' or v_session.table_code <> 'D05' then
    raise exception 'expected transferred empty session to close at D05, got %/%', v_session.status, v_session.table_code;
  end if;

  select * into v_request
  from public.service_requests
  where table_session_id = v_session.id
  limit 1;
  if v_request.table_code <> 'D05' or v_request.zone <> 'Contract' then
    raise exception 'expected unresolved service request to follow transfer, got %/%', v_request.table_code, v_request.zone;
  end if;
end $$;

set local role anon;
set local request.jwt.claim.sub = '';

do $$
begin
  perform 1 from public.dd008c_refresh_hints limit 1;
  raise exception 'expected anon raw refresh hint read to be blocked';
exception
  when insufficient_privilege then null;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_hint_count integer;
begin
  select count(*) into v_hint_count
  from public.dd008c_refresh_hints
  where location_id = 'deedou-demo';
  if v_hint_count = 0 then
    raise exception 'expected authenticated location staff to see location-scoped refresh hints';
  end if;
end $$;

reset role;

rollback;
