-- DD-011 follow-up: disambiguate the staff/location upsert inside
-- dd011_link_staff_by_email. The function RETURNS TABLE exposes an output
-- variable named staff_profile_id, so a column-list ON CONFLICT target with
-- the same identifier is ambiguous in PL/pgSQL. Target the existing primary
-- key constraint explicitly without changing authorization or AAL2 semantics.

create or replace function public.dd011_link_staff_by_email(
  p_location_id text,
  p_email text,
  p_display_name text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (
  ok boolean,
  reason text,
  staff_profile_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_auth_user_id uuid;
  v_staff_id text;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED'), ''::text;
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED', ''::text;
    return;
  end if;

  select auth.users.id
  into v_auth_user_id
  from auth.users
  where lower(auth.users.email) = lower(btrim(coalesce(p_email, '')))
  limit 1;

  if v_auth_user_id is null then
    return query select false, 'AUTH_USER_NOT_FOUND', ''::text;
    return;
  end if;

  if v_auth_user_id = auth.uid() then
    return query select false, 'SELF_ESCALATION_BLOCKED', ''::text;
    return;
  end if;

  select public.staff_profiles.id
  into v_staff_id
  from public.staff_profiles
  where public.staff_profiles.auth_user_id = v_auth_user_id
  limit 1;

  if v_staff_id is null then
    v_staff_id := 'STAFF-' || replace(extensions.gen_random_uuid()::text, '-', '');
    insert into public.staff_profiles (id, auth_user_id, display_name, active)
    values (
      v_staff_id,
      v_auth_user_id,
      coalesce(nullif(btrim(p_display_name), ''), split_part(coalesce(p_email, ''), '@', 1), 'Staff'),
      true
    );
  else
    update public.staff_profiles
    set display_name = coalesce(nullif(btrim(p_display_name), ''), public.staff_profiles.display_name),
        active = true,
        updated_at = now()
    where public.staff_profiles.id = v_staff_id;
  end if;

  insert into public.staff_location_assignments (staff_profile_id, location_id, active)
  values (v_staff_id, p_location_id, true)
  on conflict on constraint staff_location_assignments_pkey do update
  set active = true,
      assigned_at = now();

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_authz.staff_profile_id,
    v_authz.staff_profile_id,
    v_authz.device_id,
    'dd011_link_staff_by_email',
    'staff_profile',
    v_staff_id,
    'OK',
    jsonb_build_object('email', lower(btrim(coalesce(p_email, ''))))
  );

  return query select true, '', v_staff_id;
end
$$;
