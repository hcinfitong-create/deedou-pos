-- DD-012C authoritative combo component + historical snapshot contract.

begin;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values ('dd012c-table', 'deedou-demo', 'D12C', 'CatalogComponents', 'dd012c-catalog-token-R7m4Kx', 994)
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000016',
    'authenticated', 'authenticated', 'dd012c-admin@example.invalid',
    crypt('local-only-dd012c-admin', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000017',
    'authenticated', 'authenticated', 'dd012c-cashier@example.invalid',
    crypt('local-only-dd012c-cashier', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  )
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd012c-staff-admin', '40000000-0000-4000-8000-000000000016', 'DD-012C Admin', true),
  ('dd012c-staff-cashier', '40000000-0000-4000-8000-000000000017', 'DD-012C Cashier', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd012c-staff-admin', 'deedou-demo', true),
  ('dd012c-staff-cashier', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd012c-staff-admin', 'deedou-demo', 'ADMIN_MENU', true),
  ('dd012c-staff-cashier', 'deedou-demo', 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values
  ('dd012c-dev-admin', 'deedou-demo', 'DD-012C Admin', 'ADMIN', public.hash_device_credential('dd012c-admin-device'), true, 'dd012c-staff-admin'),
  ('dd012c-dev-cashier', 'deedou-demo', 'DD-012C Cashier Admin-mode', 'ADMIN', public.hash_device_credential('dd012c-cashier-device'), true, 'dd012c-staff-admin')
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000016';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000016","role":"authenticated","aal":"aal2"}';

do $$
begin
  begin
    insert into public.product_components (
      id, parent_product_id, component_key, name_vi, name_en, qty, station_code, display_order
    ) values (
      'dd012c-raw-component', 'coffee-black', 'raw', 'Raw', 'Raw', 1, 'BAR', 0
    );
    raise exception 'authenticated direct product_components insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

do $$
declare
  v_result record;
  v_component_updated_at timestamptz;
  v_stale_updated_at timestamptz;
  v_order_1 text;
  v_order_2 text;
  v_item jsonb;
  v_count integer;
begin
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012c-breakfast-combo', 'FOOD', 'food-combo',
    'Combo sáng DD-012C', 'DD-012C Breakfast Combo', '', '', 75000, 'KITCHEN_HOT',
    array['morning','afternoon','evening'], '', '', '', true,
    'dd012c-create-product', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'combo product setup failed: %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd012_create_product_component(
    'deedou-demo', 'dd012c-breakfast-combo', 'dd012c-component-main', 'main_plate',
    'Phần chính', 'Main plate', 0, 'KITCHEN_HOT', 1,
    'dd012c-invalid-qty', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'INVALID_PRODUCT_COMPONENT' then
    raise exception 'expected invalid qty rejection, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd012_create_product_component(
    'deedou-demo', 'dd012c-breakfast-combo', 'dd012c-component-main', 'main_plate',
    'Phần chính', 'Main plate', 2, 'KITCHEN_HOT', 1,
    'dd012c-create-main', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'component create failed: %/%', v_result.category, v_result.reason;
  end if;
  v_component_updated_at := (v_result.payload->'component'->>'updatedAt')::timestamptz;
  v_stale_updated_at := v_component_updated_at;

  -- Same key/payload replays; changed payload conflicts.
  select * into v_result
  from public.dd012_create_product_component(
    'deedou-demo', 'dd012c-breakfast-combo', 'dd012c-component-main', 'main_plate',
    'Phần chính', 'Main plate', 2, 'KITCHEN_HOT', 1,
    'dd012c-create-main', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'component replay failed'; end if;

  select * into v_result
  from public.dd012_create_product_component(
    'deedou-demo', 'dd012c-breakfast-combo', 'dd012c-component-main', 'main_plate',
    'Phần chính', 'Main plate', 3, 'KITCHEN_HOT', 1,
    'dd012c-create-main', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'IDEMPOTENCY_KEY_REUSED' then
    raise exception 'expected component idempotency conflict, got %/%', v_result.category, v_result.reason;
  end if;

  -- Admin snapshot exposes complete editable component fields.
  select * into v_result
  from public.dd008d_get_admin_menu_snapshot('deedou-demo', 'ADMIN', 'dd012c-admin-device')
  limit 1;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'components') component
  where component->>'id' = 'dd012c-component-main'
    and component->>'parentProductId' = 'dd012c-breakfast-combo'
    and component->>'componentKey' = 'main_plate'
    and (component->>'qty')::integer = 2
    and component->>'stationCode' = 'KITCHEN_HOT'
    and component->>'updatedAt' <> '';
  if v_result.ok <> true or v_count <> 1 then
    raise exception 'admin snapshot component missing';
  end if;

  -- Public QR payload already exposes safe component labels/quantity, not station routing.
  select * into v_result
  from public.dd008c_get_public_table_snapshot('dd012c-catalog-token-R7m4Kx')
  limit 1;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'products') product,
       jsonb_array_elements(product->'components') component
  where product->>'id' = 'dd012c-breakfast-combo'
    and component->>'key' = 'main_plate'
    and component->>'vi' = 'Phần chính'
    and (component->>'qty')::integer = 2;
  if v_result.ok <> true or v_count <> 1 then
    raise exception 'public combo component projection missing';
  end if;

  -- First order snapshots current component routing and quantity.
  select * into v_result
  from public.submit_qr_order(
    'dd012c-catalog-token-R7m4Kx',
    '[{"productId":"dd012c-breakfast-combo","qty":2}]'::jsonb,
    '', 'dd012c-public-order-1'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'first combo QR order failed: %/%', v_result.category, v_result.reason;
  end if;
  v_order_1 := v_result.entity_id;
  select item into v_item
  from jsonb_array_elements(v_result.payload->'order'->'items') item
  where coalesce((item->>'isComponent')::boolean, false) = true
  limit 1;
  if v_item is null
     or v_item->>'nameEn' <> 'Main plate'
     or (v_item->>'qty')::integer <> 4
     or v_item->>'station' <> 'KITCHEN_HOT'
     or (v_item->>'price')::integer <> 0
     or coalesce((v_item->>'isBillable')::boolean, true) <> false then
    raise exception 'first combo component snapshot invalid: %', v_item;
  end if;

  -- Live component edit advances concurrency token for future orders only.
  perform pg_sleep(0.01);
  select * into v_result
  from public.dd012_update_product_component(
    'deedou-demo', 'dd012c-component-main', 'main_plate',
    'Phần chính mới', 'Updated main plate', 3, 'KITCHEN_FINISH', 1,
    v_component_updated_at, 'dd012c-update-main', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'component update failed: %/%', v_result.category, v_result.reason;
  end if;
  v_component_updated_at := (v_result.payload->'component'->>'updatedAt')::timestamptz;
  if v_component_updated_at <= v_stale_updated_at then
    raise exception 'component update did not advance updatedAt';
  end if;

  select * into v_result
  from public.dd012_update_product_component(
    'deedou-demo', 'dd012c-component-main', 'main_plate',
    'Stale', 'Stale', 1, 'BAR', 1,
    v_stale_updated_at, 'dd012c-update-stale', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'STALE_PRODUCT_COMPONENT' then
    raise exception 'expected stale component conflict, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.submit_qr_order(
    'dd012c-catalog-token-R7m4Kx',
    '[{"productId":"dd012c-breakfast-combo","qty":1}]'::jsonb,
    '', 'dd012c-public-order-2'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'second combo QR order failed: %/%', v_result.category, v_result.reason;
  end if;
  v_order_2 := v_result.entity_id;
  select item into v_item
  from jsonb_array_elements(v_result.payload->'order'->'items') item
  where coalesce((item->>'isComponent')::boolean, false) = true
  limit 1;
  if v_item is null
     or v_item->>'nameEn' <> 'Updated main plate'
     or (v_item->>'qty')::integer <> 3
     or v_item->>'station' <> 'KITCHEN_FINISH' then
    raise exception 'second combo component snapshot invalid: %', v_item;
  end if;

  -- Delete uses optimistic token; future orders become non-combo if no components remain.
  select * into v_result
  from public.dd012_delete_product_component(
    'deedou-demo', 'dd012c-component-main', v_component_updated_at,
    'dd012c-delete-main', 'ADMIN', 'dd012c-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'component delete failed: %/%', v_result.category, v_result.reason;
  end if;

  -- Keep IDs available for privileged historical persistence checks after RESET ROLE.
  perform set_config('dd012c.order1', v_order_1, true);
  perform set_config('dd012c.order2', v_order_2, true);
end $$;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000017';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000017","role":"authenticated","aal":"aal2"}';

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.dd012_create_product_component(
    'deedou-demo', 'dd012c-breakfast-combo', 'dd012c-cashier-denied', 'cashier_denied',
    'Denied', 'Denied', 1, 'KITCHEN', 1,
    'dd012c-cashier-denied', 'ADMIN', 'dd012c-cashier-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'expected CASHIER component create forbidden, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare
  v_order_1 text := current_setting('dd012c.order1', true);
  v_order_2 text := current_setting('dd012c.order2', true);
  v_count integer;
begin
  if exists (select 1 from public.product_components where id = 'dd012c-component-main') then
    raise exception 'component delete did not persist within contract transaction';
  end if;
  if exists (select 1 from public.product_components where id = 'dd012c-raw-component') then
    raise exception 'direct-write denial left a partial row';
  end if;

  select count(*) into v_count
  from public.order_lines
  where order_id = v_order_1
    and is_component = true
    and name_en = 'Main plate'
    and qty = 4
    and station_code = 'KITCHEN_HOT'
    and price_vnd = 0
    and is_billable = false;
  if v_count <> 1 then
    raise exception 'first historical component snapshot changed after catalog edit/delete';
  end if;

  select count(*) into v_count
  from public.order_lines
  where order_id = v_order_2
    and is_component = true
    and name_en = 'Updated main plate'
    and qty = 3
    and station_code = 'KITCHEN_FINISH';
  if v_count <> 1 then
    raise exception 'second order did not snapshot live component edit';
  end if;

  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_create_product_component'
      and target_id = 'dd012c-component-main'
      and staff_id = 'dd012c-staff-admin'
      and device_id = 'dd012c-dev-admin'
      and outcome = 'OK'
  ) then
    raise exception 'component create audit missing';
  end if;
  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_update_product_component'
      and target_id = 'dd012c-component-main'
      and outcome = 'OK'
  ) then
    raise exception 'component update audit missing';
  end if;
  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_delete_product_component'
      and target_id = 'dd012c-component-main'
      and outcome = 'OK'
  ) then
    raise exception 'component delete audit missing';
  end if;
end $$;

rollback;
