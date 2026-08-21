-- DD-012B assignment canonicalization hardening.
-- The server, not the browser, owns product/group identifier normalization.

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
  v_product_id text := lower(btrim(coalesce(p_product_id, '')));
  v_modifier_group_id text := lower(btrim(coalesce(p_modifier_group_id, '')));
  v_target_id text := v_product_id || ':' || v_modifier_group_id;
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
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if v_product_id = '' or v_modifier_group_id = '' or p_display_order is null or p_display_order < 0 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'VALIDATION_ERROR', 'INVALID_ASSIGNMENT'
    );
    return;
  end if;
  if not exists (
    select 1 from public.products where id = v_product_id and location_id = p_location_id
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'VALIDATION_ERROR', 'PRODUCT_NOT_FOUND'
    );
    return;
  end if;
  select * into v_group
  from public.modifier_groups
  where id = v_modifier_group_id and location_id = p_location_id;
  if v_group.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id,
      'VALIDATION_ERROR', 'MODIFIER_GROUP_NOT_FOUND'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id,
    'productId', v_product_id,
    'modifierGroupId', v_modifier_group_id,
    'assigned', coalesce(p_assigned, false),
    'displayOrder', p_display_order,
    'expectedUpdatedAt', p_expected_updated_at
  ));
  v_replay := public.dd008c_replay_command(
    p_location_id, 'dd012_set_product_modifier_group_assignment', p_idempotency_key, v_hash
  );
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_assignment
  from public.product_modifier_groups
  where product_id = v_product_id and modifier_group_id = v_modifier_group_id
  for update;

  if coalesce(p_assigned, false) = true then
    select count(*), count(*) filter (where available = true)
    into v_total_options, v_available_options
    from public.modifier_options
    where modifier_group_id = v_modifier_group_id;

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
          'CONFLICT', 'STALE_PRODUCT_MODIFIER_GROUP',
          jsonb_build_object('currentUpdatedAt', v_assignment.updated_at)
        );
        return;
      end if;
      update public.product_modifier_groups
      set display_order = p_display_order,
          updated_at = now()
      where product_id = v_product_id and modifier_group_id = v_modifier_group_id
      returning * into v_assignment;
    else
      insert into public.product_modifier_groups (
        product_id, modifier_group_id, display_order, updated_at
      ) values (
        v_product_id, v_modifier_group_id, p_display_order, now()
      ) returning * into v_assignment;
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
          'CONFLICT', 'STALE_PRODUCT_MODIFIER_GROUP',
          jsonb_build_object('currentUpdatedAt', v_assignment.updated_at)
        );
        return;
      end if;
      delete from public.product_modifier_groups
      where product_id = v_product_id and modifier_group_id = v_modifier_group_id;
      v_result := public.dd008c_result_json(
        true, 'OK', '', 'product_modifier_group', v_target_id, null,
        jsonb_build_object('assigned', false)
      );
    end if;
  end if;

  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd012_set_product_modifier_group_assignment', 'product_modifier_group', v_target_id, v_result,
    jsonb_build_object(
      'productId', v_product_id,
      'modifierGroupId', v_modifier_group_id,
      'assigned', coalesce(p_assigned, false)
    )
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd012_set_product_modifier_group_assignment', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'admin', 'product_modifier_group', v_target_id,
    jsonb_build_object('reason', 'PRODUCT_MODIFIER_GROUP_CHANGED')
  );
  perform public.dd008c_emit_refresh(
    p_location_id, 'ops', 'product_modifier_group', v_target_id,
    jsonb_build_object('reason', 'PRODUCT_MODIFIER_GROUP_CHANGED')
  );
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd012_set_product_modifier_group_assignment(text, text, text, boolean, integer, timestamptz, text, text, text) from public, anon;
grant execute on function public.dd012_set_product_modifier_group_assignment(text, text, text, boolean, integer, timestamptz, text, text, text) to authenticated, service_role;
