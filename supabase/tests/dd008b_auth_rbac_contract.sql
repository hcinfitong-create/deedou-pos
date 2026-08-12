-- DD-008B database contract.
-- Runs only against local Supabase/Postgres in CI; no production credentials.

begin;

insert into public.locations (id, name, timezone, currency)
values
  ('auth-location-a', 'Auth Location A', 'Asia/Saigon', 'VND'),
  ('auth-location-b', 'Auth Location B', 'Asia/Saigon', 'VND')
on conflict (id) do nothing;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values
  ('auth-table-a01', 'auth-location-a', 'A01', 'Beach', 'auth-token-a01-47VLmz', 1),
  ('auth-table-b01', 'auth-location-b', 'B01', 'Indoor', 'auth-token-b01-47VLmz', 1)
on conflict (id) do nothing;

insert into public.products (id, location_id, kind, category, name_vi, name_en, desc_vi, desc_en, price_vnd, station_code, available)
values
  ('auth-tea-a', 'auth-location-a', 'DRINK', 'drink-tea', 'Tra Auth A', 'Auth Tea A', '', '', 50000, 'BAR_TEA', true),
  ('auth-tea-b', 'auth-location-b', 'DRINK', 'drink-tea', 'Tra Auth B', 'Auth Tea B', '', '', 50000, 'BAR_TEA', true)
on conflict (id) do nothing;

insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status)
values ('auth-session-a', 'auth-location-a', 'auth-table-a01', 'A01', 'Beach', 'OPEN')
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
  total_vnd
)
values (
  'auth-order-a',
  'auth-location-a',
  'AUTH-0001',
  'auth-session-a',
  'auth-table-a01',
  'TABLE_SERVICE',
  'DINE_IN',
  'CUSTOMER_QR',
  'Beach',
  'A01',
  'ACCEPTED',
  50000
)
on conflict (id) do nothing;

insert into public.payment_transactions (id, location_id, order_id, type, method, provider, amount_vnd, status)
values ('auth-pay-a', 'auth-location-a', 'auth-order-a', 'PAYMENT', 'CASH', 'MANUAL', 50000, 'SUCCEEDED')
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
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a@example.invalid', crypt('local-only-owner-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'manager-a@example.invalid', crypt('local-only-manager-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cashier-a@example.invalid', crypt('local-only-cashier-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'kitchen-a@example.invalid', crypt('local-only-kitchen-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'manager-b@example.invalid', crypt('local-only-manager-b', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'inactive-a@example.invalid', crypt('local-only-inactive-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'nostaff@example.invalid', crypt('local-only-nostaff', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'role-only@example.invalid', crypt('local-only-role-only', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'revoked-a@example.invalid', crypt('local-only-revoked-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('staff-owner-a', '10000000-0000-4000-8000-000000000001', 'Owner A', true),
  ('staff-manager-a', '10000000-0000-4000-8000-000000000002', 'Manager A', true),
  ('staff-cashier-a', '10000000-0000-4000-8000-000000000003', 'Cashier A', true),
  ('staff-kitchen-a', '10000000-0000-4000-8000-000000000004', 'Kitchen A', true),
  ('staff-manager-b', '10000000-0000-4000-8000-000000000005', 'Manager B', true),
  ('staff-inactive-a', '10000000-0000-4000-8000-000000000006', 'Inactive A', false),
  ('staff-role-only-a', '10000000-0000-4000-8000-000000000008', 'Role Only A', true),
  ('staff-revoked-a', '10000000-0000-4000-8000-000000000009', 'Revoked A', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('staff-owner-a', 'auth-location-a', true),
  ('staff-manager-a', 'auth-location-a', true),
  ('staff-cashier-a', 'auth-location-a', true),
  ('staff-kitchen-a', 'auth-location-a', true),
  ('staff-manager-b', 'auth-location-b', true),
  ('staff-inactive-a', 'auth-location-a', true),
  ('staff-revoked-a', 'auth-location-a', true)
on conflict (staff_profile_id, location_id) do nothing;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('staff-owner-a', 'auth-location-a', 'OWNER', true),
  ('staff-manager-a', 'auth-location-a', 'MANAGER', true),
  ('staff-cashier-a', 'auth-location-a', 'CASHIER', true),
  ('staff-kitchen-a', 'auth-location-a', 'KITCHEN', true),
  ('staff-manager-b', 'auth-location-b', 'MANAGER', true),
  ('staff-inactive-a', 'auth-location-a', 'CASHIER', true),
  ('staff-role-only-a', 'auth-location-a', 'CASHIER', true),
  ('staff-revoked-a', 'auth-location-a', 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do nothing;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  ('dev-cashier-a', 'auth-location-a', 'Cashier A terminal', 'CASHIER', public.hash_device_credential('ci-cashier-a-device-token-0001'), true, 'staff-owner-a'),
  ('dev-admin-a', 'auth-location-a', 'Admin A terminal', 'ADMIN', public.hash_device_credential('ci-admin-a-device-token-0001'), true, 'staff-owner-a'),
  ('dev-kitchen-a', 'auth-location-a', 'Kitchen A KDS', 'KDS_KITCHEN', public.hash_device_credential('ci-kitchen-a-device-token-0001'), true, 'staff-owner-a'),
  ('dev-cashier-b', 'auth-location-b', 'Cashier B terminal', 'CASHIER', public.hash_device_credential('ci-cashier-b-device-token-0001'), true, 'staff-manager-b'),
  ('dev-revoked-a', 'auth-location-a', 'Revoked terminal', 'CASHIER', public.hash_device_credential('ci-revoked-a-device-token-0001'), true, 'staff-owner-a')
on conflict (id) do nothing;

set local role anon;
set local request.jwt.claim.sub = '';

do $$
declare
  v_qr_count integer;
  v_menu_count integer;
  v_authz record;
begin
  select count(*) into v_qr_count
  from public.resolve_table_token('auth-token-a01-47VLmz')
  where location_id = 'auth-location-a'
    and code = 'A01';

  if v_qr_count <> 1 then
    raise exception 'expected unauthenticated exact-token QR resolver to work, got %', v_qr_count;
  end if;

  select count(*) into v_menu_count
  from public.list_public_menu_products('auth-location-a')
  where id = 'auth-tea-a';

  if v_menu_count <> 1 then
    raise exception 'expected unauthenticated public menu read to work, got %', v_menu_count;
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;

  if v_authz.ok <> false or v_authz.reason <> 'SIGN_IN_REQUIRED' then
    raise exception 'expected signed-out staff route to require login, got %/%', v_authz.ok, v_authz.reason;
  end if;
end $$;

do $$
begin
  perform public.register_workstation_device('auth-location-a', 'Anon device', 'CASHIER', 'ci-anon-device-token-0001', 'dev-anon');
  raise exception 'expected anonymous device registration to be denied';
exception
  when insufficient_privilege then null;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000007';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;

  if v_authz.ok <> false or v_authz.reason <> 'STAFF_INACTIVE' then
    raise exception 'expected auth user without staff profile denied, got %/%', v_authz.ok, v_authz.reason;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000006';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;

  if v_authz.ok <> false or v_authz.reason <> 'STAFF_INACTIVE' then
    raise exception 'expected inactive staff denied with valid JWT, got %/%', v_authz.ok, v_authz.reason;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000003';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.staff_role = 'OWNER';

do $$
declare
  v_authz record;
  v_tables integer;
  v_menu_admin boolean;
  v_staff_admin boolean;
begin
  if public.has_permission('auth-location-a', 'payments.record') <> true then
    raise exception 'expected CASHIER to record payments at assigned location';
  end if;

  select public.has_permission('auth-location-a', 'menu.manage') into v_menu_admin;
  select public.has_permission('auth-location-a', 'staff.manage') into v_staff_admin;
  if v_menu_admin or v_staff_admin then
    raise exception 'expected CASHIER to lack menu/staff admin even with spoofed custom JWT claims';
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;
  if v_authz.ok <> true then
    raise exception 'expected cashier payment route allowed, got %', v_authz.reason;
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'menu.manage', 'ADMIN', 'ci-admin-a-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'PERMISSION_DENIED' then
    raise exception 'expected ADMIN workstation plus CASHIER role not to elevate, got %/%', v_authz.ok, v_authz.reason;
  end if;

  select count(*) into v_tables
  from public.list_staff_tables('auth-location-a')
  where id = 'auth-table-a01';
  if v_tables <> 1 then
    raise exception 'expected authorized cashier location read, got %', v_tables;
  end if;

  select count(*) into v_tables
  from public.list_staff_tables('auth-location-b');
  if v_tables <> 0 then
    raise exception 'expected cashier location B read denied, got %', v_tables;
  end if;
end $$;

do $$
begin
  perform 1 from public.workstation_devices limit 1;
  raise exception 'expected direct workstation device enumeration to be blocked';
exception
  when insufficient_privilege then null;
end $$;

do $$
begin
  insert into public.orders (
    id,
    location_id,
    order_no,
    physical_table_id,
    service_mode,
    fulfillment_type,
    order_source,
    zone,
    table_code,
    status,
    total_vnd
  )
  values (
    'auth-write-denied',
    'auth-location-a',
    'AUTH-WRITE-DENIED',
    'auth-table-a01',
    'TABLE_SERVICE',
    'DINE_IN',
    'STAFF',
    'Beach',
    'A01',
    'ACCEPTED',
    1
  );
  raise exception 'expected authenticated operational write to be blocked';
exception
  when insufficient_privilege then null;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000004';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_authz record;
begin
  if public.has_permission('auth-location-a', 'kds.kitchen') <> true then
    raise exception 'expected KITCHEN role to have kitchen KDS permission';
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'PERMISSION_DENIED' then
    raise exception 'expected KITCHEN not to record payment, got %/%', v_authz.ok, v_authz.reason;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_authz record;
  v_context record;
  v_can_grant record;
  v_can_location record;
  v_count integer;
begin
  if public.has_permission('auth-location-a', 'staff.manage') <> true then
    raise exception 'expected manager A to manage staff in location A';
  end if;

  if public.has_permission('auth-location-b', 'staff.manage') <> false then
    raise exception 'expected manager A to be denied at location B';
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'staff.manage', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'DEVICE_MODE_DENIED' then
    raise exception 'expected CASHIER workstation to constrain privileged manager, got %/%', v_authz.ok, v_authz.reason;
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'kds.kitchen', 'KDS_KITCHEN', 'ci-kitchen-a-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'PERMISSION_DENIED' then
    raise exception 'expected KDS workstation not to elevate MANAGER into KITCHEN, got %/%', v_authz.ok, v_authz.reason;
  end if;

  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'wrong-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'DEVICE_UNREGISTERED' then
    raise exception 'expected invalid device credential denied, got %/%', v_authz.ok, v_authz.reason;
  end if;

  select * into v_context
  from public.prepare_audit_context(
    'auth-location-a',
    'ci-admin-a-device-token-0001',
    'ADMIN',
    'STAFF_ASSIGN',
    'staff_profile',
    'staff-cashier-a',
    'DENIED',
    'staff-owner-a'
  )
  limit 1;

  if v_context.staff_profile_id <> 'staff-manager-a' or v_context.client_actor_ignored <> true then
    raise exception 'expected audit context to ignore client actor spoof, got %/%', v_context.staff_profile_id, v_context.client_actor_ignored;
  end if;

  select * into v_can_grant
  from public.can_grant_role_at_location('staff-cashier-a', 'auth-location-a', 'KITCHEN')
  limit 1;
  if v_can_grant.ok <> false
     or v_can_grant.reason <> 'PRIVILEGE_CEILING_EXCEEDED'
     or not ('kds.kitchen' = any(v_can_grant.missing_permissions)) then
    raise exception 'expected delegation ceiling to block granting KITCHEN, got %/%/%', v_can_grant.ok, v_can_grant.reason, v_can_grant.missing_permissions;
  end if;

  select * into v_can_grant
  from public.can_grant_role_at_location('staff-manager-a', 'auth-location-a', 'CASHIER')
  limit 1;
  if v_can_grant.ok <> false or v_can_grant.reason <> 'SELF_ESCALATION_BLOCKED' then
    raise exception 'expected self-escalation role grant blocked, got %/%', v_can_grant.ok, v_can_grant.reason;
  end if;

  select * into v_can_location
  from public.can_assign_staff_location('staff-cashier-a', 'auth-location-b')
  limit 1;
  if v_can_location.ok <> false or v_can_location.reason <> 'LOCATION_DENIED' then
    raise exception 'expected target-location escalation blocked, got %/%', v_can_location.ok, v_can_location.reason;
  end if;

  select * into v_can_location
  from public.can_assign_staff_location('staff-manager-a', 'auth-location-a')
  limit 1;
  if v_can_location.ok <> false or v_can_location.reason <> 'SELF_ESCALATION_BLOCKED' then
    raise exception 'expected self location assignment blocked, got %/%', v_can_location.ok, v_can_location.reason;
  end if;

  select count(*) into v_count
  from public.list_staff_payment_transactions('auth-location-a')
  where id = 'auth-pay-a';
  if v_count <> 1 then
    raise exception 'expected payment ledger read for manager A, got %', v_count;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000005';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_tables integer;
begin
  select count(*) into v_tables
  from public.list_staff_tables('auth-location-b')
  where id = 'auth-table-b01';
  if v_tables <> 1 then
    raise exception 'expected manager B location B access, got %', v_tables;
  end if;

  select count(*) into v_tables
  from public.list_staff_tables('auth-location-a');
  if v_tables <> 0 then
    raise exception 'expected same role different location to deny location A, got %', v_tables;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000008';
set local request.jwt.claim.role = 'authenticated';

do $$
begin
  if public.has_permission('auth-location-a', 'payments.record') <> false then
    raise exception 'expected role assignment alone not to create global location access';
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_registered record;
  v_revoked record;
begin
  select * into v_registered
  from public.register_workstation_device(
    'auth-location-a',
    'Temporary Admin Device',
    'ADMIN',
    'ci-owner-new-admin-device-token-0001',
    'dev-owner-new-admin'
  )
  limit 1;
  if v_registered.ok <> true or v_registered.device_id <> 'dev-owner-new-admin' then
    raise exception 'expected owner to register device, got %/%', v_registered.ok, v_registered.reason;
  end if;

  select * into v_revoked
  from public.revoke_workstation_device('auth-location-a', 'dev-revoked-a')
  limit 1;
  if v_revoked.ok <> true then
    raise exception 'expected owner to revoke device, got %', v_revoked.reason;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000009';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-revoked-a-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'DEVICE_UNREGISTERED' then
    raise exception 'expected revoked device denied without JWT refresh, got %/%', v_authz.ok, v_authz.reason;
  end if;
end $$;

reset role;

update public.staff_profiles
set active = false
where id = 'staff-revoked-a';

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000009';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access('auth-location-a', 'payments.record', 'CASHIER', 'ci-cashier-a-device-token-0001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'STAFF_INACTIVE' then
    raise exception 'expected staff deactivation immediate without JWT refresh, got %/%', v_authz.ok, v_authz.reason;
  end if;
end $$;

reset role;

rollback;
