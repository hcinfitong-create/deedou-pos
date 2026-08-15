-- DD-008D server-authoritative admin menu availability cutover.
-- Removes the need for localStorage availability writes in production mode.

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
      'priceVnd', public.products.price_vnd,
      'available', public.products.available,
      'periods', public.products.periods,
      'updatedAt', public.products.updated_at
    ) order by public.products.kind, public.products.category, public.products.name_vi, public.products.id), '[]'::jsonb)
  ) into v_payload
  from public.products
  where public.products.location_id = p_location_id;

  return query select * from public.dd008c_success('admin_menu', p_location_id, null, v_payload);
end
$$;

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
    p_location_id,
    'dd008d_set_product_availability',
    p_idempotency_key,
    v_hash
  );
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_product
  from public.products
  where public.products.id = p_product_id
    and public.products.location_id = p_location_id
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
      'CONFLICT', 'STALE_PRODUCT',
      jsonb_build_object('currentUpdatedAt', v_product.updated_at)
    );
    return;
  end if;

  if v_product.available is not distinct from p_available then
    v_result := public.dd008c_result_json(
      true, 'OK', 'ALREADY_SET', 'product', p_product_id, null,
      jsonb_build_object('product', jsonb_build_object(
        'id', v_product.id,
        'available', v_product.available,
        'updatedAt', v_product.updated_at
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
  set available = p_available,
      updated_at = now()
  where public.products.id = p_product_id
    and public.products.location_id = p_location_id
  returning * into v_product;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'product', p_product_id, null,
    jsonb_build_object('product', jsonb_build_object(
      'id', v_product.id,
      'available', v_product.available,
      'updatedAt', v_product.updated_at
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

  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd008d_get_admin_menu_snapshot(text, text, text) from public;
revoke all on function public.dd008d_set_product_availability(text, text, boolean, timestamptz, text, text, text) from public;

grant execute on function public.dd008d_get_admin_menu_snapshot(text, text, text) to authenticated;
grant execute on function public.dd008d_set_product_availability(text, text, boolean, timestamptz, text, text, text) to authenticated;
