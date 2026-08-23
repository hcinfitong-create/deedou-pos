-- DD-011B single Owner, Owner MFA, pending staff activation and backend device sessions.
begin;

insert into public.locations(id,name,timezone,currency)
values('dd011b-location','DD011B Location','Asia/Ho_Chi_Minh','VND')
on conflict(id) do nothing;

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,
  raw_app_meta_data,raw_user_meta_data,is_super_admin
) values
('00000000-0000-0000-0000-000000000000','47000000-0000-4000-8000-000000000001','authenticated','authenticated','dd011b-owner@example.invalid',crypt('owner-pass',gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false),
('00000000-0000-0000-0000-000000000000','47000000-0000-4000-8000-000000000002','authenticated','authenticated','hieustaff1@staff.deedou.invalid',crypt('staff-pass',gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false),
('00000000-0000-0000-0000-000000000000','47000000-0000-4000-8000-000000000003','authenticated','authenticated','second-owner@example.invalid',crypt('second-pass',gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false)
on conflict(id) do nothing;

insert into public.staff_profiles(id,auth_user_id,display_name,active,provisioning_status)
values('dd011b-owner','47000000-0000-4000-8000-000000000001','DD011B Owner',true,'ACTIVE'),
      ('dd011b-second','47000000-0000-4000-8000-000000000003','Second Candidate',true,'ACTIVE')
on conflict(id) do nothing;
insert into public.staff_location_assignments(staff_profile_id,location_id,active)
values('dd011b-owner','dd011b-location',true),('dd011b-second','dd011b-location',true)
on conflict(staff_profile_id,location_id) do update set active=excluded.active;
insert into public.staff_role_assignments(staff_profile_id,location_id,role_id,active)
values('dd011b-owner','dd011b-location','OWNER',true)
on conflict(staff_profile_id,location_id,role_id) do update set active=excluded.active;

insert into public.workstation_devices(id,location_id,label,mode,credential_hash,active,registered_by_staff_profile_id)
values('dd011b-legacy-owner-device','dd011b-location','Legacy Owner','ADMIN',public.hash_device_credential('dd011b-legacy-owner-token'),true,'dd011b-owner')
on conflict(id) do nothing;

-- Direct browser access to backend-only security material remains denied.
do $$
begin
  if has_table_privilege('authenticated','public.workstation_device_secrets','SELECT')
     or has_table_privilege('authenticated','public.workstation_device_sessions','SELECT')
     or has_table_privilege('authenticated','public.staff_activation_requests','SELECT') then
    raise exception 'authenticated must not read DD011B backend security tables';
  end if;
  if has_function_privilege('authenticated','public.dd011b_service_resolve_device_session(uuid,text)','EXECUTE') then
    raise exception 'authenticated must not execute DD011B service helpers';
  end if;
end $$;

-- Database invariant: a second active OWNER is impossible globally.
do $$
begin
  begin
    insert into public.staff_role_assignments(staff_profile_id,location_id,role_id,active)
    values('dd011b-second','dd011b-location','OWNER',true);
    raise exception 'second active OWNER unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end $$;

-- Sole Owner protected route requires AAL2 even with a valid legacy device credential.
set local role authenticated;
set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
do $$
declare v record;
begin
  select * into v from public.authorize_staff_access('dd011b-location','menu.manage','ADMIN','dd011b-legacy-owner-token') limit 1;
  if v.ok<>false or v.reason<>'MFA_REQUIRED' then raise exception 'Owner AAL1 must be blocked, got %/%',v.ok,v.reason; end if;
end $$;
reset role;

-- Owner AAL2 can bootstrap exactly one backend-managed Owner workstation session.
set local role authenticated;
set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
do $$
declare v record;
begin
  select * into v from public.dd011b_owner_bootstrap_eligible() limit 1;
  if v.ok<>true or v.staff_profile_id<>'dd011b-owner' then raise exception 'Owner bootstrap should be eligible, got %/%',v.ok,v.reason; end if;
end $$;
reset role;

do $$
declare v record; r record;
begin
  select * into v from public.dd011b_service_bootstrap_owner_device(
    '47000000-0000-4000-8000-000000000001','Owner Admin',repeat('a',64),now()+interval '30 days'
  ) limit 1;
  if v.ok<>true or v.device_id='' then raise exception 'Owner backend device bootstrap failed %/%',v.ok,v.reason; end if;
  select * into r from public.dd011b_service_resolve_device_session('47000000-0000-4000-8000-000000000001',repeat('a',64)) limit 1;
  if r.ok<>true or r.device_id<>v.device_id or r.device_credential='' then raise exception 'Owner backend session resolution failed'; end if;
end $$;

-- Backend creates pending staff identity. Name and username are independent fields.
do $$
declare v record;
begin
  select * into v from public.dd011b_service_create_pending_staff(
    '47000000-0000-4000-8000-000000000001','47000000-0000-4000-8000-000000000002',
    'hieustaff1','Nguyễn Minh Hiếu','dd011b-location','CASHIER'
  ) limit 1;
  if v.ok<>true then raise exception 'pending staff create failed %',v.reason; end if;
  if not exists(select 1 from public.staff_profiles where id=v.staff_profile_id and username='hieustaff1' and display_name='Nguyễn Minh Hiếu' and active=false and provisioning_status='PENDING_FIRST_LOGIN') then
    raise exception 'pending staff profile identity/state mismatch';
  end if;
  if exists(select 1 from public.staff_role_assignments where staff_profile_id=v.staff_profile_id and role_id='CASHIER' and active=true) then
    raise exception 'pending staff role must not be active before Owner approval';
  end if;
end $$;

-- First login creates a six-digit challenge; password alone still has no operational access.
do $$
declare v record;
begin
  select * into v from public.dd011b_service_create_activation_request(
    '47000000-0000-4000-8000-000000000002','Cashier Front','CASHIER','482731',repeat('b',64),now()+interval '5 minutes'
  ) limit 1;
  if v.ok<>true or v.activation_kind<>'FIRST_LOGIN' then raise exception 'activation request failed %/%',v.ok,v.reason; end if;
  if not exists(select 1 from public.staff_activation_requests where id=v.request_id and verification_code='482731' and status='PENDING') then
    raise exception 'activation challenge not persisted';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role='authenticated';
set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
do $$
declare v record;
begin
  select * into v from public.authorize_staff_access('dd011b-location','payments.record','CASHIER','dd011b-legacy-owner-token') limit 1;
  if v.ok<>false or v.reason<>'STAFF_INACTIVE' then raise exception 'pending staff must be operationally inactive, got %/%',v.ok,v.reason; end if;
end $$;
reset role;

-- Owner confirms matching code in Owner UI; backend activates staff/location/role.
do $$
declare req uuid; v record;
begin
  select id into req from public.staff_activation_requests where request_token_hash=repeat('b',64) limit 1;
  select * into v from public.dd011b_service_approve_activation('47000000-0000-4000-8000-000000000001',req) limit 1;
  if v.ok<>true then raise exception 'Owner activation approval failed %',v.reason; end if;
  if not exists(select 1 from public.staff_profiles where auth_user_id='47000000-0000-4000-8000-000000000002' and active=true and provisioning_status='ACTIVE') then raise exception 'staff not activated'; end if;
  if not exists(select 1 from public.staff_role_assignments sra join public.staff_profiles sp on sp.id=sra.staff_profile_id where sp.auth_user_id='47000000-0000-4000-8000-000000000002' and sra.role_id='CASHIER' and sra.active=true) then raise exception 'role not activated'; end if;
end $$;

-- Approved browser completes activation into an HttpOnly-backed device session.
do $$
declare v record; r record;
begin
  select * into v from public.dd011b_service_complete_activation(
    '47000000-0000-4000-8000-000000000002',repeat('b',64),repeat('c',64),now()+interval '30 days'
  ) limit 1;
  if v.ok<>true or v.device_id='' then raise exception 'activation completion failed %/%',v.ok,v.reason; end if;
  select * into r from public.dd011b_service_resolve_device_session('47000000-0000-4000-8000-000000000002',repeat('c',64)) limit 1;
  if r.ok<>true or r.workstation_mode<>'CASHIER' or r.device_credential='' then raise exception 'staff device session resolution failed'; end if;
end $$;

-- Cutover enables backend-session requirement. A copied legacy credential without a
-- matching backend session is denied, while the approved staff session remains valid.
select public.dd011b_service_set_device_session_enforcement(true);

set local role authenticated;
set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
do $$
declare v record;
begin
  select * into v from public.authorize_staff_access('dd011b-location','menu.manage','ADMIN','dd011b-legacy-owner-token') limit 1;
  if v.ok<>false or v.reason<>'DEVICE_SESSION_REQUIRED' then raise exception 'legacy credential must be denied after cutover, got %/%',v.ok,v.reason; end if;
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role='authenticated';
set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
do $$
declare r record; v record;
begin
  reset role;
  select * into r from public.dd011b_service_resolve_device_session('47000000-0000-4000-8000-000000000002',repeat('c',64)) limit 1;
  set local role authenticated;
  set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000002';
  set local request.jwt.claim.role='authenticated';
  set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
  select * into v from public.authorize_staff_access('dd011b-location','payments.record','CASHIER',r.device_credential) limit 1;
  if v.ok<>true then raise exception 'approved backend session should authorize cashier, got %',v.reason; end if;
end $$;
reset role;

-- Sole Owner role cannot be revoked through normal application flow.
set local role authenticated;
set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
do $$
declare r record; v record;
begin
  reset role;
  select * into r from public.dd011b_service_resolve_device_session('47000000-0000-4000-8000-000000000001',repeat('a',64)) limit 1;
  set local role authenticated;
  set local request.jwt.claim.sub='47000000-0000-4000-8000-000000000001';
  set local request.jwt.claim.role='authenticated';
  set local request.jwt.claims='{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
  select * into v from public.dd011_revoke_staff_role_at_location('dd011b-owner','dd011b-location','OWNER','ADMIN',r.device_credential) limit 1;
  if v.ok<>false or v.reason<>'SOLE_OWNER_PROTECTED' then raise exception 'sole Owner revoke must be blocked, got %/%',v.ok,v.reason; end if;
end $$;
reset role;

rollback;
