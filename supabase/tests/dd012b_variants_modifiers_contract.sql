-- DD-012B authoritative variants/modifiers + configured-order compatibility contract.

begin;

insert into public.physical_tables (id, location_id, code, zone, qr_token, display_order)
values ('dd012b-table', 'deedou-demo', 'D12B', 'CatalogOptions', 'dd012b-catalog-token-Q8m5Nz', 993)
on conflict (id) do nothing;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000014',
    'authenticated', 'authenticated', 'dd012b-admin@example.invalid',
    crypt('local-only-dd012b-admin', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '40000000-0000-4000-8000-000000000015',
    'authenticated', 'authenticated', 'dd012b-cashier@example.invalid',
    crypt('local-only-dd012b-cashier', gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
  )
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd012b-staff-admin', '40000000-0000-4000-8000-000000000014', 'DD-012B Admin', true),
  ('dd012b-staff-cashier', '40000000-0000-4000-8000-000000000015', 'DD-012B Cashier', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd012b-staff-admin', 'deedou-demo', true),
  ('dd012b-staff-cashier', 'deedou-demo', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd012b-staff-admin', 'deedou-demo', 'ADMIN_MENU', true),
  ('dd012b-staff-cashier', 'deedou-demo', 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values
  ('dd012b-dev-admin', 'deedou-demo', 'DD-012B Admin', 'ADMIN', public.hash_device_credential('dd012b-admin-device'), true, 'dd012b-staff-admin'),
  ('dd012b-dev-cashier', 'deedou-demo', 'DD-012B Cashier Admin-mode', 'ADMIN', public.hash_device_credential('dd012b-cashier-device'), true, 'dd012b-staff-admin')
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000014';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000014","role":"authenticated","aal":"aal2"}';

do $$
begin
  begin
    insert into public.product_variants (id, product_id, variant_key, name_vi, name_en)
    values ('dd012b-raw-variant', 'coffee-black', 'raw', 'Raw', 'Raw');
    raise exception 'authenticated direct variant insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.modifier_groups (
      id, location_id, group_key, name_vi, name_en, required, multiple, min_select, max_select
    ) values ('dd012b-raw-group', 'deedou-demo', 'raw', 'Raw', 'Raw', false, false, 0, 1);
    raise exception 'authenticated direct modifier group insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

do $$
declare
  v_result record;
  v_variant_updated_at timestamptz;
  v_group_updated_at timestamptz;
  v_option_less_updated_at timestamptz;
  v_option_normal_updated_at timestamptz;
  v_assignment_updated_at timestamptz;
  v_order_id text;
  v_order_price integer;
  v_snapshot jsonb;
  v_count integer;
begin
  select * into v_result
  from public.dd012_create_product(
    'deedou-demo', 'dd012b-tea', 'DRINK', 'drink-tea',
    'Trà DD-012B', 'DD-012B Tea', '', '', 40000, 'BAR_TEA',
    array['morning', 'afternoon', 'evening'], '', '', '', true,
    'dd012b-create-product', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'product setup failed: %/%', v_result.category, v_result.reason;
  end if;

  -- First variant cannot make a variant-configured product unsatisfiable.
  select * into v_result
  from public.dd012_create_variant(
    'deedou-demo', 'dd012b-tea', 'dd012b-tea-large', 'large',
    'Lớn', 'Large', 10000, false, 1,
    'dd012b-first-variant-unavailable', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'VARIANT_SET_UNSATISFIABLE' then
    raise exception 'expected unavailable first variant rejection, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd012_create_variant(
    'deedou-demo', 'dd012b-tea', 'dd012b-tea-large', 'large',
    'Lớn', 'Large', 10000, true, 1,
    'dd012b-create-large', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'available variant create failed: %/%', v_result.category, v_result.reason;
  end if;
  v_variant_updated_at := (v_result.payload->'variant'->>'updatedAt')::timestamptz;

  -- Same command/key is one result; changed payload conflicts through the shared command ledger.
  select * into v_result
  from public.dd012_create_variant(
    'deedou-demo', 'dd012b-tea', 'dd012b-tea-large', 'large',
    'Lớn', 'Large', 10000, true, 1,
    'dd012b-create-large', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'variant replay failed';
  end if;
  select * into v_result
  from public.dd012_create_variant(
    'deedou-demo', 'dd012b-tea', 'dd012b-tea-large', 'large',
    'Lớn', 'Large', 12000, true, 1,
    'dd012b-create-large', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'IDEMPOTENCY_KEY_REUSED' then
    raise exception 'expected variant idempotency conflict, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd012_create_modifier_group(
    'deedou-demo', 'dd012b-sugar', 'sugar', 'Đường', 'Sugar',
    true, true, 1, 2, 1,
    'dd012b-create-sugar', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'modifier group create failed: %/%', v_result.category, v_result.reason;
  end if;
  v_group_updated_at := (v_result.payload->'modifierGroup'->>'updatedAt')::timestamptz;

  -- Group with max=2 is not assignable before two options exist.
  select * into v_result
  from public.dd012_set_product_modifier_group_assignment(
    'deedou-demo', 'dd012b-tea', 'dd012b-sugar', true, 1, null,
    'dd012b-assign-too-early', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'MODIFIER_GROUP_UNSATISFIABLE' then
    raise exception 'expected unsatisfiable assignment rejection, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd012_create_modifier_option(
    'deedou-demo', 'dd012b-sugar', 'dd012b-sugar-less', 'less',
    'Ít đường', 'Less sugar', 0, true, 1,
    'dd012b-create-less', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'less option create failed'; end if;
  v_option_less_updated_at := (v_result.payload->'modifierOption'->>'updatedAt')::timestamptz;

  select * into v_result
  from public.dd012_create_modifier_option(
    'deedou-demo', 'dd012b-sugar', 'dd012b-sugar-normal', 'normal',
    'Bình thường', 'Normal sugar', 3000, true, 2,
    'dd012b-create-normal', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'normal option create failed'; end if;
  v_option_normal_updated_at := (v_result.payload->'modifierOption'->>'updatedAt')::timestamptz;

  select * into v_result
  from public.dd012_set_product_modifier_group_assignment(
    'deedou-demo', 'dd012b-tea', 'dd012b-sugar', true, 1, null,
    'dd012b-assign-sugar', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'modifier assignment failed: %/%', v_result.category, v_result.reason;
  end if;
  v_assignment_updated_at := (v_result.payload->'assignment'->>'updatedAt')::timestamptz;

  -- Admin snapshot carries the complete editable graph and optimistic tokens.
  select * into v_result
  from public.dd008d_get_admin_menu_snapshot('deedou-demo', 'ADMIN', 'dd012b-admin-device')
  limit 1;
  if v_result.ok <> true then raise exception 'admin snapshot failed'; end if;
  select count(*) into v_count from jsonb_array_elements(v_result.payload->'variants') item
  where item->>'id' = 'dd012b-tea-large' and item->>'updatedAt' <> '';
  if v_count <> 1 then raise exception 'admin snapshot variant missing'; end if;
  select count(*) into v_count from jsonb_array_elements(v_result.payload->'modifierGroups') item
  where item->>'id' = 'dd012b-sugar' and (item->>'minSelect')::integer = 1;
  if v_count <> 1 then raise exception 'admin snapshot modifier group missing'; end if;
  select count(*) into v_count from jsonb_array_elements(v_result.payload->'modifierOptions') item
  where item->>'id' = 'dd012b-sugar-normal' and (item->>'priceDeltaVnd')::integer = 3000;
  if v_count <> 1 then raise exception 'admin snapshot modifier option missing'; end if;
  select count(*) into v_count from jsonb_array_elements(v_result.payload->'productModifierGroups') item
  where item->>'productId' = 'dd012b-tea' and item->>'modifierGroupId' = 'dd012b-sugar';
  if v_count <> 1 then raise exception 'admin snapshot assignment missing'; end if;

  -- Public projections expose only active configured-order choices.
  select count(*) into v_count
  from public.list_public_menu_product_variants('deedou-demo')
  where product_id = 'dd012b-tea' and variant_key = 'large' and price_delta_vnd = 10000;
  if v_count <> 1 then raise exception 'public variant projection missing'; end if;
  select count(*) into v_count
  from public.list_public_menu_modifier_groups('deedou-demo')
  where product_id = 'dd012b-tea' and group_key = 'sugar' and min_select = 1 and max_select = 2;
  if v_count <> 1 then raise exception 'public modifier group projection missing'; end if;
  select count(*) into v_count
  from public.list_public_menu_modifier_options('deedou-demo')
  where modifier_group_id = 'dd012b-sugar' and option_key = 'normal' and price_delta_vnd = 3000;
  if v_count <> 1 then raise exception 'public modifier option projection missing'; end if;

  -- Real public QR configured order uses live authority for variant/modifier pricing.
  select * into v_result
  from public.submit_qr_order(
    'dd012b-catalog-token-Q8m5Nz',
    '[{"productId":"dd012b-tea","qty":1,"selection":{"variantId":"large","modifierSelections":{"sugar":["normal"]}}}]'::jsonb,
    '', 'dd012b-public-order-1'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'configured QR order failed: %/%/%', v_result.category, v_result.reason, v_result.payload;
  end if;
  v_order_id := v_result.entity_id;
  select price_vnd, option_snapshot into v_order_price, v_snapshot
  from public.order_lines
  where order_id = v_order_id and is_component = false
  limit 1;
  if v_order_price <> 53000 then
    raise exception 'configured price expected 53000, got %', v_order_price;
  end if;
  if v_snapshot->'variant'->>'en' <> 'Large'
     or v_snapshot->'modifierGroups'->0->'options'->0->>'en' <> 'Normal sugar' then
    raise exception 'configured option snapshot missing: %', v_snapshot;
  end if;

  -- Live edits advance tokens but must not rewrite the submitted order snapshot or price.
  perform pg_sleep(0.01);
  select * into v_result
  from public.dd012_update_variant(
    'deedou-demo', 'dd012b-tea-large', 'large', 'Đại', 'Extra Large', 15000, true, 1,
    v_variant_updated_at, 'dd012b-update-large', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'variant update failed: %/%', v_result.category, v_result.reason; end if;
  v_variant_updated_at := (v_result.payload->'variant'->>'updatedAt')::timestamptz;

  perform pg_sleep(0.01);
  select * into v_result
  from public.dd012_update_modifier_option(
    'deedou-demo', 'dd012b-sugar-normal', 'normal', 'Chuẩn', 'Standard sugar', 5000, true, 2,
    v_option_normal_updated_at, 'dd012b-update-normal', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'option update failed: %/%', v_result.category, v_result.reason; end if;
  v_option_normal_updated_at := (v_result.payload->'modifierOption'->>'updatedAt')::timestamptz;

  if (select price_vnd from public.order_lines where order_id = v_order_id and is_component = false limit 1) <> v_order_price then
    raise exception 'historical configured price was rewritten';
  end if;
  if (select option_snapshot from public.order_lines where order_id = v_order_id and is_component = false limit 1) <> v_snapshot then
    raise exception 'historical option snapshot was rewritten';
  end if;

  -- The only available variant cannot be disabled while variant rows exist.
  select * into v_result
  from public.dd012_update_variant(
    'deedou-demo', 'dd012b-tea-large', 'large', 'Đại', 'Extra Large', 15000, false, 1,
    v_variant_updated_at, 'dd012b-disable-last-variant', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'VARIANT_SET_UNSATISFIABLE' then
    raise exception 'expected last variant protection, got %/%', v_result.category, v_result.reason;
  end if;

  -- Assigned group cannot lose options below configured max/min bounds.
  select * into v_result
  from public.dd012_delete_modifier_option(
    'deedou-demo', 'dd012b-sugar-less', v_option_less_updated_at,
    'dd012b-delete-less-blocked', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'MODIFIER_GROUP_UNSATISFIABLE' then
    raise exception 'expected assigned group delete protection, got %/%', v_result.category, v_result.reason;
  end if;

  -- Assigned groups cannot be cascade-deleted; detach explicitly first.
  select * into v_result
  from public.dd012_delete_modifier_group(
    'deedou-demo', 'dd012b-sugar', v_group_updated_at,
    'dd012b-delete-assigned-group', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'MODIFIER_GROUP_ASSIGNED' then
    raise exception 'expected assigned group delete conflict, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd012_set_product_modifier_group_assignment(
    'deedou-demo', 'dd012b-tea', 'dd012b-sugar', false, 1, v_assignment_updated_at,
    'dd012b-unassign-sugar', 'ADMIN', 'dd012b-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'modifier group unassign failed'; end if;
end $$;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000015';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000015","role":"authenticated","aal":"aal2"}';

do $$
declare
  v_result record;
begin
  select * into v_result
  from public.dd012_create_modifier_group(
    'deedou-demo', 'dd012b-cashier-denied', 'denied', 'Denied', 'Denied',
    false, false, 0, 1, 1,
    'dd012b-cashier-denied', 'ADMIN', 'dd012b-cashier-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'expected CASHIER modifier mutation forbidden, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
begin
  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_create_variant'
      and target_id = 'dd012b-tea-large'
      and staff_id = 'dd012b-staff-admin'
      and device_id = 'dd012b-dev-admin'
      and outcome = 'OK'
  ) then
    raise exception 'variant audit missing';
  end if;
  if not exists (
    select 1 from public.audit_events
    where command = 'dd012_set_product_modifier_group_assignment'
      and target_id = 'dd012b-tea:dd012b-sugar'
      and staff_id = 'dd012b-staff-admin'
      and device_id = 'dd012b-dev-admin'
      and outcome = 'OK'
  ) then
    raise exception 'modifier assignment audit missing';
  end if;
end $$;

rollback;
