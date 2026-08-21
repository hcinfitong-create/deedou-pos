-- DD-012B authoritative variants/modifiers administration.
-- Reuses the existing catalog model; direct Data API writes remain denied.

alter table public.product_variants
  add column if not exists updated_at timestamptz not null default now();
alter table public.modifier_groups
  add column if not exists updated_at timestamptz not null default now();
alter table public.modifier_options
  add column if not exists updated_at timestamptz not null default now();
alter table public.product_modifier_groups
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.dd008d_get_admin_menu_snapshot(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_payload jsonb;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;

  select jsonb_build_object(
    'locationId', p_location_id,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'kind', p.kind,
        'category', p.category,
        'nameVi', p.name_vi,
        'nameEn', p.name_en,
        'descVi', p.desc_vi,
        'descEn', p.desc_en,
        'priceVnd', p.price_vnd,
        'stationCode', p.station_code,
        'available', p.available,
        'imageUrl', p.image_url,
        'color', p.color,
        'art', p.art,
        'periods', p.periods,
        'createdAt', p.created_at,
        'updatedAt', p.updated_at
      ) order by p.kind, p.category, p.name_vi, p.id)
      from public.products p
      where p.location_id = p_location_id
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pv.id,
        'productId', pv.product_id,
        'variantKey', pv.variant_key,
        'nameVi', pv.name_vi,
        'nameEn', pv.name_en,
        'priceDeltaVnd', pv.price_delta_vnd,
        'available', pv.available,
        'displayOrder', pv.display_order,
        'updatedAt', pv.updated_at
      ) order by pv.product_id, pv.display_order, pv.variant_key, pv.id)
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      where p.location_id = p_location_id
    ), '[]'::jsonb),
    'modifierGroups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mg.id,
        'groupKey', mg.group_key,
        'nameVi', mg.name_vi,
        'nameEn', mg.name_en,
        'required', mg.required,
        'multiple', mg.multiple,
        'minSelect', mg.min_select,
        'maxSelect', mg.max_select,
        'displayOrder', mg.display_order,
        'updatedAt', mg.updated_at
      ) order by mg.display_order, mg.group_key, mg.id)
      from public.modifier_groups mg
      where mg.location_id = p_location_id
    ), '[]'::jsonb),
    'modifierOptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mo.id,
        'modifierGroupId', mo.modifier_group_id,
        'optionKey', mo.option_key,
        'nameVi', mo.name_vi,
        'nameEn', mo.name_en,
        'priceDeltaVnd', mo.price_delta_vnd,
        'available', mo.available,
        'displayOrder', mo.display_order,
        'updatedAt', mo.updated_at
      ) order by mo.modifier_group_id, mo.display_order, mo.option_key, mo.id)
      from public.modifier_options mo
      join public.modifier_groups mg on mg.id = mo.modifier_group_id
      where mg.location_id = p_location_id
    ), '[]'::jsonb),
    'productModifierGroups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'productId', pmg.product_id,
        'modifierGroupId', pmg.modifier_group_id,
        'displayOrder', pmg.display_order,
        'updatedAt', pmg.updated_at
      ) order by pmg.product_id, pmg.display_order, pmg.modifier_group_id)
      from public.product_modifier_groups pmg
      join public.products p on p.id = pmg.product_id
      join public.modifier_groups mg on mg.id = pmg.modifier_group_id
      where p.location_id = p_location_id
        and mg.location_id = p_location_id
    ), '[]'::jsonb)
  ) into v_payload;

  return query select * from public.dd008c_success('admin_menu', p_location_id, null, v_payload);
end
$$;

create or replace function public.dd012_create_variant(
  p_location_id text,
  p_product_id text,
  p_variant_id text,
  p_variant_key text,
  p_name_vi text,
  p_name_en text,
  p_price_delta_vnd integer,
  p_available boolean,
  p_display_order integer,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_variant public.product_variants;
  v_product_id text := lower(btrim(coalesce(p_product_id, '')));
  v_variant_id text := lower(btrim(coalesce(p_variant_id, '')));
  v_variant_key text := lower(btrim(coalesce(p_variant_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_variant_id !~ '^[a-z0-9][a-z0-9-]{0,79}$' or v_variant_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'INVALID_VARIANT_ID'
    );
    return;
  end if;
  if v_name_vi = '' or v_name_en = '' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'VARIANT_NAME_REQUIRED'
    );
    return;
  end if;
  if p_price_delta_vnd is null or p_display_order is null or p_display_order < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'INVALID_VARIANT_VALUE'
    );
    return;
  end if;
  if not exists (
    select 1 from public.products p
    where p.id = v_product_id and p.location_id = p_location_id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'PRODUCT_NOT_FOUND'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'productId', v_product_id,
    'variantId', v_variant_id,
    'variantKey', v_variant_key,
    'nameVi', v_name_vi,
    'nameEn', v_name_en,
    'priceDeltaVnd', p_price_delta_vnd,
    'available', coalesce(p_available, true),
    'displayOrder', p_display_order
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_create_variant', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  if exists (select 1 from public.product_variants where id = v_variant_id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'CONFLICT', 'VARIANT_ID_EXISTS'
    );
    return;
  end if;
  if exists (
    select 1 from public.product_variants
    where product_id = v_product_id and variant_key = v_variant_key
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'CONFLICT', 'VARIANT_KEY_EXISTS'
    );
    return;
  end if;
  if coalesce(p_available, true) = false
     and not exists (
       select 1 from public.product_variants
       where product_id = v_product_id and available = true
     ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'VARIANT_SET_UNSATISFIABLE'
    );
    return;
  end if;

  insert into public.product_variants (
    id, product_id, variant_key, name_vi, name_en, price_delta_vnd, available, display_order, updated_at
  ) values (
    v_variant_id, v_product_id, v_variant_key, v_name_vi, v_name_en,
    p_price_delta_vnd, coalesce(p_available, true), p_display_order, now()
  ) returning * into v_variant;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product_variant', v_variant.id, null,
    jsonb_build_object('variant', jsonb_build_object(
      'id', v_variant.id,
      'productId', v_variant.product_id,
      'variantKey', v_variant.variant_key,
      'nameVi', v_variant.name_vi,
      'nameEn', v_variant.name_en,
      'priceDeltaVnd', v_variant.price_delta_vnd,
      'available', v_variant.available,
      'displayOrder', v_variant.display_order,
      'updatedAt', v_variant.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_create_variant', 'product_variant', v_variant.id, v_result,
    jsonb_build_object('productId', v_product_id, 'variantKey', v_variant.variant_key)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_create_variant', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'product_variant', v_variant.id, jsonb_build_object('reason', 'VARIANT_CREATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'product_variant', v_variant.id, jsonb_build_object('reason', 'VARIANT_CREATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_update_variant(
  p_location_id text,
  p_variant_id text,
  p_variant_key text,
  p_name_vi text,
  p_name_en text,
  p_price_delta_vnd integer,
  p_available boolean,
  p_display_order integer,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_variant public.product_variants;
  v_variant_id text := lower(btrim(coalesce(p_variant_id, '')));
  v_variant_key text := lower(btrim(coalesce(p_variant_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_remaining_available integer;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_variant', 'product_variant', v_variant_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_variant_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or v_name_vi = '' or v_name_en = ''
     or p_price_delta_vnd is null or p_display_order is null or p_display_order < 0
     or p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'INVALID_VARIANT_VALUE'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'variantId', v_variant_id,
    'variantKey', v_variant_key,
    'nameVi', v_name_vi,
    'nameEn', v_name_en,
    'priceDeltaVnd', p_price_delta_vnd,
    'available', coalesce(p_available, true),
    'displayOrder', p_display_order,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_update_variant', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select pv.* into v_variant
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = v_variant_id and p.location_id = p_location_id
  for update of pv;
  if v_variant.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_variant', 'product_variant', v_variant_id,
      'VALIDATION_ERROR', 'VARIANT_NOT_FOUND'
    );
    return;
  end if;
  if v_variant.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_variant', 'product_variant', v_variant_id,
      'CONFLICT', 'STALE_VARIANT', jsonb_build_object('currentUpdatedAt', v_variant.updated_at)
    );
    return;
  end if;
  if exists (
    select 1 from public.product_variants pv
    where pv.product_id = v_variant.product_id
      and pv.variant_key = v_variant_key
      and pv.id <> v_variant.id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_variant', 'product_variant', v_variant_id,
      'CONFLICT', 'VARIANT_KEY_EXISTS'
    );
    return;
  end if;
  if coalesce(p_available, true) = false then
    select count(*) into v_remaining_available
    from public.product_variants pv
    where pv.product_id = v_variant.product_id
      and pv.available = true
      and pv.id <> v_variant.id;
    if v_remaining_available = 0 then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd012_update_variant', 'product_variant', v_variant_id,
        'VALIDATION_ERROR', 'VARIANT_SET_UNSATISFIABLE'
      );
      return;
    end if;
  end if;

  update public.product_variants
  set variant_key = v_variant_key,
      name_vi = v_name_vi,
      name_en = v_name_en,
      price_delta_vnd = p_price_delta_vnd,
      available = coalesce(p_available, true),
      display_order = p_display_order,
      updated_at = now()
  where id = v_variant.id
  returning * into v_variant;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product_variant', v_variant.id, null,
    jsonb_build_object('variant', jsonb_build_object(
      'id', v_variant.id,
      'productId', v_variant.product_id,
      'variantKey', v_variant.variant_key,
      'nameVi', v_variant.name_vi,
      'nameEn', v_variant.name_en,
      'priceDeltaVnd', v_variant.price_delta_vnd,
      'available', v_variant.available,
      'displayOrder', v_variant.display_order,
      'updatedAt', v_variant.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_update_variant', 'product_variant', v_variant.id, v_result,
    jsonb_build_object('productId', v_variant.product_id, 'variantKey', v_variant.variant_key, 'available', v_variant.available)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_update_variant', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'product_variant', v_variant.id, jsonb_build_object('reason', 'VARIANT_UPDATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'product_variant', v_variant.id, jsonb_build_object('reason', 'VARIANT_UPDATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_delete_variant(
  p_location_id text,
  p_variant_id text,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_variant public.product_variants;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_remaining integer;
  v_remaining_available integer;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_variant', 'product_variant', p_variant_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_variant', 'product_variant', p_variant_id,
      'VALIDATION_ERROR', 'EXPECTED_UPDATED_AT_REQUIRED'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'variantId', p_variant_id, 'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_delete_variant', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select pv.* into v_variant
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id and p.location_id = p_location_id
  for update of pv;
  if v_variant.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_variant', 'product_variant', p_variant_id,
      'VALIDATION_ERROR', 'VARIANT_NOT_FOUND'
    );
    return;
  end if;
  if v_variant.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_variant', 'product_variant', p_variant_id,
      'CONFLICT', 'STALE_VARIANT', jsonb_build_object('currentUpdatedAt', v_variant.updated_at)
    );
    return;
  end if;

  select count(*), count(*) filter (where available = true)
  into v_remaining, v_remaining_available
  from public.product_variants
  where product_id = v_variant.product_id and id <> v_variant.id;
  if v_remaining > 0 and v_remaining_available = 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_variant', 'product_variant', p_variant_id,
      'VALIDATION_ERROR', 'VARIANT_SET_UNSATISFIABLE'
    );
    return;
  end if;

  delete from public.product_variants where id = v_variant.id;
  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product_variant', v_variant.id, null,
    jsonb_build_object('deleted', true, 'productId', v_variant.product_id)
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_delete_variant', 'product_variant', v_variant.id, v_result,
    jsonb_build_object('productId', v_variant.product_id, 'variantKey', v_variant.variant_key)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_delete_variant', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'product_variant', v_variant.id, jsonb_build_object('reason', 'VARIANT_DELETED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'product_variant', v_variant.id, jsonb_build_object('reason', 'VARIANT_DELETED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_create_modifier_group(
  p_location_id text,
  p_modifier_group_id text,
  p_group_key text,
  p_name_vi text,
  p_name_en text,
  p_required boolean,
  p_multiple boolean,
  p_min_select integer,
  p_max_select integer,
  p_display_order integer,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_group public.modifier_groups;
  v_id text := lower(btrim(coalesce(p_modifier_group_id, '')));
  v_key text := lower(btrim(coalesce(p_group_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_required boolean := coalesce(p_required, false) or coalesce(p_min_select, 0) > 0;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_group', 'modifier_group', v_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if v_id !~ '^[a-z0-9][a-z0-9-]{0,79}$' or v_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_name_vi = '' or v_name_en = ''
     or p_min_select is null or p_max_select is null or p_display_order is null
     or p_min_select < 0 or p_max_select < p_min_select or p_display_order < 0
     or (coalesce(p_multiple, false) = false and p_max_select > 1) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_group', 'modifier_group', v_id,
      'VALIDATION_ERROR', 'INVALID_MODIFIER_GROUP'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'modifierGroupId', v_id, 'groupKey', v_key,
    'nameVi', v_name_vi, 'nameEn', v_name_en, 'required', v_required,
    'multiple', coalesce(p_multiple, false), 'minSelect', p_min_select,
    'maxSelect', p_max_select, 'displayOrder', p_display_order
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_create_modifier_group', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;
  if exists (select 1 from public.modifier_groups where id = v_id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_group', 'modifier_group', v_id,
      'CONFLICT', 'MODIFIER_GROUP_ID_EXISTS'
    );
    return;
  end if;
  if exists (
    select 1 from public.modifier_groups where location_id = p_location_id and group_key = v_key
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_group', 'modifier_group', v_id,
      'CONFLICT', 'MODIFIER_GROUP_KEY_EXISTS'
    );
    return;
  end if;

  insert into public.modifier_groups (
    id, location_id, group_key, name_vi, name_en, required, multiple,
    min_select, max_select, display_order, updated_at
  ) values (
    v_id, p_location_id, v_key, v_name_vi, v_name_en, v_required, coalesce(p_multiple, false),
    p_min_select, p_max_select, p_display_order, now()
  ) returning * into v_group;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'modifier_group', v_group.id, null,
    jsonb_build_object('modifierGroup', jsonb_build_object(
      'id', v_group.id, 'groupKey', v_group.group_key,
      'nameVi', v_group.name_vi, 'nameEn', v_group.name_en,
      'required', v_group.required, 'multiple', v_group.multiple,
      'minSelect', v_group.min_select, 'maxSelect', v_group.max_select,
      'displayOrder', v_group.display_order, 'updatedAt', v_group.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_create_modifier_group', 'modifier_group', v_group.id, v_result,
    jsonb_build_object('groupKey', v_group.group_key, 'minSelect', v_group.min_select, 'maxSelect', v_group.max_select)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_create_modifier_group', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'modifier_group', v_group.id, jsonb_build_object('reason', 'MODIFIER_GROUP_CREATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_update_modifier_group(
  p_location_id text,
  p_modifier_group_id text,
  p_group_key text,
  p_name_vi text,
  p_name_en text,
  p_required boolean,
  p_multiple boolean,
  p_min_select integer,
  p_max_select integer,
  p_display_order integer,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_group public.modifier_groups;
  v_id text := lower(btrim(coalesce(p_modifier_group_id, '')));
  v_key text := lower(btrim(coalesce(p_group_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_required boolean := coalesce(p_required, false) or coalesce(p_min_select, 0) > 0;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_total_options integer;
  v_available_options integer;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_group', 'modifier_group', v_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if v_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or v_name_vi = '' or v_name_en = ''
     or p_min_select is null or p_max_select is null or p_display_order is null
     or p_min_select < 0 or p_max_select < p_min_select or p_display_order < 0
     or (coalesce(p_multiple, false) = false and p_max_select > 1)
     or p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_group', 'modifier_group', v_id,
      'VALIDATION_ERROR', 'INVALID_MODIFIER_GROUP'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'modifierGroupId', v_id, 'groupKey', v_key,
    'nameVi', v_name_vi, 'nameEn', v_name_en, 'required', v_required,
    'multiple', coalesce(p_multiple, false), 'minSelect', p_min_select,
    'maxSelect', p_max_select, 'displayOrder', p_display_order,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_update_modifier_group', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_group
  from public.modifier_groups
  where id = v_id and location_id = p_location_id
  for update;
  if v_group.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_group', 'modifier_group', v_id,
      'VALIDATION_ERROR', 'MODIFIER_GROUP_NOT_FOUND'
    );
    return;
  end if;
  if v_group.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_group', 'modifier_group', v_id,
      'CONFLICT', 'STALE_MODIFIER_GROUP', jsonb_build_object('currentUpdatedAt', v_group.updated_at)
    );
    return;
  end if;
  if exists (
    select 1 from public.modifier_groups
    where location_id = p_location_id and group_key = v_key and id <> v_id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_group', 'modifier_group', v_id,
      'CONFLICT', 'MODIFIER_GROUP_KEY_EXISTS'
    );
    return;
  end if;

  if exists (select 1 from public.product_modifier_groups where modifier_group_id = v_id) then
    select count(*), count(*) filter (where available = true)
    into v_total_options, v_available_options
    from public.modifier_options where modifier_group_id = v_id;
    if p_min_select > v_available_options or p_max_select > v_total_options then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd012_update_modifier_group', 'modifier_group', v_id,
        'VALIDATION_ERROR', 'MODIFIER_GROUP_UNSATISFIABLE'
      );
      return;
    end if;
  end if;

  update public.modifier_groups
  set group_key = v_key,
      name_vi = v_name_vi,
      name_en = v_name_en,
      required = v_required,
      multiple = coalesce(p_multiple, false),
      min_select = p_min_select,
      max_select = p_max_select,
      display_order = p_display_order,
      updated_at = now()
  where id = v_id
  returning * into v_group;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'modifier_group', v_group.id, null,
    jsonb_build_object('modifierGroup', jsonb_build_object(
      'id', v_group.id, 'groupKey', v_group.group_key,
      'nameVi', v_group.name_vi, 'nameEn', v_group.name_en,
      'required', v_group.required, 'multiple', v_group.multiple,
      'minSelect', v_group.min_select, 'maxSelect', v_group.max_select,
      'displayOrder', v_group.display_order, 'updatedAt', v_group.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_update_modifier_group', 'modifier_group', v_group.id, v_result,
    jsonb_build_object('groupKey', v_group.group_key, 'minSelect', v_group.min_select, 'maxSelect', v_group.max_select)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_update_modifier_group', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'modifier_group', v_group.id, jsonb_build_object('reason', 'MODIFIER_GROUP_UPDATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'modifier_group', v_group.id, jsonb_build_object('reason', 'MODIFIER_GROUP_UPDATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_delete_modifier_group(
  p_location_id text,
  p_modifier_group_id text,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_group public.modifier_groups;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_group', 'modifier_group', p_modifier_group_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_group', 'modifier_group', p_modifier_group_id,
      'VALIDATION_ERROR', 'EXPECTED_UPDATED_AT_REQUIRED'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'modifierGroupId', p_modifier_group_id, 'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_delete_modifier_group', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_group
  from public.modifier_groups
  where id = p_modifier_group_id and location_id = p_location_id
  for update;
  if v_group.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_group', 'modifier_group', p_modifier_group_id,
      'VALIDATION_ERROR', 'MODIFIER_GROUP_NOT_FOUND'
    );
    return;
  end if;
  if v_group.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_group', 'modifier_group', p_modifier_group_id,
      'CONFLICT', 'STALE_MODIFIER_GROUP', jsonb_build_object('currentUpdatedAt', v_group.updated_at)
    );
    return;
  end if;
  if exists (select 1 from public.product_modifier_groups where modifier_group_id = v_group.id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_group', 'modifier_group', p_modifier_group_id,
      'CONFLICT', 'MODIFIER_GROUP_ASSIGNED'
    );
    return;
  end if;

  delete from public.modifier_groups where id = v_group.id;
  v_result := public.dd008c_result_json(
    true, 'OK', '', 'modifier_group', v_group.id, null, jsonb_build_object('deleted', true)
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_delete_modifier_group', 'modifier_group', v_group.id, v_result,
    jsonb_build_object('groupKey', v_group.group_key)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_delete_modifier_group', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'modifier_group', v_group.id, jsonb_build_object('reason', 'MODIFIER_GROUP_DELETED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'modifier_group', v_group.id, jsonb_build_object('reason', 'MODIFIER_GROUP_DELETED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_create_modifier_option(
  p_location_id text,
  p_modifier_group_id text,
  p_modifier_option_id text,
  p_option_key text,
  p_name_vi text,
  p_name_en text,
  p_price_delta_vnd integer,
  p_available boolean,
  p_display_order integer,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_option public.modifier_options;
  v_group public.modifier_groups;
  v_id text := lower(btrim(coalesce(p_modifier_option_id, '')));
  v_key text := lower(btrim(coalesce(p_option_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_option', 'modifier_option', v_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if v_id !~ '^[a-z0-9][a-z0-9-]{0,79}$' or v_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_name_vi = '' or v_name_en = '' or p_price_delta_vnd is null
     or p_display_order is null or p_display_order < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_option', 'modifier_option', v_id,
      'VALIDATION_ERROR', 'INVALID_MODIFIER_OPTION'
    );
    return;
  end if;
  select * into v_group from public.modifier_groups
  where id = p_modifier_group_id and location_id = p_location_id;
  if v_group.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_option', 'modifier_option', v_id,
      'VALIDATION_ERROR', 'MODIFIER_GROUP_NOT_FOUND'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'modifierGroupId', v_group.id,
    'modifierOptionId', v_id, 'optionKey', v_key,
    'nameVi', v_name_vi, 'nameEn', v_name_en,
    'priceDeltaVnd', p_price_delta_vnd, 'available', coalesce(p_available, true),
    'displayOrder', p_display_order
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_create_modifier_option', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;
  if exists (select 1 from public.modifier_options where id = v_id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_option', 'modifier_option', v_id,
      'CONFLICT', 'MODIFIER_OPTION_ID_EXISTS'
    );
    return;
  end if;
  if exists (
    select 1 from public.modifier_options where modifier_group_id = v_group.id and option_key = v_key
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_modifier_option', 'modifier_option', v_id,
      'CONFLICT', 'MODIFIER_OPTION_KEY_EXISTS'
    );
    return;
  end if;

  insert into public.modifier_options (
    id, modifier_group_id, option_key, name_vi, name_en, price_delta_vnd, available, display_order, updated_at
  ) values (
    v_id, v_group.id, v_key, v_name_vi, v_name_en, p_price_delta_vnd,
    coalesce(p_available, true), p_display_order, now()
  ) returning * into v_option;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'modifier_option', v_option.id, null,
    jsonb_build_object('modifierOption', jsonb_build_object(
      'id', v_option.id, 'modifierGroupId', v_option.modifier_group_id,
      'optionKey', v_option.option_key, 'nameVi', v_option.name_vi,
      'nameEn', v_option.name_en, 'priceDeltaVnd', v_option.price_delta_vnd,
      'available', v_option.available, 'displayOrder', v_option.display_order,
      'updatedAt', v_option.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_create_modifier_option', 'modifier_option', v_option.id, v_result,
    jsonb_build_object('modifierGroupId', v_option.modifier_group_id, 'optionKey', v_option.option_key)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_create_modifier_option', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'modifier_option', v_option.id, jsonb_build_object('reason', 'MODIFIER_OPTION_CREATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'modifier_option', v_option.id, jsonb_build_object('reason', 'MODIFIER_OPTION_CREATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_update_modifier_option(
  p_location_id text,
  p_modifier_option_id text,
  p_option_key text,
  p_name_vi text,
  p_name_en text,
  p_price_delta_vnd integer,
  p_available boolean,
  p_display_order integer,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_option public.modifier_options;
  v_group public.modifier_groups;
  v_id text := lower(btrim(coalesce(p_modifier_option_id, '')));
  v_key text := lower(btrim(coalesce(p_option_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_total_after integer;
  v_available_after integer;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_option', 'modifier_option', v_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if v_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' or v_name_vi = '' or v_name_en = ''
     or p_price_delta_vnd is null or p_display_order is null or p_display_order < 0
     or p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_option', 'modifier_option', v_id,
      'VALIDATION_ERROR', 'INVALID_MODIFIER_OPTION'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'modifierOptionId', v_id, 'optionKey', v_key,
    'nameVi', v_name_vi, 'nameEn', v_name_en, 'priceDeltaVnd', p_price_delta_vnd,
    'available', coalesce(p_available, true), 'displayOrder', p_display_order,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_update_modifier_option', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select mo.* into v_option
  from public.modifier_options mo
  join public.modifier_groups mg on mg.id = mo.modifier_group_id
  where mo.id = v_id and mg.location_id = p_location_id
  for update of mo;
  if v_option.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_option', 'modifier_option', v_id,
      'VALIDATION_ERROR', 'MODIFIER_OPTION_NOT_FOUND'
    );
    return;
  end if;
  select * into v_group from public.modifier_groups where id = v_option.modifier_group_id;
  if v_option.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_option', 'modifier_option', v_id,
      'CONFLICT', 'STALE_MODIFIER_OPTION', jsonb_build_object('currentUpdatedAt', v_option.updated_at)
    );
    return;
  end if;
  if exists (
    select 1 from public.modifier_options
    where modifier_group_id = v_option.modifier_group_id
      and option_key = v_key and id <> v_option.id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_modifier_option', 'modifier_option', v_id,
      'CONFLICT', 'MODIFIER_OPTION_KEY_EXISTS'
    );
    return;
  end if;

  if exists (select 1 from public.product_modifier_groups where modifier_group_id = v_group.id) then
    select count(*),
           count(*) filter (where case when id = v_option.id then coalesce(p_available, true) else available end)
    into v_total_after, v_available_after
    from public.modifier_options where modifier_group_id = v_group.id;
    if v_group.min_select > v_available_after or v_group.max_select > v_total_after then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd012_update_modifier_option', 'modifier_option', v_id,
        'VALIDATION_ERROR', 'MODIFIER_GROUP_UNSATISFIABLE'
      );
      return;
    end if;
  end if;

  update public.modifier_options
  set option_key = v_key,
      name_vi = v_name_vi,
      name_en = v_name_en,
      price_delta_vnd = p_price_delta_vnd,
      available = coalesce(p_available, true),
      display_order = p_display_order,
      updated_at = now()
  where id = v_option.id
  returning * into v_option;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'modifier_option', v_option.id, null,
    jsonb_build_object('modifierOption', jsonb_build_object(
      'id', v_option.id, 'modifierGroupId', v_option.modifier_group_id,
      'optionKey', v_option.option_key, 'nameVi', v_option.name_vi,
      'nameEn', v_option.name_en, 'priceDeltaVnd', v_option.price_delta_vnd,
      'available', v_option.available, 'displayOrder', v_option.display_order,
      'updatedAt', v_option.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_update_modifier_option', 'modifier_option', v_option.id, v_result,
    jsonb_build_object('modifierGroupId', v_option.modifier_group_id, 'optionKey', v_option.option_key, 'available', v_option.available)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_update_modifier_option', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'modifier_option', v_option.id, jsonb_build_object('reason', 'MODIFIER_OPTION_UPDATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'modifier_option', v_option.id, jsonb_build_object('reason', 'MODIFIER_OPTION_UPDATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_delete_modifier_option(
  p_location_id text,
  p_modifier_option_id text,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_option public.modifier_options;
  v_group public.modifier_groups;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_total_after integer;
  v_available_after integer;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_option', 'modifier_option', p_modifier_option_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_option', 'modifier_option', p_modifier_option_id,
      'VALIDATION_ERROR', 'EXPECTED_UPDATED_AT_REQUIRED'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'modifierOptionId', p_modifier_option_id, 'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_delete_modifier_option', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select mo.* into v_option
  from public.modifier_options mo
  join public.modifier_groups mg on mg.id = mo.modifier_group_id
  where mo.id = p_modifier_option_id and mg.location_id = p_location_id
  for update of mo;
  if v_option.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_option', 'modifier_option', p_modifier_option_id,
      'VALIDATION_ERROR', 'MODIFIER_OPTION_NOT_FOUND'
    );
    return;
  end if;
  if v_option.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_modifier_option', 'modifier_option', p_modifier_option_id,
      'CONFLICT', 'STALE_MODIFIER_OPTION', jsonb_build_object('currentUpdatedAt', v_option.updated_at)
    );
    return;
  end if;
  select * into v_group from public.modifier_groups where id = v_option.modifier_group_id;

  if exists (select 1 from public.product_modifier_groups where modifier_group_id = v_group.id) then
    select count(*), count(*) filter (where available = true)
    into v_total_after, v_available_after
    from public.modifier_options
    where modifier_group_id = v_group.id and id <> v_option.id;
    if v_group.min_select > v_available_after or v_group.max_select > v_total_after then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd012_delete_modifier_option', 'modifier_option', p_modifier_option_id,
        'VALIDATION_ERROR', 'MODIFIER_GROUP_UNSATISFIABLE'
      );
      return;
    end if;
  end if;

  delete from public.modifier_options where id = v_option.id;
  v_result := public.dd008c_result_json(
    true, 'OK', '', 'modifier_option', v_option.id, null,
    jsonb_build_object('deleted', true, 'modifierGroupId', v_option.modifier_group_id)
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_delete_modifier_option', 'modifier_option', v_option.id, v_result,
    jsonb_build_object('modifierGroupId', v_option.modifier_group_id, 'optionKey', v_option.option_key)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_delete_modifier_option', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'modifier_option', v_option.id, jsonb_build_object('reason', 'MODIFIER_OPTION_DELETED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'modifier_option', v_option.id, jsonb_build_object('reason', 'MODIFIER_OPTION_DELETED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_set_product_modifier_group_assignment(
  p_location_id text,
  p_product_id text,
  p_modifier_group_id text,
  p_assigned boolean,
  p_display_order integer,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_workstation_mode text,
  p_device_credential text
)
returns table (ok boolean, category text, reason text, entity_type text, entity_id text, version integer, payload jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_assignment public.product_modifier_groups;
  v_group public.modifier_groups;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_total_options integer;
  v_available_options integer;
  v_target_id text := lower(btrim(coalesce(p_product_id, ''))) || ':' || lower(btrim(coalesce(p_modifier_group_id, '')));
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if p_display_order is null or p_display_order < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'VALIDATION_ERROR', 'INVALID_DISPLAY_ORDER'
    );
    return;
  end if;
  if not exists (
    select 1 from public.products where id = p_product_id and location_id = p_location_id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'VALIDATION_ERROR', 'PRODUCT_NOT_FOUND'
    );
    return;
  end if;
  select * into v_group from public.modifier_groups
  where id = p_modifier_group_id and location_id = p_location_id;
  if v_group.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'VALIDATION_ERROR', 'MODIFIER_GROUP_NOT_FOUND'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'productId', p_product_id,
    'modifierGroupId', p_modifier_group_id, 'assigned', coalesce(p_assigned, false),
    'displayOrder', p_display_order, 'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_set_product_modifier_group_assignment', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_assignment
  from public.product_modifier_groups
  where product_id = p_product_id and modifier_group_id = p_modifier_group_id
  for update;

  if coalesce(p_assigned, false) = true then
    select count(*), count(*) filter (where available = true)
    into v_total_options, v_available_options
    from public.modifier_options where modifier_group_id = v_group.id;
    if v_group.min_select > v_available_options
       or v_group.max_select > v_total_options
       or (v_group.multiple = false and v_group.max_select > 1) then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
        'VALIDATION_ERROR', 'MODIFIER_GROUP_UNSATISFIABLE'
      );
      return;
    end if;

    if v_assignment.product_id is not null then
      if p_expected_updated_at is not null and v_assignment.updated_at <> p_expected_updated_at then
        return query select * from public.dd008c_audited_failure(
          p_location_id, v_authz.staff_profile_id, v_authz.device_id,
          'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
          'CONFLICT', 'STALE_PRODUCT_MODIFIER_GROUP', jsonb_build_object('currentUpdatedAt', v_assignment.updated_at)
        );
        return;
      end if;
      update public.product_modifier_groups
      set display_order = p_display_order, updated_at = now()
      where product_id = p_product_id and modifier_group_id = p_modifier_group_id
      returning * into v_assignment;
    else
      insert into public.product_modifier_groups (product_id, modifier_group_id, display_order, updated_at)
      values (p_product_id, p_modifier_group_id, p_display_order, now())
      returning * into v_assignment;
    end if;

    v_result := public.dd008c_result_json(
      true, 'OK', '', 'product_modifier_group', v_target_id, null,
      jsonb_build_object('assignment', jsonb_build_object(
        'productId', v_assignment.product_id,
        'modifierGroupId', v_assignment.modifier_group_id,
        'displayOrder', v_assignment.display_order,
        'updatedAt', v_assignment.updated_at
      ))
    );
  else
    if v_assignment.product_id is null then
      v_result := public.dd008c_result_json(
        true, 'OK', 'ALREADY_UNASSIGNED', 'product_modifier_group', v_target_id, null,
        jsonb_build_object('assigned', false, 'noOp', true)
      );
    else
      if p_expected_updated_at is not null and v_assignment.updated_at <> p_expected_updated_at then
        return query select * from public.dd008c_audited_failure(
          p_location_id, v_authz.staff_profile_id, v_authz.device_id,
          'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
          'CONFLICT', 'STALE_PRODUCT_MODIFIER_GROUP', jsonb_build_object('currentUpdatedAt', v_assignment.updated_at)
        );
        return;
      end if;
      delete from public.product_modifier_groups
      where product_id = p_product_id and modifier_group_id = p_modifier_group_id;
      v_result := public.dd008c_result_json(
        true, 'OK', '', 'product_modifier_group', v_target_id, null,
        jsonb_build_object('assigned', false)
      );
    end if;
  end if;

  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id, v_result,
    jsonb_build_object('productId', p_product_id, 'modifierGroupId', p_modifier_group_id, 'assigned', coalesce(p_assigned, false))
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_set_product_modifier_group_assignment', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'product_modifier_group', v_target_id, jsonb_build_object('reason', 'PRODUCT_MODIFIER_GROUP_CHANGED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'product_modifier_group', v_target_id, jsonb_build_object('reason', 'PRODUCT_MODIFIER_GROUP_CHANGED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

-- A product that is turned back on must have a satisfiable option configuration.
create or replace function public.dd008d_set_product_availability(
  p_location_id text,
  p_product_id text,
  p_available boolean,
  p_expected_updated_at timestamptz default null,
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
  v_product public.products;
  v_hash text := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'productId', p_product_id,
    'available', p_available,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'menu.manage', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd008d_set_product_availability', 'product', p_product_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  v_replay := public.dd008c_replay_command(
    p_location_id, 'dd008d_set_product_availability', p_idempotency_key, v_hash
  );
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_product
  from public.products
  where id = p_product_id and location_id = p_location_id
  for update;
  if v_product.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd008d_set_product_availability', 'product', p_product_id,
      'VALIDATION_ERROR', 'PRODUCT_NOT_FOUND'
    );
    return;
  end if;
  if p_expected_updated_at is not null and v_product.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd008d_set_product_availability', 'product', p_product_id,
      'CONFLICT', 'STALE_PRODUCT', jsonb_build_object('currentUpdatedAt', v_product.updated_at)
    );
    return;
  end if;

  if coalesce(p_available, false) = true then
    if exists (select 1 from public.product_variants where product_id = p_product_id)
       and not exists (select 1 from public.product_variants where product_id = p_product_id and available = true) then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd008d_set_product_availability', 'product', p_product_id,
        'VALIDATION_ERROR', 'VARIANT_SET_UNSATISFIABLE'
      );
      return;
    end if;
    if exists (
      select 1
      from public.product_modifier_groups pmg
      join public.modifier_groups mg on mg.id = pmg.modifier_group_id
      where pmg.product_id = p_product_id
        and (
          mg.min_select > (select count(*) from public.modifier_options mo where mo.modifier_group_id = mg.id and mo.available = true)
          or mg.max_select > (select count(*) from public.modifier_options mo where mo.modifier_group_id = mg.id)
          or (mg.multiple = false and mg.max_select > 1)
        )
    ) then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd008d_set_product_availability', 'product', p_product_id,
        'VALIDATION_ERROR', 'MODIFIER_GROUP_UNSATISFIABLE'
      );
      return;
    end if;
  end if;

  if v_product.available is not distinct from p_available then
    v_result := public.dd008c_result_json(
      true, 'OK', 'ALREADY_SET', 'product', p_product_id, null,
      jsonb_build_object('product', jsonb_build_object(
        'id', v_product.id, 'available', v_product.available, 'updatedAt', v_product.updated_at
      ), 'noOp', true)
    );
    perform public.dd008c_audit_staff_result(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd008d_set_product_availability', 'product', p_product_id,
      v_result, jsonb_build_object('available', p_available)
    );
    perform public.dd008c_store_command(
      p_location_id, 'dd008d_set_product_availability', p_idempotency_key,
      'STAFF', v_authz.staff_profile_id, v_hash, v_result
    );
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;

  update public.products
  set available = p_available, updated_at = now()
  where id = p_product_id and location_id = p_location_id
  returning * into v_product;
  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product', p_product_id, null,
    jsonb_build_object('product', jsonb_build_object(
      'id', v_product.id, 'available', v_product.available, 'updatedAt', v_product.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd008d_set_product_availability', 'product', p_product_id,
    v_result, jsonb_build_object('available', p_available)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd008d_set_product_availability', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'ops', 'product', p_product_id,
    jsonb_build_object('reason', 'PRODUCT_AVAILABILITY_CHANGED', 'available', p_available)
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'admin', 'product', p_product_id,
    jsonb_build_object('reason', 'PRODUCT_AVAILABILITY_CHANGED', 'available', p_available)
  );
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd012_create_variant(text, text, text, text, text, text, integer, boolean, integer, text, text, text) from public, anon;
revoke all on function public.dd012_update_variant(text, text, text, text, text, integer, boolean, integer, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_delete_variant(text, text, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_create_modifier_group(text, text, text, text, text, boolean, boolean, integer, integer, integer, text, text, text) from public, anon;
revoke all on function public.dd012_update_modifier_group(text, text, text, text, text, boolean, boolean, integer, integer, integer, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_delete_modifier_group(text, text, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_create_modifier_option(text, text, text, text, text, text, integer, boolean, integer, text, text, text) from public, anon;
revoke all on function public.dd012_update_modifier_option(text, text, text, text, text, integer, boolean, integer, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_delete_modifier_option(text, text, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_set_product_modifier_group_assignment(text, text, text, boolean, integer, timestamptz, text, text, text) from public, anon;

grant execute on function public.dd012_create_variant(text, text, text, text, text, text, integer, boolean, integer, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_update_variant(text, text, text, text, text, integer, boolean, integer, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_delete_variant(text, text, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_create_modifier_group(text, text, text, text, text, boolean, boolean, integer, integer, integer, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_update_modifier_group(text, text, text, text, text, boolean, boolean, integer, integer, integer, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_delete_modifier_group(text, text, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_create_modifier_option(text, text, text, text, text, text, integer, boolean, integer, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_update_modifier_option(text, text, text, text, text, integer, boolean, integer, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_delete_modifier_option(text, text, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_set_product_modifier_group_assignment(text, text, text, boolean, integer, timestamptz, text, text, text) to authenticated, service_role;
