-- DD-008D least-privilege admin realtime contract.
-- Proves ADMIN_MENU + ADMIN device may receive menu refresh hints without orders.read,
-- while CASHIER roles/devices cannot subscribe to the admin audience.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '30000000-0000-4000-8000-000000000010',
    'authenticated', 'authenticated', 'dd008d-admin-realtime@example.invalid',
    crypt('local-only-dd008d-admin-realtime', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '30000000-0000-4000-8000-000000000011',
    'authenticated', 'authenticated', 'dd008d-cashier-realtime@example.invalid',
    crypt('local-only-dd008d-cashier-realtime', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  )
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd008d-staff-admin-realtime', '30000000-0000-4000-8000-000000000010', 'DD-008D Admin Realtime', true),
  ('dd008d-staff-cashier-realtime', '30000000-0000-4000-8000-000000000011', 'DD-008D Cashier Realtime', true)
on conflict (id) do update set active = true;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd008d-staff-admin-realtime', 'deedou-demo', true),
  ('dd008d-staff-cashier-realtime', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = true;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd008d-staff-admin-realtime', 'deedou-demo', 'ADMIN_MENU', true),
  ('dd008d-staff-cashier-realtime', 'deedou-demo', 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = true;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values
  (
    'dd008d-dev-admin-realtime', 'deedou-demo', 'DD-008D Admin Realtime', 'ADMIN',
    public.hash_device_credential('dd008d-admin-realtime-device'), true, 'dd008d-staff-admin-realtime'
  ),
  (
    'dd008d-dev-admin-wrong-mode', 'deedou-demo', 'DD-008D Admin Wrong Mode', 'CASHIER',
    public.hash_device_credential('dd008d-admin-wrong-mode-device'), true, 'dd008d-staff-admin-realtime'
  ),
  (
    'dd008d-dev-cashier-realtime', 'deedou-demo', 'DD-008D Cashier Realtime', 'CASHIER',
    public.hash_device_credential('dd008d-cashier-realtime-device'), true, 'dd008d-staff-cashier-realtime'
  )
on conflict (id) do update
set active = true,
    mode = excluded.mode,
    credential_hash = excluded.credential_hash;

-- ADMIN_MENU has menu.manage but should not gain order visibility for connection health.
do $$
declare
  v_menu_manage boolean;
  v_orders_read boolean;
begin
  select exists (
    select 1
    from public.staff_role_assignments sra
    join public.role_permissions rp on rp.role_id = sra.role_id
    join public.permissions p on p.id = rp.permission_id
    where sra.staff_profile_id = 'dd008d-staff-admin-realtime'
      and sra.location_id = 'deedou-demo'
      and sra.active = true
      and p.permission_key = 'menu.manage'
  ) into v_menu_manage;

  select exists (
    select 1
    from public.staff_role_assignments sra
    join public.role_permissions rp on rp.role_id = sra.role_id
    join public.permissions p on p.id = rp.permission_id
    where sra.staff_profile_id = 'dd008d-staff-admin-realtime'
      and sra.location_id = 'deedou-demo'
      and sra.active = true
      and p.permission_key = 'orders.read'
  ) into v_orders_read;

  if v_menu_manage is distinct from true then
    raise exception 'ADMIN_MENU fixture missing menu.manage';
  end if;
  if v_orders_read is true then
    raise exception 'ADMIN_MENU must not gain orders.read for admin realtime';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-4000-8000-000000000010';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_ticket_id text;
  v_topic text;
  v_allowed boolean;
begin
  select * into v_result
  from public.dd008c_issue_realtime_ticket(
    'deedou-demo', 'admin', 'ADMIN', 'dd008d-admin-realtime-device'
  ) limit 1;

  if v_result.ok <> true then
    raise exception 'expected ADMIN_MENU admin realtime ticket, got %/%', v_result.category, v_result.reason;
  end if;
  v_ticket_id := v_result.entity_id;
  v_topic := v_result.payload->>'topic';
  if v_topic not like 'location:deedou-demo:admin:%' then
    raise exception 'unexpected admin realtime topic: %', v_topic;
  end if;

  select public.dd008c_refresh_audience_allowed('deedou-demo', 'admin', v_ticket_id)
  into v_allowed;
  if v_allowed is distinct from true then
    raise exception 'valid admin realtime ticket rejected by audience helper';
  end if;

  -- The same staff identity cannot subscribe to ops because ADMIN_MENU has no orders.read.
  select * into v_result
  from public.dd008c_issue_realtime_ticket(
    'deedou-demo', 'ops', 'ADMIN', 'dd008d-admin-realtime-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'ADMIN_MENU unexpectedly received ops ticket: %/%', v_result.category, v_result.reason;
  end if;

  -- Correct ADMIN_MENU role with a CASHIER device cannot use menu.manage-scoped admin realtime.
  select * into v_result
  from public.dd008c_issue_realtime_ticket(
    'deedou-demo', 'admin', 'CASHIER', 'dd008d-admin-wrong-mode-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'wrong workstation mode unexpectedly received admin ticket: %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-4000-8000-000000000011';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.dd008c_issue_realtime_ticket(
    'deedou-demo', 'admin', 'CASHIER', 'dd008d-cashier-realtime-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'CASHIER role unexpectedly received admin realtime ticket: %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

-- Product availability changes must produce an admin-scoped refresh hint for active tickets.
do $$
declare
  v_before integer;
  v_after integer;
begin
  select count(*) into v_before
  from public.dd008c_refresh_hints
  where location_id = 'deedou-demo'
    and audience = 'admin'
    and entity_type = 'product'
    and entity_id = 'fried-rice';

  update public.products
  set available = not available
  where location_id = 'deedou-demo' and id = 'fried-rice';

  select count(*) into v_after
  from public.dd008c_refresh_hints
  where location_id = 'deedou-demo'
    and audience = 'admin'
    and entity_type = 'product'
    and entity_id = 'fried-rice'
    and payload->>'reason' = 'PRODUCT_AVAILABILITY_CHANGED';

  if v_after <= v_before then
    raise exception 'product availability trigger did not emit admin refresh hint';
  end if;
end $$;

rollback;
