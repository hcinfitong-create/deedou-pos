-- DD-012 authoritative Admin catalog product-core contract.

begin;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values ('dd012-admin-table', 'deedou-demo', 'D12', 'CatalogContract', 'dd012-catalog-token-Q7p4Lm', 992)
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000012',
    'authenticated', 'authenticated', 'dd012-admin@example.invalid',
    crypt('local-only-dd012-admin', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000013',
    'authenticated', 'authenticated', 'dd012-cashier@example.invalid',
    crypt('local-only-dd012-cashier', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  )
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd012-staff-admin', '40000000-0000-4000-8000-000000000012', 'DD-012 Admin', true),
  ('dd012-staff-cashier', '40000000-0000-4000-8000-000000000013', 'DD-012 Cashier', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd012-staff-admin', 'deedou-demo', true),
  ('dd012-staff-cashier', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd012-staff-admin', 'deedou-demo', 'ADMIN_MENU', true),
  ('dd012-staff-cashier', 'deedou-demo', 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values
  ('dd012-dev-admin', 'deedou-demo', 'DD-012 Admin', 'ADMIN', public.hash_device_credential('dd012-admin-device'), true, 'dd012-staff-admin'),
  ('dd012-dev-admin-wrong-mode', 'deedou-demo', 'DD-012 Admin Wrong Mode', 'CASHIER', public.hash_device_credential('dd012-admin-cashier-device'), true, 'dd012-staff-admin'),
  ('dd012-dev-cashier-admin-mode', 'deedou-demo', 'DD-012 Cashier Admin Device', 'ADMIN', public.hash_device_credential('dd012-cashier-admin-device'), true, 'dd012-staff-admin')
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000012';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000012","role":"authenticated","aal":"aal2"}';

do $$
begin
  begin
    insert into public.products (
      id, location_id, kind, category, name_vi, name_en, price_vnd, station_code, periods
    ) values (
      'dd012-raw-write', 'deedou-demo', 'DRINK', 'drink-coffee', 'Raw', 'Raw', 1000, 'BAR', array['morning']
    );
    raise exception 'authenticated direct product insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

do $$
declare
  v_result record;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_count integer;
begin
  -- Correct role but wrong workstation must fail closed.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012-latte', 'DRINK', 'drink-coffee',
    'Latte DD-012', 'DD-012 Latte', '', '', 59000, 'BAR_COFFEE',
    array['morning'], '', '', '', true,
    'dd012-create-wrong-mode', 'CASHIER', 'dd012-admin-cashier-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'expected wrong workstation create forbidden, got %/%', v_result.category, v_result.reason;
  end if;

  -- Invalid payload cannot create a product.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012-invalid-price', 'DRINK', 'drink-coffee',
    'Invalid', 'Invalid', '', '', -1, 'BAR_COFFEE',
    array['morning'], '', '', '', true,
    'dd012-invalid-price-key', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'INVALID_PRODUCT_PRICE' then
    raise exception 'expected invalid price rejection, got %/%', v_result.category, v_result.reason;
  end if;
  select count(*) into v_count from public.products where id = 'dd012-invalid-price';
  if v_count <> 0 then
    raise exception 'invalid product payload partially mutated products';
  end if;

  -- Create through authoritative command; periods are normalized/deduplicated.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'DD012-Latte', 'drink', 'DRINK-COFFEE',
    '  Latte DD-012  ', '  DD-012 Latte  ', 'Mô tả', 'Description', 59000, 'bar_coffee',
    array['evening', 'morning', 'morning'], '/images/dd012-latte.png', '#ffffff', 'cup', true,
    'dd012-create-latte', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> true or v_result.entity_id <> 'dd012-latte' then
    raise exception 'expected product create success, got %/%/%', v_result.category, v_result.reason, v_result.payload;
  end if;
  if v_result.payload->'product'->>'stationCode' <> 'BAR_COFFEE' then
    raise exception 'station code was not normalized';
  end if;
  if v_result.payload->'product'->'periods' <> '["morning", "evening"]'::jsonb then
    raise exception 'periods were not normalized: %', v_result.payload->'product'->'periods';
  end if;
  v_created_at := (v_result.payload->'product'->>'updatedAt')::timestamptz;

  -- Same idempotency key/same normalized payload replays one create.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012-latte', 'DRINK', 'drink-coffee',
    'Latte DD-012', 'DD-012 Latte', 'Mô tả', 'Description', 59000, 'BAR_COFFEE',
    array['morning', 'evening'], '/images/dd012-latte.png', '#ffffff', 'cup', true,
    'dd012-create-latte', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> true or (v_result.payload->'product'->>'updatedAt')::timestamptz <> v_created_at then
    raise exception 'same-key create replay was not stable';
  end if;
  select count(*) into v_count from public.products where id = 'dd012-latte';
  if v_count <> 1 then
    raise exception 'idempotent create produced % rows', v_count;
  end if;

  -- Reusing the key for a different payload conflicts.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012-latte', 'DRINK', 'drink-coffee',
    'Latte DD-012', 'DD-012 Latte', 'Mô tả', 'Description', 60000, 'BAR_COFFEE',
    array['morning', 'evening'], '/images/dd012-latte.png', '#ffffff', 'cup', true,
    'dd012-create-latte', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'CONFLICT' or v_result.reason <> 'IDEMPOTENCY_KEY_REUSED' then
    raise exception 'expected idempotency reuse conflict, got %/%', v_result.category, v_result.reason;
  end if;

  -- Different key cannot duplicate a product ID.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012-latte', 'DRINK', 'drink-coffee',
    'Latte duplicate', 'Latte duplicate', '', '', 59000, 'BAR_COFFEE',
    array['morning'], '', '', '', true,
    'dd012-create-latte-duplicate', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'CONFLICT' or v_result.reason <> 'PRODUCT_ID_EXISTS' then
    raise exception 'expected duplicate product conflict, got %/%', v_result.category, v_result.reason;
  end if;

  -- Admin snapshot exposes editable product fields without direct table access.
  select * into v_result
  from public.dd008d_get_admin_menu_snapshot('deedou-demo', 'ADMIN', 'dd012-admin-device')
  limit 1;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'products') product
  where product->>'id' = 'dd012-latte'
    and product->>'descVi' = 'Mô tả'
    and product->>'stationCode' = 'BAR_COFFEE'
    and product->>'imageUrl' = '/images/dd012-latte.png';
  if v_result.ok <> true or v_count <> 1 then
    raise exception 'admin snapshot missing DD-012 editable fields';
  end if;

  -- Valid optimistic update changes the token and authoritative public payload.
  perform pg_sleep(0.01);
  select * into v_result
  from public.dd012_update_product(
    'deedou-demo', 'dd012-latte', 'DRINK', 'drink-signature',
    'Latte biển', 'Seaside Latte', 'Mô tả mới', 'New description', 65000, 'BAR',
    array['afternoon', 'evening'], '/images/dd012-latte.png', '#eeeeee', 'glass',
    v_created_at, 'dd012-update-latte', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> true or v_result.payload->'product'->>'category' <> 'drink-signature' then
    raise exception 'expected update success, got %/%/%', v_result.category, v_result.reason, v_result.payload;
  end if;
  v_updated_at := (v_result.payload->'product'->>'updatedAt')::timestamptz;
  if v_updated_at <= v_created_at then
    raise exception 'update did not advance updatedAt token';
  end if;

  select * into v_result
  from public.dd008c_get_public_table_snapshot('dd012-catalog-token-Q7p4Lm')
  limit 1;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'products') product
  where product->>'id' = 'dd012-latte'
    and product->>'nameVi' = 'Latte biển'
    and (product->>'priceVnd')::integer = 65000;
  if v_result.ok <> true or v_count <> 1 then
    raise exception 'public menu did not reflect authoritative product update';
  end if;

  -- Stale optimistic token fails without overwrite.
  select * into v_result
  from public.dd012_update_product(
    'deedou-demo', 'dd012-latte', 'DRINK', 'drink-coffee',
    'Stale name', 'Stale name', '', '', 1000, 'BAR', array['morning'], '', '', '',
    v_created_at, 'dd012-update-stale', 'ADMIN', 'dd012-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'CONFLICT' or v_result.reason <> 'STALE_PRODUCT' then
    raise exception 'expected stale product conflict, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000013';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000013","role":"authenticated","aal":"aal2"}';

do $$
declare
  v_result record;
begin
  -- ADMIN workstation mode alone cannot grant CASHIER menu.manage.
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012-cashier-denied', 'FOOD', 'food-single',
    'Denied', 'Denied', '', '', 1000, 'KITCHEN_HOT', array['morning'], '', '', '', true,
    'dd012-cashier-denied', 'ADMIN', 'dd012-cashier-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'expected CASHIER create forbidden, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
begin
  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_create_product'
      and target_type = 'product'
      and target_id = 'dd012-latte'
      and staff_id = 'dd012-staff-admin'
      and device_id = 'dd012-dev-admin'
      and outcome = 'OK'
  ) then
    raise exception 'DD-012 create audit missing';
  end if;
  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_update_product'
      and target_type = 'product'
      and target_id = 'dd012-latte'
      and staff_id = 'dd012-staff-admin'
      and device_id = 'dd012-dev-admin'
      and outcome = 'OK'
  ) then
    raise exception 'DD-012 update audit missing';
  end if;
end $$;

rollback;
