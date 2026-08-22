-- DD-011B: Owner-authoritative staff lifecycle and backend device-session cutover.
-- This migration intentionally defines the lifecycle helpers only. The final
-- activation-completion function and compatibility overrides live in 63000.

create table if not exists public.dd011b_security_policy (
  singleton boolean primary key default true check (singleton = true),
  backend_device_sessions_required boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.dd011b_security_policy(singleton, backend_device_sessions_required)
values (true, false)
on conflict (singleton) do nothing;

alter table public.dd011b_security_policy enable row level security;
revoke all on public.dd011b_security_policy from public, anon, authenticated;
grant select, insert, update, delete on public.dd011b_security_policy to service_role;

create or replace function public.dd011b_target_is_owner(p_staff_profile_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_role_assignments sra
    join public.staff_profiles sp on sp.id = sra.staff_profile_id
    join public.staff_location_assignments sla
      on sla.staff_profile_id = sra.staff_profile_id
     and sla.location_id = sra.location_id
     and sla.active = true
    where sra.staff_profile_id = p_staff_profile_id
      and sra.role_id = 'OWNER'
      and sra.active = true
      and sp.active = true
  )
$$;

create or replace function public.dd011b_owner_context()
returns table(ok boolean, reason text, staff_profile_id text, location_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff_id text;
  v_location_id text;
begin
  select sp.id, sra.location_id
  into v_staff_id, v_location_id
  from public.staff_profiles sp
  join public.staff_role_assignments sra
    on sra.staff_profile_id = sp.id
   and sra.role_id = 'OWNER'
   and sra.active = true
  join public.staff_location_assignments sla
    on sla.staff_profile_id = sp.id
   and sla.location_id = sra.location_id
   and sla.active = true
  where sp.auth_user_id = auth.uid()
    and sp.active = true
  limit 1;

  if v_staff_id is null then
    return query select false, 'OWNER_REQUIRED', ''::text, ''::text;
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED', v_staff_id, v_location_id;
    return;
  end if;

  return query select true, '', v_staff_id, v_location_id;
end
$$;

-- Backend-session enforcement is staged. It is enabled only after the sole
-- Owner has enrolled MFA and bootstrapped an HttpOnly device session.
create or replace function public.authorize_staff_access(
  p_location_id text,
  p_permission_key text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table(
  ok boolean,
  reason text,
  staff_profile_id text,
  location_id text,
  device_id text,
  workstation_mode text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_context record;
  v_sessions_required boolean := false;
begin
  select * into v_context
  from public.resolve_staff_workstation_context(
    p_location_id, p_workstation_mode, p_device_credential
  )
  limit 1;

  if v_context.ok is distinct from true then
    return query select
      false,
      coalesce(v_context.reason, 'DEVICE_UNREGISTERED'),
      coalesce(v_context.staff_profile_id, ''),
      p_location_id,
      coalesce(v_context.device_id, ''),
      coalesce(v_context.workstation_mode, '');
    return;
  end if;

  if public.dd011b_is_owner() and public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED', v_context.staff_profile_id,
      p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  select coalesce(backend_device_sessions_required, false)
  into v_sessions_required
  from public.dd011b_security_policy
  where singleton = true;

  if v_sessions_required and not exists (
    select 1
    from public.workstation_device_sessions s
    where s.device_id = v_context.device_id
      and s.auth_user_id = auth.uid()
      and s.active = true
      and s.expires_at > now()
  ) then
    return query select false, 'DEVICE_SESSION_REQUIRED', v_context.staff_profile_id,
      p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  if public.has_permission(p_location_id, p_permission_key) = false then
    return query select false, 'PERMISSION_DENIED', v_context.staff_profile_id,
      p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  if public.workstation_mode_allows_permission(v_context.workstation_mode, p_permission_key) = false then
    return query select false, 'DEVICE_MODE_DENIED', v_context.staff_profile_id,
      p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  return query select true, ''::text, v_context.staff_profile_id,
    p_location_id, v_context.device_id, v_context.workstation_mode;
end
$$;

create or replace function public.dd011b_owner_mutation_authorized(
  p_location_id text,
  p_workstation_mode text,
  p_device_credential text,
  p_permission_key text default 'staff.manage'
)
returns table(ok boolean, reason text, staff_profile_id text, device_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authz record;
begin
  select * into v_authz
  from public.authorize_staff_access(
    p_location_id, p_permission_key, p_workstation_mode, p_device_credential
  )
  limit 1;

  if v_authz.ok is distinct from true then
    return query select false, coalesce(v_authz.reason, 'PERMISSION_DENIED'),
      coalesce(v_authz.staff_profile_id, ''), coalesce(v_authz.device_id, '');
    return;
  end if;

  if public.dd011b_is_owner() = false then
    return query select false, 'OWNER_REQUIRED', v_authz.staff_profile_id, v_authz.device_id;
    return;
  end if;

  if public.dd011_has_aal2() = false then
    return query select false, 'MFA_REQUIRED', v_authz.staff_profile_id, v_authz.device_id;
    return;
  end if;

  return query select true, '', v_authz.staff_profile_id, v_authz.device_id;
end
$$;

-- Browser-callable role/location/device mutations are overridden in 63000. The
-- service helpers below are only callable with service_role from the same-origin
-- backend. Browser clients cannot read their underlying tables.
create or replace function public.dd011b_service_create_pending_staff(
  p_owner_auth_user_id uuid,
  p_target_auth_user_id uuid,
  p_username text,
  p_display_name text,
  p_location_id text,
  p_role_id text
)
returns table(ok boolean, reason text, staff_profile_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_staff_id text;
  v_staff_id text;
  v_username text := lower(btrim(coalesce(p_username, '')));
begin
  select sp.id into v_owner_staff_id
  from public.staff_profiles sp
  join public.staff_role_assignments sra
    on sra.staff_profile_id = sp.id
   and sra.role_id = 'OWNER'
   and sra.active = true
  join public.staff_location_assignments sla
    on sla.staff_profile_id = sp.id
   and sla.location_id = p_location_id
   and sla.active = true
  where sp.auth_user_id = p_owner_auth_user_id
    and sp.active = true
  limit 1;

  if v_owner_staff_id is null then
    return query select false, 'OWNER_REQUIRED', ''::text;
    return;
  end if;

  if v_username !~ '^[a-z0-9][a-z0-9_-]{2,31}$'
     or btrim(coalesce(p_display_name, '')) = '' then
    return query select false, 'VALIDATION_ERROR', ''::text;
    return;
  end if;

  if p_role_id = 'OWNER' then
    return query select false, 'SINGLE_OWNER_ENFORCED', ''::text;
    return;
  end if;

  if not exists(select 1 from auth.users where id = p_target_auth_user_id) then
    return query select false, 'AUTH_USER_NOT_FOUND', ''::text;
    return;
  end if;

  if not exists(select 1 from public.locations where id = p_location_id) then
    return query select false, 'LOCATION_NOT_FOUND', ''::text;
    return;
  end if;

  if not exists(select 1 from public.roles where id = p_role_id) then
    return query select false, 'ROLE_NOT_FOUND', ''::text;
    return;
  end if;

  if exists(select 1 from public.staff_profiles where auth_user_id = p_target_auth_user_id) then
    return query select false, 'STAFF_ALREADY_LINKED', ''::text;
    return;
  end if;

  if exists(select 1 from public.staff_profiles where lower(username) = v_username) then
    return query select false, 'USERNAME_EXISTS', ''::text;
    return;
  end if;

  v_staff_id := 'STF-' || replace(extensions.gen_random_uuid()::text, '-', '');

  insert into public.staff_profiles(
    id, auth_user_id, username, display_name, active, provisioning_status
  ) values (
    v_staff_id, p_target_auth_user_id, v_username,
    btrim(p_display_name), false, 'PENDING_FIRST_LOGIN'
  );

  insert into public.staff_location_assignments(staff_profile_id, location_id, active)
  values (v_staff_id, p_location_id, false);

  insert into public.staff_role_assignments(staff_profile_id, location_id, role_id, active)
  values (v_staff_id, p_location_id, p_role_id, false);

  perform public.dd008c_write_audit(
    p_location_id, 'STAFF', v_owner_staff_id, v_owner_staff_id, '',
    'dd011b_service_create_pending_staff', 'staff_profile', v_staff_id, 'PENDING',
    jsonb_build_object('username', v_username, 'roleId', p_role_id)
  );

  return query select true, '', v_staff_id;
exception
  when unique_violation then
    return query select false, 'USERNAME_EXISTS', ''::text;
end
$$;

create or replace function public.dd011b_service_create_activation_request(
  p_auth_user_id uuid,
  p_device_label text,
  p_workstation_mode text,
  p_verification_code text,
  p_request_token_hash text,
  p_expires_at timestamptz
)
returns table(
  ok boolean,
  reason text,
  request_id uuid,
  activation_kind text,
  location_id text,
  role_id text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff public.staff_profiles%rowtype;
  v_location_id text;
  v_role_id text;
  v_kind text;
  v_request_id uuid;
begin
  select * into v_staff
  from public.staff_profiles
  where auth_user_id = p_auth_user_id
  limit 1;

  if v_staff.id is null then
    return query select false, 'STAFF_NOT_FOUND', null::uuid, ''::text,
      ''::text, ''::text, null::timestamptz;
    return;
  end if;

  if public.dd011b_target_is_owner(v_staff.id) then
    return query select false, 'OWNER_USES_BOOTSTRAP', null::uuid, ''::text,
      ''::text, ''::text, null::timestamptz;
    return;
  end if;

  if v_staff.provisioning_status = 'DISABLED' then
    return query select false, 'STAFF_DISABLED', null::uuid, ''::text,
      ''::text, ''::text, null::timestamptz;
    return;
  end if;

  if p_workstation_mode not in ('CASHIER','STAFF','KDS_KITCHEN','KDS_BAR','KDS_DESSERT','ADMIN')
     or p_verification_code !~ '^[0-9]{6}$'
     or p_request_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at <= now()
     or btrim(coalesce(p_device_label, '')) = '' then
    return query select false, 'VALIDATION_ERROR', null::uuid, ''::text,
      ''::text, ''::text, null::timestamptz;
    return;
  end if;

  select sla.location_id into v_location_id
  from public.staff_location_assignments sla
  where sla.staff_profile_id = v_staff.id
  order by sla.assigned_at asc
  limit 1;

  select sra.role_id into v_role_id
  from public.staff_role_assignments sra
  where sra.staff_profile_id = v_staff.id
    and sra.role_id <> 'OWNER'
  order by sra.assigned_at asc
  limit 1;

  if v_location_id is null or v_role_id is null then
    return query select false, 'STAFF_ASSIGNMENT_MISSING', null::uuid, ''::text,
      ''::text, ''::text, null::timestamptz;
    return;
  end if;

  v_kind := case
    when v_staff.provisioning_status in ('PENDING_FIRST_LOGIN','PENDING_OWNER_APPROVAL')
      then 'FIRST_LOGIN'
    else 'NEW_DEVICE'
  end;

  update public.staff_activation_requests
  set status = 'EXPIRED'
  where staff_profile_id = v_staff.id
    and status = 'PENDING';

  insert into public.staff_activation_requests(
    staff_profile_id, location_id, role_id, device_label, workstation_mode,
    verification_code, request_token_hash, activation_kind, status, expires_at
  ) values (
    v_staff.id, v_location_id, v_role_id, btrim(p_device_label), p_workstation_mode,
    p_verification_code, p_request_token_hash, v_kind, 'PENDING', p_expires_at
  )
  returning id into v_request_id;

  if v_kind = 'FIRST_LOGIN' then
    update public.staff_profiles
    set provisioning_status = 'PENDING_OWNER_APPROVAL', updated_at = now()
    where id = v_staff.id;
  end if;

  return query select true, '', v_request_id, v_kind, v_location_id, v_role_id, p_expires_at;
end
$$;

create or replace function public.dd011b_service_approve_activation(
  p_owner_auth_user_id uuid,
  p_request_id uuid
)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.staff_activation_requests%rowtype;
  v_owner_staff_id text;
begin
  select * into v_request
  from public.staff_activation_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    return query select false, 'ACTIVATION_NOT_FOUND'; return;
  end if;
  if v_request.status <> 'PENDING' then
    return query select false, 'ACTIVATION_NOT_PENDING'; return;
  end if;
  if v_request.expires_at <= now() then
    update public.staff_activation_requests set status = 'EXPIRED' where id = p_request_id;
    return query select false, 'ACTIVATION_EXPIRED'; return;
  end if;

  select sp.id into v_owner_staff_id
  from public.staff_profiles sp
  join public.staff_role_assignments sra
    on sra.staff_profile_id = sp.id
   and sra.role_id = 'OWNER'
   and sra.active = true
  join public.staff_location_assignments sla
    on sla.staff_profile_id = sp.id
   and sla.location_id = v_request.location_id
   and sla.active = true
  where sp.auth_user_id = p_owner_auth_user_id
    and sp.active = true
  limit 1;

  if v_owner_staff_id is null then
    return query select false, 'OWNER_REQUIRED'; return;
  end if;

  if v_request.activation_kind = 'FIRST_LOGIN' then
    update public.staff_profiles
    set active = true, provisioning_status = 'ACTIVE', updated_at = now()
    where id = v_request.staff_profile_id;

    update public.staff_location_assignments
    set active = true, assigned_at = now()
    where staff_profile_id = v_request.staff_profile_id
      and location_id = v_request.location_id;

    update public.staff_role_assignments
    set active = true, assigned_at = now()
    where staff_profile_id = v_request.staff_profile_id
      and location_id = v_request.location_id
      and role_id = v_request.role_id;
  end if;

  update public.staff_activation_requests
  set status = 'APPROVED',
      approved_at = now(),
      approved_by_staff_profile_id = v_owner_staff_id
  where id = p_request_id;

  perform public.dd008c_write_audit(
    v_request.location_id, 'STAFF', v_owner_staff_id, v_owner_staff_id, '',
    'dd011b_service_approve_activation', 'staff_activation', p_request_id::text,
    'APPROVED', jsonb_build_object(
      'staffProfileId', v_request.staff_profile_id,
      'kind', v_request.activation_kind
    )
  );

  return query select true, '';
end
$$;

create or replace function public.dd011b_service_reject_activation(
  p_owner_auth_user_id uuid,
  p_request_id uuid
)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.staff_activation_requests%rowtype;
  v_owner_staff_id text;
begin
  select * into v_request
  from public.staff_activation_requests
  where id = p_request_id
  for update;

  if v_request.id is null then return query select false, 'ACTIVATION_NOT_FOUND'; return; end if;
  if v_request.status <> 'PENDING' then return query select false, 'ACTIVATION_NOT_PENDING'; return; end if;

  select sp.id into v_owner_staff_id
  from public.staff_profiles sp
  join public.staff_role_assignments sra
    on sra.staff_profile_id = sp.id
   and sra.role_id = 'OWNER'
   and sra.active = true
  where sp.auth_user_id = p_owner_auth_user_id
    and sp.active = true
  limit 1;

  if v_owner_staff_id is null then return query select false, 'OWNER_REQUIRED'; return; end if;

  update public.staff_activation_requests
  set status = 'REJECTED', rejected_at = now()
  where id = p_request_id;

  if v_request.activation_kind = 'FIRST_LOGIN' then
    update public.staff_profiles
    set provisioning_status = 'PENDING_FIRST_LOGIN', updated_at = now()
    where id = v_request.staff_profile_id
      and active = false;
  end if;

  perform public.dd008c_write_audit(
    v_request.location_id, 'STAFF', v_owner_staff_id, v_owner_staff_id, '',
    'dd011b_service_reject_activation', 'staff_activation', p_request_id::text,
    'REJECTED', '{}'::jsonb
  );

  return query select true, '';
end
$$;

create or replace function public.dd011b_service_activation_status(
  p_auth_user_id uuid,
  p_request_token_hash text
)
returns table(
  ok boolean,
  reason text,
  request_id uuid,
  status text,
  activation_kind text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.staff_activation_requests%rowtype;
begin
  select ar.* into v_request
  from public.staff_activation_requests ar
  join public.staff_profiles sp on sp.id = ar.staff_profile_id
  where sp.auth_user_id = p_auth_user_id
    and ar.request_token_hash = p_request_token_hash
  order by ar.requested_at desc
  limit 1;

  if v_request.id is null then
    return query select false, 'ACTIVATION_NOT_FOUND', null::uuid,
      ''::text, ''::text, null::timestamptz;
    return;
  end if;

  if v_request.status in ('PENDING','APPROVED') and v_request.expires_at <= now() then
    update public.staff_activation_requests
    set status = 'EXPIRED'
    where id = v_request.id;
    v_request.status := 'EXPIRED';
  end if;

  return query select true, '', v_request.id, v_request.status,
    v_request.activation_kind, v_request.expires_at;
end
$$;

create or replace function public.dd011b_service_resolve_device_session(
  p_auth_user_id uuid,
  p_session_token_hash text
)
returns table(
  ok boolean,
  reason text,
  staff_profile_id text,
  device_id text,
  location_id text,
  workstation_mode text,
  device_credential text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  select
    sp.id as staff_profile_id,
    wd.id as device_id,
    wd.location_id,
    wd.mode as workstation_mode,
    sec.credential,
    s.id as session_id
  into v_row
  from public.workstation_device_sessions s
  join public.workstation_devices wd
    on wd.id = s.device_id
   and wd.active = true
  join public.workstation_device_secrets sec
    on sec.device_id = wd.id
  join public.staff_profiles sp
    on sp.auth_user_id = s.auth_user_id
   and sp.active = true
  join public.staff_location_assignments sla
    on sla.staff_profile_id = sp.id
   and sla.location_id = wd.location_id
   and sla.active = true
  where s.auth_user_id = p_auth_user_id
    and s.session_token_hash = p_session_token_hash
    and s.active = true
    and s.expires_at > now()
  limit 1;

  if v_row.device_id is null then
    return query select false, 'DEVICE_SESSION_REQUIRED', '', '', '', '', '';
    return;
  end if;

  update public.workstation_device_sessions
  set last_seen_at = now()
  where id = v_row.session_id;

  update public.workstation_devices
  set last_seen_at = now(),
      last_used_by_staff_profile_id = v_row.staff_profile_id,
      use_count = use_count + 1
  where id = v_row.device_id;

  return query select true, '', v_row.staff_profile_id, v_row.device_id,
    v_row.location_id, v_row.workstation_mode, v_row.credential;
end
$$;

create or replace function public.dd011b_service_owner_security_snapshot(
  p_owner_auth_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner_staff_id text;
  v_location_id text;
begin
  select sp.id, sra.location_id
  into v_owner_staff_id, v_location_id
  from public.staff_profiles sp
  join public.staff_role_assignments sra
    on sra.staff_profile_id = sp.id
   and sra.role_id = 'OWNER'
   and sra.active = true
  join public.staff_location_assignments sla
    on sla.staff_profile_id = sp.id
   and sla.location_id = sra.location_id
   and sla.active = true
  where sp.auth_user_id = p_owner_auth_user_id
    and sp.active = true
  limit 1;

  if v_owner_staff_id is null then
    return jsonb_build_object('ok', false, 'reason', 'OWNER_REQUIRED');
  end if;

  return jsonb_build_object(
    'ok', true,
    'locationId', v_location_id,
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'staffProfileId', sp.id,
        'username', sp.username,
        'displayName', sp.display_name,
        'active', sp.active,
        'provisioningStatus', sp.provisioning_status,
        'locationActive', sla.active,
        'roles', coalesce((
          select jsonb_agg(sra.role_id order by sra.role_id)
          from public.staff_role_assignments sra
          where sra.staff_profile_id = sp.id
            and sra.location_id = v_location_id
            and sra.active = true
        ), '[]'::jsonb)
      ) order by sp.display_name, sp.id)
      from public.staff_profiles sp
      join public.staff_location_assignments sla
        on sla.staff_profile_id = sp.id
       and sla.location_id = v_location_id
    ), '[]'::jsonb),
    'pendingActivations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'requestId', ar.id,
        'staffProfileId', ar.staff_profile_id,
        'username', sp.username,
        'displayName', sp.display_name,
        'roleId', ar.role_id,
        'deviceLabel', ar.device_label,
        'workstationMode', ar.workstation_mode,
        'verificationCode', ar.verification_code,
        'activationKind', ar.activation_kind,
        'status', ar.status,
        'requestedAt', ar.requested_at,
        'expiresAt', ar.expires_at
      ) order by ar.requested_at desc)
      from public.staff_activation_requests ar
      join public.staff_profiles sp on sp.id = ar.staff_profile_id
      where ar.location_id = v_location_id
        and ar.status = 'PENDING'
        and ar.expires_at > now()
    ), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'deviceId', wd.id,
        'label', wd.label,
        'mode', wd.mode,
        'active', wd.active,
        'createdAt', wd.created_at,
        'lastSeenAt', wd.last_seen_at,
        'useCount', wd.use_count,
        'revokedAt', wd.revoked_at
      ) order by wd.active desc, wd.created_at desc)
      from public.workstation_devices wd
      where wd.location_id = v_location_id
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'roleId', r.id,
        'roleName', r.name
      ) order by r.id)
      from public.roles r
      where r.id <> 'OWNER'
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.dd011b_service_set_device_session_enforcement(
  p_required boolean
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.dd011b_security_policy
  set backend_device_sessions_required = p_required,
      updated_at = now()
  where singleton = true
$$;

-- Explicit ACLs. Internal helpers are not browser-executable.
revoke all on function public.dd011b_target_is_owner(text) from public, anon, authenticated;
revoke all on function public.dd011b_owner_mutation_authorized(text,text,text,text) from public, anon, authenticated;
revoke all on function public.dd011b_service_create_pending_staff(uuid,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.dd011b_service_create_activation_request(uuid,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.dd011b_service_approve_activation(uuid,uuid) from public, anon, authenticated;
revoke all on function public.dd011b_service_reject_activation(uuid,uuid) from public, anon, authenticated;
revoke all on function public.dd011b_service_activation_status(uuid,text) from public, anon, authenticated;
revoke all on function public.dd011b_service_resolve_device_session(uuid,text) from public, anon, authenticated;
revoke all on function public.dd011b_service_owner_security_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.dd011b_service_set_device_session_enforcement(boolean) from public, anon, authenticated;

grant execute on function public.dd011b_service_create_pending_staff(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.dd011b_service_create_activation_request(uuid,text,text,text,text,timestamptz) to service_role;
grant execute on function public.dd011b_service_approve_activation(uuid,uuid) to service_role;
grant execute on function public.dd011b_service_reject_activation(uuid,uuid) to service_role;
grant execute on function public.dd011b_service_activation_status(uuid,text) to service_role;
grant execute on function public.dd011b_service_resolve_device_session(uuid,text) to service_role;
grant execute on function public.dd011b_service_owner_security_snapshot(uuid) to service_role;
grant execute on function public.dd011b_service_set_device_session_enforcement(boolean) to service_role;

revoke all on function public.dd011b_owner_context() from public, anon;
grant execute on function public.dd011b_owner_context() to authenticated;
