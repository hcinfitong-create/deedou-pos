-- DD-012 authoritative Admin catalog product core.
-- Product create/update stays behind menu.manage + registered workstation authority.

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
    'products', coalesce(jsonb_agg(jsonb_build_object(
      'id', public.products.id,
      'kind', public.products.kind,
      'category', public.products.category,
      'nameVi', public.products.name_vi,
      'nameEn', public.products.name_en,
      'descVi', public.products.desc_vi,
      'descEn', public.products.desc_en,
      'priceVnd', public.products.price_vnd,
      'stationCode', public.products.station_code,
      'available', public.products.available,
      'imageUrl', public.products.image_url,
      'color', public.products.color,
      'art', public.products.art,
      'periods', public.products.periods,
      'createdAt', public.products.created_at,
      'updatedAt', public.products.updated_at
    ) order by public.products.kind, public.products.category, public.products.name_vi, public.products.id), '[]'::jsonb)
  ) into v_payload
  from public.products
  where public.products.location_id = p_location_id;

  return query select * from public.dd008c_success('admin_menu', p_location_id, null, v_payload);
end
$$;

create or replace function public.dd012_create_product(
  p_location_id text,
  p_product_id text,
  p_kind text,
  p_category text,
  p_name_vi text,
  p_name_en text,
  p_desc_vi text,
  p_desc_en text,
  p_price_vnd integer,
  p_station_code text,
  p_periods text[],
  p_image_url text,
  p_color text,
  p_art text,
  p_available boolean,
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
  v_product public.products;
  v_product_id text := lower(btrim(coalesce(p_product_id, '')));
  v_kind text := upper(btrim(coalesce(p_kind, '')));
  v_category text := lower(btrim(coalesce(p_category, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_desc_vi text := btrim(coalesce(p_desc_vi, ''));
  v_desc_en text := btrim(coalesce(p_desc_en, ''));
  v_station_code text := upper(btrim(coalesce(p_station_code, '')));
  v_periods text[];
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
      'dd012_create_product', 'product', v_product_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_product_id !~ '^[a-z0-9][a-z0-9-]{0,79}$' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_ID'
    );
    return;
  end if;
  if v_kind not in ('FOOD', 'DRINK') then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_KIND'
    );
    return;
  end if;
  if (v_kind = 'FOOD' and v_category not in ('food-combo', 'food-single', 'food-dessert'))
     or (v_kind = 'DRINK' and v_category not in ('drink-coffee', 'drink-tea', 'drink-signature')) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_CATEGORY'
    );
    return;
  end if;
  if v_name_vi = '' or v_name_en = '' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'PRODUCT_NAME_REQUIRED'
    );
    return;
  end if;
  if p_price_vnd is null or p_price_vnd < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_PRICE'
    );
    return;
  end if;
  if v_station_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_STATION_CODE'
    );
    return;
  end if;
  if coalesce(cardinality(p_periods), 0) = 0
     or exists (
       select 1 from unnest(p_periods) period
       where lower(btrim(coalesce(period, ''))) not in ('morning', 'afternoon', 'evening')
     ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_PERIODS'
    );
    return;
  end if;

  select array_agg(period order by period_order)
  into v_periods
  from (
    select distinct
      lower(btrim(period)) as period,
      case lower(btrim(period)) when 'morning' then 1 when 'afternoon' then 2 else 3 end as period_order
    from unnest(p_periods) period
  ) normalized_periods;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'productId', v_product_id,
    'kind', v_kind,
    'category', v_category,
    'nameVi', v_name_vi,
    'nameEn', v_name_en,
    'descVi', v_desc_vi,
    'descEn', v_desc_en,
    'priceVnd', p_price_vnd,
    'stationCode', v_station_code,
    'periods', v_periods,
    'imageUrl', coalesce(p_image_url, ''),
    'color', coalesce(p_color, ''),
    'art', coalesce(p_art, ''),
    'available', coalesce(p_available, true)
  ));

  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_create_product', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  if exists (select 1 from public.products where public.products.id = v_product_id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_create_product', 'product', v_product_id,
      'CONFLICT', 'PRODUCT_ID_EXISTS'
    );
    return;
  end if;

  insert into public.products (
    id, location_id, kind, category, name_vi, name_en, desc_vi, desc_en,
    price_vnd, station_code, available, image_url, color, art, periods
  )
  values (
    v_product_id, p_location_id, v_kind, v_category, v_name_vi, v_name_en, v_desc_vi, v_desc_en,
    p_price_vnd, v_station_code, coalesce(p_available, true), coalesce(p_image_url, ''),
    coalesce(p_color, ''), coalesce(p_art, ''), v_periods
  )
  returning * into v_product;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product', v_product.id, null,
    jsonb_build_object('product', jsonb_build_object(
      'id', v_product.id,
      'kind', v_product.kind,
      'category', v_product.category,
      'nameVi', v_product.name_vi,
      'nameEn', v_product.name_en,
      'descVi', v_product.desc_vi,
      'descEn', v_product.desc_en,
      'priceVnd', v_product.price_vnd,
      'stationCode', v_product.station_code,
      'available', v_product.available,
      'imageUrl', v_product.image_url,
      'color', v_product.color,
      'art', v_product.art,
      'periods', v_product.periods,
      'updatedAt', v_product.updated_at
    ))
  );

  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_create_product', 'product', v_product.id, v_result,
    jsonb_build_object('kind', v_product.kind, 'category', v_product.category, 'priceVnd', v_product.price_vnd, 'stationCode', v_product.station_code)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_create_product', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'product', v_product.id, jsonb_build_object('reason', 'PRODUCT_CREATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'product', v_product.id, jsonb_build_object('reason', 'PRODUCT_CREATED'));

  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd012_update_product(
  p_location_id text,
  p_product_id text,
  p_kind text,
  p_category text,
  p_name_vi text,
  p_name_en text,
  p_desc_vi text,
  p_desc_en text,
  p_price_vnd integer,
  p_station_code text,
  p_periods text[],
  p_image_url text,
  p_color text,
  p_art text,
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
  v_product public.products;
  v_product_id text := lower(btrim(coalesce(p_product_id, '')));
  v_kind text := upper(btrim(coalesce(p_kind, '')));
  v_category text := lower(btrim(coalesce(p_category, '')));
  v_name_vi text := btrim(coalesce(p_name_vi, ''));
  v_name_en text := btrim(coalesce(p_name_en, ''));
  v_desc_vi text := btrim(coalesce(p_desc_vi, ''));
  v_desc_en text := btrim(coalesce(p_desc_en, ''));
  v_station_code text := upper(btrim(coalesce(p_station_code, '')));
  v_periods text[];
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
      'dd012_update_product', 'product', v_product_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_product_id !~ '^[a-z0-9][a-z0-9-]{0,79}$' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_ID'
    );
    return;
  end if;
  if v_kind not in ('FOOD', 'DRINK') then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_KIND'
    );
    return;
  end if;
  if (v_kind = 'FOOD' and v_category not in ('food-combo', 'food-single', 'food-dessert'))
     or (v_kind = 'DRINK' and v_category not in ('drink-coffee', 'drink-tea', 'drink-signature')) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_CATEGORY'
    );
    return;
  end if;
  if v_name_vi = '' or v_name_en = '' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'PRODUCT_NAME_REQUIRED'
    );
    return;
  end if;
  if p_price_vnd is null or p_price_vnd < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_PRICE'
    );
    return;
  end if;
  if v_station_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_STATION_CODE'
    );
    return;
  end if;
  if coalesce(cardinality(p_periods), 0) = 0
     or exists (
       select 1 from unnest(p_periods) period
       where lower(btrim(coalesce(period, ''))) not in ('morning', 'afternoon', 'evening')
     ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'INVALID_PRODUCT_PERIODS'
    );
    return;
  end if;
  if p_expected_updated_at is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'EXPECTED_UPDATED_AT_REQUIRED'
    );
    return;
  end if;

  select array_agg(period order by period_order)
  into v_periods
  from (
    select distinct
      lower(btrim(period)) as period,
      case lower(btrim(period)) when 'morning' then 1 when 'afternoon' then 2 else 3 end as period_order
    from unnest(p_periods) period
  ) normalized_periods;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'productId', v_product_id,
    'kind', v_kind,
    'category', v_category,
    'nameVi', v_name_vi,
    'nameEn', v_name_en,
    'descVi', v_desc_vi,
    'descEn', v_desc_en,
    'priceVnd', p_price_vnd,
    'stationCode', v_station_code,
    'periods', v_periods,
    'imageUrl', coalesce(p_image_url, ''),
    'color', coalesce(p_color, ''),
    'art', coalesce(p_art, ''),
    'expectedUpdatedAt', p_expected_updated_at
  ));

  v_replay := public.dd008c_replay_command(p_location_id, 'dd012_update_product', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_product
  from public.products
  where public.products.id = v_product_id
    and public.products.location_id = p_location_id
  for update;

  if v_product.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'VALIDATION_ERROR', 'PRODUCT_NOT_FOUND'
    );
    return;
  end if;
  if v_product.updated_at <> p_expected_updated_at then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_update_product', 'product', v_product_id,
      'CONFLICT', 'STALE_PRODUCT',
      jsonb_build_object('currentUpdatedAt', v_product.updated_at)
    );
    return;
  end if;

  update public.products
  set kind = v_kind,
      category = v_category,
      name_vi = v_name_vi,
      name_en = v_name_en,
      desc_vi = v_desc_vi,
      desc_en = v_desc_en,
      price_vnd = p_price_vnd,
      station_code = v_station_code,
      periods = v_periods,
      image_url = coalesce(p_image_url, ''),
      color = coalesce(p_color, ''),
      art = coalesce(p_art, ''),
      updated_at = clock_timestamp()
  where public.products.id = v_product_id
    and public.products.location_id = p_location_id
  returning * into v_product;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product', v_product.id, null,
    jsonb_build_object('product', jsonb_build_object(
      'id', v_product.id,
      'kind', v_product.kind,
      'category', v_product.category,
      'nameVi', v_product.name_vi,
      'nameEn', v_product.name_en,
      'descVi', v_product.desc_vi,
      'descEn', v_product.desc_en,
      'priceVnd', v_product.price_vnd,
      'stationCode', v_product.station_code,
      'available', v_product.available,
      'imageUrl', v_product.image_url,
      'color', v_product.color,
      'art', v_product.art,
      'periods', v_product.periods,
      'updatedAt', v_product.updated_at
    ))
  );

  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_update_product', 'product', v_product.id, v_result,
    jsonb_build_object('kind', v_product.kind, 'category', v_product.category, 'priceVnd', v_product.price_vnd, 'stationCode', v_product.station_code)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_update_product', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'product', v_product.id, jsonb_build_object('reason', 'PRODUCT_UPDATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'product', v_product.id, jsonb_build_object('reason', 'PRODUCT_UPDATED'));

  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd012_create_product(text, text, text, text, text, text, text, text, integer, text, text[], text, text, text, boolean, text, text, text) from public, anon;
revoke all on function public.dd012_update_product(text, text, text, text, text, text, text, text, integer, text, text[], text, text, text, timestamptz, text, text, text) from public, anon;

grant execute on function public.dd012_create_product(text, text, text, text, text, text, text, text, integer, text, text[], text, text, text, boolean, text, text, text) to authenticated, service_role;
grant execute on function public.dd012_update_product(text, text, text, text, text, text, text, text, integer, text, text[], text, text, text, timestamptz, text, text, text) to authenticated, service_role;
