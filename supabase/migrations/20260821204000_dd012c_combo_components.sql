-- DD-012C authoritative combo component administration.
-- Reuses product_components as the combo recipe/routing model.
-- Historical submitted order lines remain immutable snapshots.

alter table public.product_components
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
    ), '[]'::jsonb),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pc.id,
        'parentProductId', pc.parent_product_id,
        'componentKey', pc.component_key,
        'nameVi', pc.name_vi,
        'nameEn', pc.name_en,
        'qty', pc.qty,
        'stationCode', pc.station_code,
        'displayOrder', pc.display_order,
        'updatedAt', pc.updated_at
      ) order by pc.parent_product_id, pc.display_order, pc.component_key, pc.id)
      from public.product_components pc
      join public.products p on p.id = pc.parent_product_id
      where p.location_id = p_location_id
    ), '[]'::jsonb)
  ) into v_payload;

  return query select * from public.dd008c_success('admin_menu', p_location_id, null, v_payload);
end
$$;

create or replace function public.dd012_create_product_component(
  p_location_id text,
  p_parent_product_id text,
  p_component_id text,
  p_component_key text,
  p_name_vi text,
  p_name_en text,
  p_qty integer,
  p_station_code text,
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
  v_component public.product_components;
  v_parent_product_id text := lower(btrim(coalesce(p_parent_product_id, '')));
  v_component_id text := lower(btrim(coalesce(p_component_id, '')));
  v_component_key text := lower(btrim(coalesce(p_component_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_station_code text := upper(btrim(coalesce(p_station_code, '')));
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
      'dd012_create_product_component', 'product_component', v_component_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_parent_product_id = ''
     or v_component_id !~ '^[a-z0-9][a-z0-9-]{0,79}$'
     or v_component_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_name_vi = '' or v_name_en = ''
     or p_qty is null or p_qty <= 0
     or v_station_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or p_display_order is null or p_display_order < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product_component', 'product_component', v_component_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_COMPONENT'
    );
    return;
  end if;

  if not exists (
    select 1 from public.products p
    where p.id = v_parent_product_id and p.location_id = p_location_id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product_component', 'product_component', v_component_id,
      'VALIDATION_ERROR', 'PARENT_PRODUCT_NOT_FOUND'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'parentProductId', v_parent_product_id,
    'componentId', v_component_id,
    'componentKey', v_component_key,
    'nameVi', v_name_vi,
    'nameEn', v_name_en,
    'qty', p_qty,
    'stationCode', v_station_code,
    'displayOrder', p_display_order
  ));
  v_replay := public.dd008c_replay_command(
    p_location_id, 'dd012_create_product_component', p_idempotency_key, v_hash
  );
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  if exists (select 1 from public.product_components where id = v_component_id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product_component', 'product_component', v_component_id,
      'CONFLICT', 'PRODUCT_COMPONENT_ID_EXISTS'
    );
    return;
  end if;
  if exists (
    select 1 from public.product_components
    where parent_product_id = v_parent_product_id and component_key = v_component_key
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product_component', 'product_component', v_component_id,
      'CONFLICT', 'PRODUCT_COMPONENT_KEY_EXISTS'
    );
    return;
  end if;

  insert into public.product_components (
    id, parent_product_id, component_key, name_vi, name_en,
    qty, station_code, display_order, updated_at
  ) values (
    v_component_id, v_parent_product_id, v_component_key, v_name_vi, v_name_en,
    p_qty, v_station_code, p_display_order, clock_timestamp()
  ) returning * into v_component;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product_component', v_component.id, null,
    jsonb_build_object('component', jsonb_build_object(
      'id', v_component.id,
      'parentProductId', v_component.parent_product_id,
      'componentKey', v_component.component_key,
      'nameVi', v_component.name_vi,
      'nameEn', v_component.name_en,
      'qty', v_component.qty,
      'stationCode', v_component.station_code,
      'displayOrder', v_component.display_order,
      'updatedAt', v_component.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_create_product_component', 'product_component', v_component.id, v_result,
    jsonb_build_object(
      'parentProductId', v_component.parent_product_id,
      'componentKey', v_component.component_key,
      'qty', v_component.qty,
      'stationCode', v_component.station_code
    )
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_create_product_component', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'admin', 'product_component', v_component.id,
    jsonb_build_object('reason', 'PRODUCT_COMPONENT_CREATED')
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'ops', 'product_component', v_component.id,
    jsonb_build_object('reason', 'PRODUCT_COMPONENT_CREATED')
  );
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_update_product_component(
  p_location_id text,
  p_component_id text,
  p_component_key text,
  p_name_vi text,
  p_name_en text,
  p_qty integer,
  p_station_code text,
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
  v_component public.product_components;
  v_component_id text := lower(btrim(coalesce(p_component_id, '')));
  v_component_key text := lower(btrim(coalesce(p_component_key, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_station_code text := upper(btrim(coalesce(p_station_code, '')));
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
      'dd012_update_product_component', 'product_component', v_component_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_component_id = ''
     or v_component_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_name_vi = '' or v_name_en = ''
     or p_qty is null or p_qty <= 0
     or v_station_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
     or p_display_order is null or p_display_order < 0
     or p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product_component', 'product_component', v_component_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_COMPONENT'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'componentId', v_component_id,
    'componentKey', v_component_key,
    'nameVi', v_name_vi,
    'nameEn', v_name_en,
    'qty', p_qty,
    'stationCode', v_station_code,
    'displayOrder', p_display_order,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(
    p_location_id, 'dd012_update_product_component', p_idempotency_key, v_hash
  );
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select pc.* into v_component
  from public.product_components pc
  join public.products p on p.id = pc.parent_product_id
  where pc.id = v_component_id and p.location_id = p_location_id
  for update of pc;
  if v_component.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product_component', 'product_component', v_component_id,
      'VALIDATION_ERROR', 'PRODUCT_COMPONENT_NOT_FOUND'
    );
    return;
  end if;
  if v_component.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product_component', 'product_component', v_component_id,
      'CONFLICT', 'STALE_PRODUCT_COMPONENT',
      jsonb_build_object('currentUpdatedAt', v_component.updated_at)
    );
    return;
  end if;
  if exists (
    select 1 from public.product_components pc
    where pc.parent_product_id = v_component.parent_product_id
      and pc.component_key = v_component_key
      and pc.id <> v_component.id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product_component', 'product_component', v_component_id,
      'CONFLICT', 'PRODUCT_COMPONENT_KEY_EXISTS'
    );
    return;
  end if;

  update public.product_components
  set component_key = v_component_key,
      name_vi = v_name_vi,
      name_en = v_name_en,
      qty = p_qty,
      station_code = v_station_code,
      display_order = p_display_order,
      updated_at = clock_timestamp()
  where id = v_component.id
  returning * into v_component;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product_component', v_component.id, null,
    jsonb_build_object('component', jsonb_build_object(
      'id', v_component.id,
      'parentProductId', v_component.parent_product_id,
      'componentKey', v_component.component_key,
      'nameVi', v_component.name_vi,
      'nameEn', v_component.name_en,
      'qty', v_component.qty,
      'stationCode', v_component.station_code,
      'displayOrder', v_component.display_order,
      'updatedAt', v_component.updated_at
    ))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_update_product_component', 'product_component', v_component.id, v_result,
    jsonb_build_object(
      'parentProductId', v_component.parent_product_id,
      'componentKey', v_component.component_key,
      'qty', v_component.qty,
      'stationCode', v_component.station_code
    )
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_update_product_component', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'admin', 'product_component', v_component.id,
    jsonb_build_object('reason', 'PRODUCT_COMPONENT_UPDATED')
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'ops', 'product_component', v_component.id,
    jsonb_build_object('reason', 'PRODUCT_COMPONENT_UPDATED')
  );
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_delete_product_component(
  p_location_id text,
  p_component_id text,
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
  v_component public.product_components;
  v_component_id text := lower(btrim(coalesce(p_component_id, '')));
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
      'dd012_delete_product_component', 'product_component', v_component_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if v_component_id = '' or p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_product_component', 'product_component', v_component_id,
      'VALIDATION_ERROR', 'EXPECTED_UPDATED_AT_REQUIRED'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'componentId', v_component_id,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(
    p_location_id, 'dd012_delete_product_component', p_idempotency_key, v_hash
  );
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select pc.* into v_component
  from public.product_components pc
  join public.products p on p.id = pc.parent_product_id
  where pc.id = v_component_id and p.location_id = p_location_id
  for update of pc;
  if v_component.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_product_component', 'product_component', v_component_id,
      'VALIDATION_ERROR', 'PRODUCT_COMPONENT_NOT_FOUND'
    );
    return;
  end if;
  if v_component.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_delete_product_component', 'product_component', v_component_id,
      'CONFLICT', 'STALE_PRODUCT_COMPONENT',
      jsonb_build_object('currentUpdatedAt', v_component.updated_at)
    );
    return;
  end if;

  delete from public.product_components where id = v_component.id;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product_component', v_component.id, null,
    jsonb_build_object(
      'deleted', true,
      'parentProductId', v_component.parent_product_id
    )
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_delete_product_component', 'product_component', v_component.id, v_result,
    jsonb_build_object(
      'parentProductId', v_component.parent_product_id,
      'componentKey', v_component.component_key
    )
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_delete_product_component', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'admin', 'product_component', v_component.id,
    jsonb_build_object('reason', 'PRODUCT_COMPONENT_DELETED')
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'ops', 'product_component', v_component.id,
    jsonb_build_object('reason', 'PRODUCT_COMPONENT_DELETED')
  );
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd012_create_product_component(text, text, text, text, text, text, integer, text, integer, text, text, text) from public, anon;
revoke all on function public.dd012_update_product_component(text, text, text, text, text, integer, text, integer, timestamptz, text, text, text) from public, anon;
revoke all on function public.dd012_delete_product_component(text, text, timestamptz, text, text, text) from public, anon;

grant execute on function public.dd012_create_product_component(text, text, text, text, text, text, integer, text, integer, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_update_product_component(text, text, text, text, text, integer, text, integer, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_delete_product_component(text, text, timestamptz, text, text, text) to authenticated, service_role;
