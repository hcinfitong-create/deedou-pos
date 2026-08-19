-- DD-008D server-authoritative admin menu availability contract.

begin;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values ('dd008d-admin-table', 'deedou-demo', 'ADM1', 'AdminContract', 'dd008d-admin-token-J8vR4c', 991)
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values (
  '00000000-0000-0000-0000-000000000000',
  '30000000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'dd008d-admin@example.invalid',
  crypt('local-only-dd008d-admin', gen_salt('bf')), now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values ('dd008d-staff-admin', '30000000-0000-4000-8000-000000000002', 'DD-008D Admin', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values ('dd008d-staff-admin', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values ('dd008d-staff-admin', 'deedou-demo', 'ADMIN_MENU', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values
  ('dd008d-dev-admin-menu', 'deedou-demo', 'DD-008D Admin Menu', 'ADMIN', public.hash_device_credential('dd008d-admin-menu-device'), true, 'dd008d-staff-admin'),
  ('dd008d-dev-admin-wrong-mode', 'deedou-demo', 'DD-008D Wrong Mode', 'CASHIER', public.hash_device_credential('dd008d-admin-cashier-device'), true, 'dd008d-staff-admin')
on conflict (id) do nothing;

-- Fixture setup must run as the test/database owner. The authenticated role is
-- deliberately denied raw product writes and may mutate availability only via RPC.
update public.products
set available = true,
    updated_at = '2026-08-16T00:00:00Z'::timestamptz
where location_id = 'deedou-demo' and id = 'fried-rice';

update public.products
set available = false
where location_id = 'deedou-demo' and id = 'espresso';

set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_updated_at timestamptz;
  v_after_disable timestamptz;
  v_count integer;
begin
  -- Correct role with wrong workstation mode/device must fail closed.
  select * into v_result
  from public.dd008d_get_admin_menu_snapshot('deedou-demo', 'CASHIER', 'dd008d-admin-cashier-device')
  limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'expected wrong-mode admin menu read forbidden, got %/%', v_result.category, v_result.reason;
  end if;

  -- ADMIN snapshot includes both available and unavailable products without raw-table access.
  select * into v_result
  from public.dd008d_get_admin_menu_snapshot('deedou-demo', 'ADMIN', 'dd008d-admin-menu-device')
  limit 1;
  if v_result.ok <> true then
    raise exception 'expected admin menu snapshot, got %/%', v_result.category, v_result.reason;
  end if;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'products') product
  where product->>'id' = 'espresso' and (product->>'available')::boolean = false;
  if v_count <> 1 then
    raise exception 'admin menu must include unavailable products';
  end if;

  select updated_at into v_updated_at
  from public.products where location_id = 'deedou-demo' and id = 'fried-rice';

  -- Disable via authoritative command.
  select * into v_result
  from public.dd008d_set_product_availability(
    'deedou-demo', 'fried-rice', false, v_updated_at,
    'dd008d-admin-disable-fried-rice', 'ADMIN', 'dd008d-admin-menu-device'
  ) limit 1;
  if v_result.ok <> true or (v_result.payload->'product'->>'available')::boolean <> false then
    raise exception 'expected fried-rice disabled, got %/%/%', v_result.category, v_result.reason, v_result.payload;
  end if;
  select updated_at into v_after_disable
  from public.products where location_id = 'deedou-demo' and id = 'fried-rice';
  if v_after_disable = v_updated_at then
    raise exception 'availability mutation must bump updated_at';
  end if;

  -- Same idempotency key/same payload is a replay, not another mutation.
  select * into v_result
  from public.dd008d_set_product_availability(
    'deedou-demo', 'fried-rice', false, v_updated_at,
    'dd008d-admin-disable-fried-rice', 'ADMIN', 'dd008d-admin-menu-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'expected idempotency replay accepted, got %/%', v_result.category, v_result.reason;
  end if;
  if (select updated_at from public.products where id = 'fried-rice') <> v_after_disable then
    raise exception 'idempotency replay mutated product again';
  end if;

  -- Public QR menu reflects authoritative unavailable state.
  select * into v_result
  from public.dd008c_get_public_table_snapshot('dd008d-admin-token-J8vR4c')
  limit 1;
  if v_result.ok <> true then
    raise exception 'public snapshot failed after admin mutation';
  end if;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'products') product
  where product->>'id' = 'fried-rice';
  if v_count <> 0 then
    raise exception 'public menu still exposes authoritative unavailable product';
  end if;

  -- Stale optimistic token cannot re-enable after another update.
  select * into v_result
  from public.dd008d_set_product_availability(
    'deedou-demo', 'fried-rice', true, v_updated_at,
    'dd008d-admin-stale-enable', 'ADMIN', 'dd008d-admin-menu-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'CONFLICT' or v_result.reason <> 'STALE_PRODUCT' then
    raise exception 'expected STALE_PRODUCT conflict, got %/%', v_result.category, v_result.reason;
  end if;

  -- Current optimistic token can re-enable.
  select * into v_result
  from public.dd008d_set_product_availability(
    'deedou-demo', 'fried-rice', true, v_after_disable,
    'dd008d-admin-enable-fried-rice', 'ADMIN', 'dd008d-admin-menu-device'
  ) limit 1;
  if v_result.ok <> true or (v_result.payload->'product'->>'available')::boolean <> true then
    raise exception 'expected fried-rice re-enabled, got %/%/%', v_result.category, v_result.reason, v_result.payload;
  end if;

  select * into v_result
  from public.dd008c_get_public_table_snapshot('dd008d-admin-token-J8vR4c')
  limit 1;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'products') product
  where product->>'id' = 'fried-rice';
  if v_count <> 1 then
    raise exception 'public menu did not reflect re-enabled product';
  end if;
end $$;

reset role;

do $$
begin
  if not exists (
    select 1 from public.audit_events
    where command = 'dd008d_set_product_availability'
      and target_type = 'product'
      and target_id = 'fried-rice'
      and staff_id = 'dd008d-staff-admin'
      and device_id = 'dd008d-dev-admin-menu'
      and metadata->>'available' = 'false'
  ) then
    raise exception 'authoritative availability audit missing';
  end if;
end $$;

rollback;
