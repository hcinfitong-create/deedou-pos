-- DD-011 Production identity and workstation security hardening.
-- Adds AAL2-gated privileged administration, staff/device admin RPCs,
-- device rotation/usage telemetry, and keeps browser writes server-authoritative.

alter table public.workstation_devices
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_used_by_staff_profile_id text references public.staff_profiles(id) on delete set null,
  add column if not exists use_count bigint not null default 0,
  add column if not exists rotated_at timestamptz;

alter table public.workstation_devices
  drop constraint if exists workstation_devices_use_count_check;

alter table public.workstation_devices
  add constraint workstation_devices_use_count_check check (use_count >= 0);

create index if not exists workstation_devices_location_last_seen_idx
on public.workstation_devices(location_id, active, last_seen_at desc nulls last);

create or replace function public.dd011_current_aal()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1'))
$$;

create or replace function public.dd011_has_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.dd011_current_aal() = 'aal2'
$$;

create or replace function public.dd011_target_within_actor_ceiling(
  p_target_staff_profile_id text,
  p_location_id text
)
returns table (
  ok boolean,
  reason text,
  missing_permissions text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_staff_id text := public.current_staff_id();
  v_missing_permissions text[] := array[]::text[];
begin
  if v_actor_staff_id is null or public.is_active_staff() = false then
    return query select false, 'STAFF_INACTIVE', v_missing_permissions;
    return;
  end if;

  if p_target_staff_profile_id = v_actor_staff_id then
    return query select false, 'SELF_ESCALATION_BLOCKED', v_missing_permissions;
    return;
  end if;

  if not exists (
    select 1
    from public.staff_profiles
    where public.staff_profiles.id = p_target_staff_profile_id
  ) then
    return query select false, 'TARGET_STAFF_NOT_FOUND', v_missing_permissions;
    return;
  end if;

  select coalesce(array_agg(distinct public.permissions.permission_key order by public.permissions.permission_key), array[]::text[])
  into v_missing_permissions
  from public.staff_role_assignments
  join public.role_permissions
    on public.role_permissions.role_id = public.staff_role_assignments.role_id
  join public.permissions
    on public.permissions.id = public.role_permissions.permission_id
  where public.staff_role_assignments.staff_profile_id = p_target_staff_profile_id
    and public.staff_role_assignments.location_id = p_location_id
    and public.staff_role_assignments.active = true
    and public.has_permission(p_location_id, public.permissions.permission_key) = false;

  if cardinality(v_missing_permissions) > 0 then
    return query select false, 'PRIVILEGE_CEILING_EXCEEDED', v_missing_permissions;
    return;
  end if;

  return query select true, '', v_missing_permissions;
end
$$;

create or replace function public.dd011_list_staff_admin(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  staff_profile_id text,
  email text,
  display_name text,
  staff_active boolean,
  location_active boolean,
  roles text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.read', p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return;
  end if;

  return query
  select
    public.staff_profiles.id,
    coalesce(auth.users.email, ''),
    public.staff_profiles.display_name,
    public.staff_profiles.active,
    coalesce(public.staff_location_assignments.active, false),
    coalesce(
      array_remove(array_agg(distinct public.roles.role_key order by public.roles.role_key), null),
      array[]::text[]
    )
  from public.staff_profiles
  join auth.users
    on auth.users.id = public.staff_profiles.auth_user_id
  left join public.staff_location_assignments
    on public.staff_location_assignments.staff_profile_id = public.staff_profiles.id
   and public.staff_location_assignments.location_id = p_location_id
  left join public.staff_role_assignments
    on public.staff_role_assignments.staff_profile_id = public.staff_profiles.id
   and public.staff_role_assignments.location_id = p_location_id
   and public.staff_role_assignments.active = true
  left join public.roles
    on public.roles.id = public.staff_role_assignments.role_id
  where public.staff_location_assignments.staff_profile_id is not null
  group by
    public.staff_profiles.id,
    auth.users.email,
    public.staff_profiles.display_name,
    public.staff_profiles.active,
    public.staff_location_assignments.active
  order by public.staff_profiles.display_name, public.staff_profiles.id;
end
$$;

create or replace function public.dd011_list_roles_admin(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  role_id text,
  role_name text,
  permissions text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.read', p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return;
  end if;

  return query
  select
    public.roles.id,
    public.roles.name,
    coalesce(
      array_remove(array_agg(public.permissions.permission_key order by public.permissions.permission_key), null),
      array[]::text[]
    )
  from public.roles
  left join public.role_permissions
    on public.role_permissions.role_id = public.roles.id
  left join public.permissions
    on public.permissions.id = public.role_permissions.permission_id
  group by public.roles.id, public.roles.name
  order by public.roles.id;
end
$$;

create or replace function public.dd011_list_devices_admin(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  device_id text,
  label text,
  mode text,
  active boolean,
  registered_by_staff_profile_id text,
  created_at timestamptz,
  rotated_at timestamptz,
  last_seen_at timestamptz,
  last_used_by_staff_profile_id text,
  use_count bigint,
  revoked_at timestamptz,
  is_current_device boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'devices.manage', p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return;
  end if;

  return query
  select
    public.workstation_devices.id,
    public.workstation_devices.label,
    public.workstation_devices.mode,
    public.workstation_devices.active,
    public.workstation_devices.registered_by_staff_profile_id,
    public.workstation_devices.created_at,
    public.workstation_devices.rotated_at,
    public.workstation_devices.last_seen_at,
    public.workstation_devices.last_used_by_staff_profile_id,
    public.workstation_devices.use_count,
    public.workstation_devices.revoked_at,
    public.workstation_devices.id = v_authz.device_id
  from public.workstation_devices
  where public.workstation_devices.location_id = p_location_id
  order by public.workstation_devices.active desc, public.workstation_devices.created_at desc, public.workstation_devices.id;
end
$$;

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
  on conflict (staff_profile_id, location_id) do update
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

create or replace function public.dd011_set_staff_active(
  p_location_id text,
  p_target_staff_profile_id text,
  p_active boolean,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_ceiling record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED');
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED';
    return;
  end if;

  select * into v_ceiling
  from public.dd011_target_within_actor_ceiling(p_target_staff_profile_id, p_location_id)
  limit 1;

  if v_ceiling.ok is distinct from true then
    return query select false, coalesce(v_ceiling.reason, 'PRIVILEGE_CEILING_EXCEEDED');
    return;
  end if;

  update public.staff_profiles
  set active = p_active,
      updated_at = now()
  where public.staff_profiles.id = p_target_staff_profile_id;

  if not found then
    return query select false, 'TARGET_STAFF_NOT_FOUND';
    return;
  end if;

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_authz.staff_profile_id,
    v_authz.staff_profile_id,
    v_authz.device_id,
    'dd011_set_staff_active',
    'staff_profile',
    p_target_staff_profile_id,
    case when p_active then 'ACTIVATED' else 'DEACTIVATED' end,
    '{}'::jsonb
  );

  return query select true, '';
end
$$;

create or replace function public.dd011_set_staff_location_active(
  p_location_id text,
  p_target_staff_profile_id text,
  p_active boolean,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_ceiling record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED');
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED';
    return;
  end if;

  select * into v_ceiling
  from public.dd011_target_within_actor_ceiling(p_target_staff_profile_id, p_location_id)
  limit 1;

  if v_ceiling.ok is distinct from true then
    return query select false, coalesce(v_ceiling.reason, 'PRIVILEGE_CEILING_EXCEEDED');
    return;
  end if;

  insert into public.staff_location_assignments (staff_profile_id, location_id, active)
  values (p_target_staff_profile_id, p_location_id, p_active)
  on conflict (staff_profile_id, location_id) do update
  set active = excluded.active,
      assigned_at = now();

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_authz.staff_profile_id,
    v_authz.staff_profile_id,
    v_authz.device_id,
    'dd011_set_staff_location_active',
    'staff_profile',
    p_target_staff_profile_id,
    case when p_active then 'LOCATION_ACTIVATED' else 'LOCATION_DEACTIVATED' end,
    '{}'::jsonb
  );

  return query select true, '';
end
$$;

create or replace function public.assign_staff_to_location(
  p_target_staff_profile_id text,
  p_location_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed record;
begin
  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED';
    return;
  end if;

  select * into v_allowed
  from public.can_assign_staff_location(p_target_staff_profile_id, p_location_id, p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_allowed.ok is distinct from true then
    return query select false, coalesce(v_allowed.reason, 'LOCATION_DENIED');
    return;
  end if;

  insert into public.staff_location_assignments (staff_profile_id, location_id, active)
  values (p_target_staff_profile_id, p_location_id, true)
  on conflict (staff_profile_id, location_id) do update
  set active = true,
      assigned_at = now();

  return query select true, '';
end
$$;

create or replace function public.assign_staff_role_at_location(
  p_target_staff_profile_id text,
  p_location_id text,
  p_role_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed record;
  v_authz record;
begin
  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED';
    return;
  end if;

  select * into v_allowed
  from public.can_grant_role_at_location(p_target_staff_profile_id, p_location_id, p_role_id, p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_allowed.ok is distinct from true then
    return query select false, coalesce(v_allowed.reason, 'PRIVILEGE_CEILING_EXCEEDED');
    return;
  end if;

  insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
  values (p_target_staff_profile_id, p_location_id, p_role_id, true)
  on conflict (staff_profile_id, location_id, role_id) do update
  set active = true,
      assigned_at = now();

  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    coalesce(v_authz.staff_profile_id, ''),
    coalesce(v_authz.staff_profile_id, ''),
    coalesce(v_authz.device_id, ''),
    'assign_staff_role_at_location',
    'staff_role',
    p_target_staff_profile_id || ':' || p_role_id,
    'ASSIGNED',
    jsonb_build_object('roleId', p_role_id)
  );

  return query select true, '';
end
$$;

create or replace function public.dd011_revoke_staff_role_at_location(
  p_target_staff_profile_id text,
  p_location_id text,
  p_role_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed record;
  v_authz record;
begin
  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED';
    return;
  end if;

  select * into v_allowed
  from public.can_grant_role_at_location(p_target_staff_profile_id, p_location_id, p_role_id, p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_allowed.ok is distinct from true then
    return query select false, coalesce(v_allowed.reason, 'PRIVILEGE_CEILING_EXCEEDED');
    return;
  end if;

  update public.staff_role_assignments
  set active = false,
      assigned_at = now()
  where public.staff_role_assignments.staff_profile_id = p_target_staff_profile_id
    and public.staff_role_assignments.location_id = p_location_id
    and public.staff_role_assignments.role_id = p_role_id
    and public.staff_role_assignments.active = true;

  if not found then
    return query select false, 'ROLE_ASSIGNMENT_NOT_FOUND';
    return;
  end if;

  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'staff.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    coalesce(v_authz.staff_profile_id, ''),
    coalesce(v_authz.staff_profile_id, ''),
    coalesce(v_authz.device_id, ''),
    'dd011_revoke_staff_role_at_location',
    'staff_role',
    p_target_staff_profile_id || ':' || p_role_id,
    'REVOKED',
    jsonb_build_object('roleId', p_role_id)
  );

  return query select true, '';
end
$$;

create or replace function public.register_workstation_device(
  p_location_id text,
  p_label text,
  p_mode text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text, device_id text, device_credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device_id text;
  v_device_credential text;
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'devices.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED'), ''::text, ''::text;
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED', ''::text, ''::text;
    return;
  end if;

  if public.workstation_mode_allows_permission(p_mode, 'orders.read') = false
     and p_mode <> 'ADMIN' then
    return query select false, 'DEVICE_MODE_DENIED', ''::text, ''::text;
    return;
  end if;

  v_device_id := public.generate_device_id();
  v_device_credential := public.generate_device_credential();

  insert into public.workstation_devices (
    id,
    location_id,
    label,
    mode,
    credential_hash,
    active,
    registered_by_staff_profile_id,
    last_seen_at,
    last_used_by_staff_profile_id,
    use_count,
    revoked_at
  )
  values (
    v_device_id,
    p_location_id,
    coalesce(nullif(btrim(p_label), ''), p_mode),
    p_mode,
    public.hash_device_credential(v_device_credential),
    true,
    public.current_staff_id(),
    null,
    null,
    0,
    null
  );

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_authz.staff_profile_id,
    v_authz.staff_profile_id,
    v_authz.device_id,
    'register_workstation_device',
    'workstation_device',
    v_device_id,
    'REGISTERED',
    jsonb_build_object('mode', p_mode)
  );

  return query select true, '', v_device_id, v_device_credential;
end
$$;

create or replace function public.revoke_workstation_device(
  p_location_id text,
  p_device_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'devices.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED');
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED';
    return;
  end if;

  if p_device_id = v_authz.device_id then
    return query select false, 'CURRENT_DEVICE_REVOKE_BLOCKED';
    return;
  end if;

  update public.workstation_devices
  set active = false,
      revoked_at = now()
  where public.workstation_devices.id = p_device_id
    and public.workstation_devices.location_id = p_location_id
    and public.workstation_devices.active = true;

  if not found then
    return query select false, 'DEVICE_NOT_FOUND';
    return;
  end if;

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_authz.staff_profile_id,
    v_authz.staff_profile_id,
    v_authz.device_id,
    'revoke_workstation_device',
    'workstation_device',
    p_device_id,
    'REVOKED',
    '{}'::jsonb
  );

  return query select true, '';
end
$$;

create or replace function public.dd011_rotate_workstation_device(
  p_location_id text,
  p_device_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table (ok boolean, reason text, device_id text, device_credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authz record;
  v_new_credential text;
begin
  select * into v_authz
  from public.authorize_staff_access(p_location_id, 'devices.manage', p_current_workstation_mode, p_current_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED'), ''::text, ''::text;
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED', ''::text, ''::text;
    return;
  end if;

  v_new_credential := public.generate_device_credential();

  update public.workstation_devices
  set credential_hash = public.hash_device_credential(v_new_credential),
      active = true,
      rotated_at = now(),
      revoked_at = null,
      last_seen_at = null,
      last_used_by_staff_profile_id = null,
      use_count = 0
  where public.workstation_devices.id = p_device_id
    and public.workstation_devices.location_id = p_location_id;

  if not found then
    return query select false, 'DEVICE_NOT_FOUND', ''::text, ''::text;
    return;
  end if;

  perform public.dd008c_write_audit(
    p_location_id,
    'STAFF',
    v_authz.staff_profile_id,
    v_authz.staff_profile_id,
    v_authz.device_id,
    'dd011_rotate_workstation_device',
    'workstation_device',
    p_device_id,
    'ROTATED',
    '{}'::jsonb
  );

  return query select true, '', p_device_id, v_new_credential;
end
$$;

create or replace function public.dd011_touch_current_device(
  p_location_id text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (ok boolean, reason text, device_id text, last_seen_at timestamptz, use_count bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context record;
  v_seen_at timestamptz := now();
  v_use_count bigint;
begin
  select * into v_context
  from public.resolve_staff_workstation_context(p_location_id, p_workstation_mode, p_device_credential)
  limit 1;

  if v_context.ok is distinct from true then
    return query select false, coalesce(v_context.reason, 'DEVICE_UNREGISTERED'), ''::text, null::timestamptz, 0::bigint;
    return;
  end if;

  update public.workstation_devices
  set last_seen_at = v_seen_at,
      last_used_by_staff_profile_id = v_context.staff_profile_id,
      use_count = public.workstation_devices.use_count + 1
  where public.workstation_devices.id = v_context.device_id
    and public.workstation_devices.location_id = p_location_id
    and public.workstation_devices.active = true
  returning public.workstation_devices.use_count into v_use_count;

  if not found then
    return query select false, 'DEVICE_UNREGISTERED', ''::text, null::timestamptz, 0::bigint;
    return;
  end if;

  return query select true, '', v_context.device_id, v_seen_at, v_use_count;
end
$$;

-- Internal helpers are not direct browser APIs.
revoke all on function public.dd011_current_aal() from public, anon, authenticated;
revoke all on function public.dd011_has_aal2() from public, anon, authenticated;
revoke all on function public.dd011_target_within_actor_ceiling(text, text) from public, anon, authenticated;

-- Authenticated-only security/admin RPC surface.
revoke all on function public.dd011_list_staff_admin(text, text, text) from public, anon;
revoke all on function public.dd011_list_roles_admin(text, text, text) from public, anon;
revoke all on function public.dd011_list_devices_admin(text, text, text) from public, anon;
revoke all on function public.dd011_link_staff_by_email(text, text, text, text, text) from public, anon;
revoke all on function public.dd011_set_staff_active(text, text, boolean, text, text) from public, anon;
revoke all on function public.dd011_set_staff_location_active(text, text, boolean, text, text) from public, anon;
revoke all on function public.dd011_revoke_staff_role_at_location(text, text, text, text, text) from public, anon;
revoke all on function public.dd011_rotate_workstation_device(text, text, text, text) from public, anon;
revoke all on function public.dd011_touch_current_device(text, text, text) from public, anon;

revoke all on function public.assign_staff_to_location(text, text, text, text) from public, anon;
revoke all on function public.assign_staff_role_at_location(text, text, text, text, text) from public, anon;
revoke all on function public.register_workstation_device(text, text, text, text, text) from public, anon;
revoke all on function public.revoke_workstation_device(text, text, text, text) from public, anon;

grant execute on function public.dd011_list_staff_admin(text, text, text) to authenticated, service_role;
grant execute on function public.dd011_list_roles_admin(text, text, text) to authenticated, service_role;
grant execute on function public.dd011_list_devices_admin(text, text, text) to authenticated, service_role;
grant execute on function public.dd011_link_staff_by_email(text, text, text, text, text) to authenticated, service_role;
grant execute on function public.dd011_set_staff_active(text, text, boolean, text, text) to authenticated, service_role;
grant execute on function public.dd011_set_staff_location_active(text, text, boolean, text, text) to authenticated, service_role;
grant execute on function public.dd011_revoke_staff_role_at_location(text, text, text, text, text) to authenticated, service_role;
grant execute on function public.dd011_rotate_workstation_device(text, text, text, text) to authenticated, service_role;
grant execute on function public.dd011_touch_current_device(text, text, text) to authenticated, service_role;

grant execute on function public.assign_staff_to_location(text, text, text, text) to authenticated, service_role;
grant execute on function public.assign_staff_role_at_location(text, text, text, text, text) to authenticated, service_role;
grant execute on function public.register_workstation_device(text, text, text, text, text) to authenticated, service_role;
grant execute on function public.revoke_workstation_device(text, text, text, text) to authenticated, service_role;
