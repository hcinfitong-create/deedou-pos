-- DD-011B staged cutover compatibility.
-- Historical contracts run before backend_device_sessions_required is enabled.
-- After Owner bootstrap/cutover, browser-callable rotate/register stop returning secrets.

create or replace function public.assign_staff_role_at_location(
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
  if p_role_id = 'OWNER' and public.dd011b_is_owner() = false then
    return query select false, 'PRIVILEGE_CEILING_EXCEEDED';
    return;
  end if;
  if p_role_id = 'OWNER' then
    return query select false, 'SINGLE_OWNER_ENFORCED';
    return;
  end if;

  select * into v_owner
  from public.dd011b_owner_mutation_authorized(
    p_location_id, p_current_workstation_mode, p_current_device_credential, 'staff.manage'
  ) limit 1;
  if v_owner.ok is distinct from true then
    return query select false, v_owner.reason;
    return;
  end if;

  if not exists (
    select 1 from public.staff_location_assignments
    where staff_profile_id = p_target_staff_profile_id and location_id = p_location_id
  ) then
    return query select false, 'TARGET_LOCATION_DENIED'; return;
  end if;
  if not exists (select 1 from public.roles where id = p_role_id) then
    return query select false, 'ROLE_NOT_FOUND'; return;
  end if;

  insert into public.staff_role_assignments(staff_profile_id,location_id,role_id,active)
  values(p_target_staff_profile_id,p_location_id,p_role_id,true)
  on conflict(staff_profile_id,location_id,role_id) do update
  set active=true,assigned_at=now();

  perform public.dd008c_write_audit(
    p_location_id,'STAFF',v_owner.staff_profile_id,v_owner.staff_profile_id,v_owner.device_id,
    'assign_staff_role_at_location','staff_role',p_target_staff_profile_id||':'||p_role_id,
    'ASSIGNED',jsonb_build_object('roleId',p_role_id,'ownerAuthoritative',true)
  );
  return query select true,'';
end
$$;

create or replace function public.dd011_set_staff_active(
  p_location_id text,
  p_target_staff_profile_id text,
  p_active boolean,
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
  v_target_auth uuid;
  v_target_owner boolean := public.dd011b_target_is_owner(p_target_staff_profile_id);
begin
  if v_target_owner and public.dd011b_is_owner() = false then
    return query select false,'PRIVILEGE_CEILING_EXCEEDED'; return;
  end if;
  if v_target_owner and p_active = false then
    return query select false,'SOLE_OWNER_PROTECTED'; return;
  end if;

  select * into v_owner
  from public.dd011b_owner_mutation_authorized(
    p_location_id,p_current_workstation_mode,p_current_device_credential,'staff.manage'
  ) limit 1;
  if v_owner.ok is distinct from true then return query select false,v_owner.reason; return; end if;

  update public.staff_profiles
  set active=p_active,
      provisioning_status=case when p_active then 'ACTIVE' else 'DISABLED' end,
      updated_at=now()
  where id=p_target_staff_profile_id
  returning auth_user_id into v_target_auth;
  if v_target_auth is null then return query select false,'TARGET_STAFF_NOT_FOUND'; return; end if;

  if p_active=false then
    update public.workstation_device_sessions set active=false,revoked_at=now()
    where auth_user_id=v_target_auth and active=true;
  end if;

  perform public.dd008c_write_audit(
    p_location_id,'STAFF',v_owner.staff_profile_id,v_owner.staff_profile_id,v_owner.device_id,
    'dd011_set_staff_active','staff_profile',p_target_staff_profile_id,
    case when p_active then 'ACTIVATED' else 'DEACTIVATED' end,
    jsonb_build_object('ownerAuthoritative',true)
  );
  return query select true,'';
end
$$;

create or replace function public.register_workstation_device(
  p_location_id text,
  p_label text,
  p_mode text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table(ok boolean, reason text, device_id text, device_credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner record;
  v_device_id text;
  v_credential text;
  v_required boolean := false;
begin
  select * into v_owner
  from public.dd011b_owner_mutation_authorized(
    p_location_id,p_current_workstation_mode,p_current_device_credential,'devices.manage'
  ) limit 1;
  if v_owner.ok is distinct from true then return query select false,v_owner.reason,'',''; return; end if;

  if p_mode not in ('CASHIER','STAFF','KDS_KITCHEN','KDS_BAR','KDS_DESSERT','ADMIN') then
    return query select false,'DEVICE_MODE_DENIED','',''; return;
  end if;

  v_device_id:=public.generate_device_id();
  v_credential:=public.generate_device_credential();
  insert into public.workstation_devices(id,location_id,label,mode,credential_hash,active,registered_by_staff_profile_id)
  values(v_device_id,p_location_id,coalesce(nullif(btrim(p_label),''),p_mode),p_mode,public.hash_device_credential(v_credential),true,v_owner.staff_profile_id);
  insert into public.workstation_device_secrets(device_id,credential) values(v_device_id,v_credential)
  on conflict(device_id) do update set credential=excluded.credential,rotated_at=now();

  perform public.dd008c_write_audit(
    p_location_id,'STAFF',v_owner.staff_profile_id,v_owner.staff_profile_id,v_owner.device_id,
    'register_workstation_device','workstation_device',v_device_id,'REGISTERED',
    jsonb_build_object('mode',p_mode,'backendManaged',true)
  );
  select coalesce(backend_device_sessions_required,false) into v_required
  from public.dd011b_security_policy where singleton=true;
  return query select true,'',v_device_id,case when v_required then '' else v_credential end;
end
$$;

create or replace function public.dd011_rotate_workstation_device(
  p_location_id text,
  p_device_id text,
  p_current_workstation_mode text default '',
  p_current_device_credential text default ''
)
returns table(ok boolean, reason text, device_id text, device_credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner record;
  v_credential text;
  v_required boolean := false;
begin
  select * into v_owner
  from public.dd011b_owner_mutation_authorized(
    p_location_id,p_current_workstation_mode,p_current_device_credential,'devices.manage'
  ) limit 1;
  if v_owner.ok is distinct from true then return query select false,v_owner.reason,'',''; return; end if;
  if p_device_id=v_owner.device_id then return query select false,'CURRENT_DEVICE_ROTATE_BLOCKED','',''; return; end if;

  v_credential:=public.generate_device_credential();
  update public.workstation_devices
  set credential_hash=public.hash_device_credential(v_credential),active=true,rotated_at=now(),revoked_at=null,
      last_seen_at=null,last_used_by_staff_profile_id=null,use_count=0
  where id=p_device_id and location_id=p_location_id;
  if not found then return query select false,'DEVICE_NOT_FOUND','',''; return; end if;

  insert into public.workstation_device_secrets(device_id,credential,rotated_at) values(p_device_id,v_credential,now())
  on conflict(device_id) do update set credential=excluded.credential,rotated_at=now();
  update public.workstation_device_sessions set active=false,revoked_at=now() where device_id=p_device_id and active=true;

  perform public.dd008c_write_audit(
    p_location_id,'STAFF',v_owner.staff_profile_id,v_owner.staff_profile_id,v_owner.device_id,
    'dd011_rotate_workstation_device','workstation_device',p_device_id,'ROTATED',
    jsonb_build_object('backendManaged',true)
  );
  select coalesce(backend_device_sessions_required,false) into v_required
  from public.dd011b_security_policy where singleton=true;
  return query select true,'',p_device_id,case when v_required then '' else v_credential end;
end
$$;

-- Activation completion uses the request's own staff_profile_id. No record variable
-- participates in a multi-item INTO list, which keeps the migration PostgreSQL-safe.
create or replace function public.dd011b_service_complete_activation(
  p_auth_user_id uuid,
  p_request_token_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz
)
returns table(ok boolean, reason text, device_id text, location_id text, workstation_mode text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.staff_activation_requests%rowtype;
  v_staff_id text;
  v_device_id text;
  v_credential text;
begin
  if p_session_token_hash !~ '^[0-9a-f]{64}$' or p_session_expires_at<=now() then
    return query select false,'VALIDATION_ERROR','','',''; return;
  end if;

  select ar.* into v_request
  from public.staff_activation_requests ar
  join public.staff_profiles sp on sp.id=ar.staff_profile_id
  where sp.auth_user_id=p_auth_user_id
    and ar.request_token_hash=p_request_token_hash
  order by ar.requested_at desc
  limit 1
  for update of ar;

  if v_request.id is null then return query select false,'ACTIVATION_NOT_FOUND','','',''; return; end if;
  v_staff_id := v_request.staff_profile_id;

  if v_request.status<>'APPROVED' then return query select false,'ACTIVATION_NOT_APPROVED','','',''; return; end if;
  if v_request.expires_at<=now() then
    update public.staff_activation_requests set status='EXPIRED' where id=v_request.id;
    return query select false,'ACTIVATION_EXPIRED','','',''; return;
  end if;

  if not exists(select 1 from public.staff_profiles where id=v_staff_id and active=true)
     or not exists(select 1 from public.staff_location_assignments where staff_profile_id=v_staff_id and location_id=v_request.location_id and active=true)
     or not exists(select 1 from public.staff_role_assignments where staff_profile_id=v_staff_id and location_id=v_request.location_id and role_id=v_request.role_id and active=true) then
    return query select false,'STAFF_NOT_ACTIVE','','',''; return;
  end if;

  v_device_id:=public.generate_device_id();
  v_credential:=public.generate_device_credential();
  insert into public.workstation_devices(id,location_id,label,mode,credential_hash,active,registered_by_staff_profile_id)
  values(v_device_id,v_request.location_id,v_request.device_label,v_request.workstation_mode,public.hash_device_credential(v_credential),true,v_request.approved_by_staff_profile_id);
  insert into public.workstation_device_secrets(device_id,credential) values(v_device_id,v_credential);
  insert into public.workstation_device_sessions(device_id,auth_user_id,session_token_hash,expires_at)
  values(v_device_id,p_auth_user_id,p_session_token_hash,p_session_expires_at);
  update public.staff_activation_requests set status='COMPLETED',completed_at=now(),device_id=v_device_id where id=v_request.id;

  perform public.dd008c_write_audit(
    v_request.location_id,'STAFF',v_staff_id,v_staff_id,v_device_id,
    'dd011b_service_complete_activation','workstation_device',v_device_id,'ACTIVATED',
    jsonb_build_object('kind',v_request.activation_kind,'backendManaged',true)
  );
  return query select true,'',v_device_id,v_request.location_id,v_request.workstation_mode;
end
$$;

revoke all on function public.dd011b_service_complete_activation(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.dd011b_service_complete_activation(uuid,text,text,timestamptz) to service_role;
