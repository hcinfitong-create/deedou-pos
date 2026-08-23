-- DD-011B: make the sole-Owner invariant explicit in role revocation.

create or replace function public.dd011_revoke_staff_role_at_location(
  p_target_staff_profile_id text,
  p_location_id text,
  p_role_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner record;
begin
  if p_role_id = 'OWNER' and public.dd011b_target_is_owner(p_target_staff_profile_id) then
    return query select false, 'SOLE_OWNER_PROTECTED';
    return;
  end if;

  select * into v_owner
  from public.dd011b_owner_mutation_authorized(
    p_location_id,
    p_current_workstation_mode,
    p_current_device_credential,
    'staff.manage'
  )
  limit 1;

  if v_owner.ok is distinct from true then
    return query select false, v_owner.reason;
    return;
  end if;

  update public.staff_role_assignments sra
  set active = false,
      assigned_at = now()
  where sra.staff_profile_id = p_target_staff_profile_id
    and sra.location_id = p_location_id
    and sra.role_id = p_role_id
    and sra.active = true;

  if not found then
    return query select false, 'ROLE_ASSIGNMENT_NOT_FOUND';
    return;
  end if;

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_owner.staff_profile_id,
    v_owner.staff_profile_id,
    v_owner.device_id,
    'dd011_revoke_staff_role_at_location',
    'staff_role',
    p_target_staff_profile_id || ':' || p_role_id,
    'REVOKED',
    jsonb_build_object('roleId', p_role_id, 'ownerAuthoritative', true)
  );

  return query select true, '';
end
$$;
