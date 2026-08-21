-- DD-011 security hardening contract.
-- Runs only against local Supabase/Postgres in CI; all fixtures roll back.

begin;

insert into public.locations (id, name, timezone, currency)
values ('dd011-location', 'DD011 Location', 'Asia/Ho_Chi_Minh', 'VND')
on conflict (id) do nothing;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin
)
values
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dd011-owner@example.invalid', crypt('local-owner', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dd011-manager@example.invalid', crypt('local-manager', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'dd011-cashier@example.invalid', crypt('local-cashier', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'dd011-newstaff@example.invalid', crypt('local-newstaff', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd011-owner', '11000000-0000-4000-8000-000000000001', 'DD011 Owner', true),
  ('dd011-manager', '11000000-0000-4000-8000-000000000002', 'DD011 Manager', true),
  ('dd011-cashier', '11000000-0000-4000-8000-000000000003', 'DD011 Cashier', true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd011-owner', 'dd011-location', true),
  ('dd011-manager', 'dd011-location', true),
  ('dd011-cashier', 'dd011-location', true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd011-owner', 'dd011-location', 'OWNER', true),
  ('dd011-manager', 'dd011-location', 'MANAGER', true),
  ('dd011-cashier', 'dd011-location', 'CASHIER', true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (
  id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id
)
values
  ('dd011-admin-device', 'dd011-location', 'DD011 Admin Device', 'ADMIN', public.hash_device_credential('dd011-admin-token-000000000000000000000001'), true, 'dd011-owner'),
  ('dd011-cashier-device', 'dd011-location', 'DD011 Cashier Device', 'CASHIER', public.hash_device_credential('dd011-cashier-token-00000000000000000001'), true, 'dd011-owner')
on conflict (id) do nothing;

-- Schema and ACL baseline.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workstation_devices' and column_name = 'last_seen_at'
  ) then
    raise exception 'expected workstation_devices.last_seen_at';
  end if;

  if has_table_privilege('authenticated', 'public.workstation_devices', 'INSERT')
     or has_table_privilege('authenticated', 'public.workstation_devices', 'UPDATE')
     or has_table_privilege('authenticated', 'public.workstation_devices', 'DELETE') then
    raise exception 'expected direct authenticated workstation device writes to remain denied';
  end if;

  if has_function_privilege('anon', 'public.dd011_rotate_workstation_device(text,text,text,text)', 'EXECUTE') then
    raise exception 'expected anon rotate RPC denied';
  end if;

  if not has_function_privilege('authenticated', 'public.dd011_rotate_workstation_device(text,text,text,text)', 'EXECUTE') then
    raise exception 'expected authenticated rotate RPC executable';
  end if;

  if has_function_privilege('authenticated', 'public.dd011_has_aal2()', 'EXECUTE') then
    raise exception 'expected AAL helper to remain internal';
  end if;

  if has_function_privilege('authenticated', 'public.resolve_registered_device(text,text)', 'EXECUTE') then
    raise exception 'expected device resolver helper to remain internal';
  end if;
end $$;

-- AAL1 privileged operator: valid auth + role + device is still insufficient for mutations.
set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

do $$
declare
  v_register record;
  v_assign record;
  v_link record;
  v_rotate record;
begin
  select * into v_register
  from public.register_workstation_device(
    'dd011-location', 'AAL1 blocked', 'CASHIER', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_register.ok <> false or v_register.reason <> 'MFA_REQUIRED' then
    raise exception 'expected AAL1 device registration blocked, got %/%', v_register.ok, v_register.reason;
  end if;

  select * into v_assign
  from public.assign_staff_role_at_location(
    'dd011-cashier', 'dd011-location', 'FLOOR_STAFF', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_assign.ok <> false or v_assign.reason <> 'MFA_REQUIRED' then
    raise exception 'expected AAL1 role assignment blocked, got %/%', v_assign.ok, v_assign.reason;
  end if;

  select * into v_link
  from public.dd011_link_staff_by_email(
    'dd011-location', 'dd011-newstaff@example.invalid', 'New Staff', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_link.ok <> false or v_link.reason <> 'MFA_REQUIRED' then
    raise exception 'expected AAL1 staff link blocked, got %/%', v_link.ok, v_link.reason;
  end if;

  select * into v_rotate
  from public.dd011_rotate_workstation_device(
    'dd011-location', 'dd011-cashier-device', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_rotate.ok <> false or v_rotate.reason <> 'MFA_REQUIRED' then
    raise exception 'expected AAL1 rotate blocked, got %/%', v_rotate.ok, v_rotate.reason;
  end if;
end $$;

reset role;

-- AAL2 OWNER can use the privileged management surface.
set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

do $$
declare
  v_link record;
  v_assign record;
  v_register record;
  v_touch record;
  v_rotate record;
  v_revoke record;
  v_old_authz record;
  v_new_authz record;
  v_staff_count integer;
  v_device_count integer;
  v_audit_count integer;
begin
  select count(*) into v_staff_count
  from public.dd011_list_staff_admin('dd011-location', 'ADMIN', 'dd011-admin-token-000000000000000000000001');
  if v_staff_count <> 3 then
    raise exception 'expected 3 initial admin staff rows, got %', v_staff_count;
  end if;

  select count(*) into v_device_count
  from public.dd011_list_devices_admin('dd011-location', 'ADMIN', 'dd011-admin-token-000000000000000000000001');
  if v_device_count <> 2 then
    raise exception 'expected 2 initial devices, got %', v_device_count;
  end if;

  select * into v_link
  from public.dd011_link_staff_by_email(
    'dd011-location', 'dd011-newstaff@example.invalid', 'DD011 New Staff', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_link.ok <> true or length(v_link.staff_profile_id) < 12 then
    raise exception 'expected AAL2 owner to link auth user, got %/%/%', v_link.ok, v_link.reason, v_link.staff_profile_id;
  end if;

  select * into v_assign
  from public.assign_staff_role_at_location(
    v_link.staff_profile_id, 'dd011-location', 'CASHIER', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_assign.ok <> true then
    raise exception 'expected AAL2 owner role assignment, got %', v_assign.reason;
  end if;

  select * into v_register
  from public.register_workstation_device(
    'dd011-location', 'DD011 temporary device', 'CASHIER', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_register.ok <> true or length(v_register.device_credential) < 40 then
    raise exception 'expected server-issued device credential, got %/%/%', v_register.ok, v_register.reason, length(v_register.device_credential);
  end if;

  select * into v_touch
  from public.dd011_touch_current_device('dd011-location', 'CASHIER', v_register.device_credential)
  limit 1;
  if v_touch.ok <> true or v_touch.use_count <> 1 or v_touch.last_seen_at is null then
    raise exception 'expected verified device touch, got %/%/%/%', v_touch.ok, v_touch.reason, v_touch.use_count, v_touch.last_seen_at;
  end if;

  select * into v_rotate
  from public.dd011_rotate_workstation_device(
    'dd011-location', v_register.device_id, 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_rotate.ok <> true or v_rotate.device_credential = v_register.device_credential then
    raise exception 'expected rotation to issue a different credential, got %/%', v_rotate.ok, v_rotate.reason;
  end if;

  select * into v_old_authz
  from public.authorize_staff_access(
    'dd011-location', 'payments.read', 'CASHIER', v_register.device_credential
  ) limit 1;
  select * into v_new_authz
  from public.authorize_staff_access(
    'dd011-location', 'payments.read', 'CASHIER', v_rotate.device_credential
  ) limit 1;
  if v_old_authz.ok <> false
     or v_old_authz.reason <> 'DEVICE_UNREGISTERED'
     or v_new_authz.ok <> true then
    raise exception 'expected old credential invalid and new credential authorized after rotation, got %/% and %/%',
      v_old_authz.ok, v_old_authz.reason, v_new_authz.ok, v_new_authz.reason;
  end if;

  select * into v_revoke
  from public.revoke_workstation_device(
    'dd011-location', v_register.device_id, 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_revoke.ok <> true then
    raise exception 'expected AAL2 owner revoke, got %', v_revoke.reason;
  end if;

  select * into v_new_authz
  from public.authorize_staff_access(
    'dd011-location', 'payments.read', 'CASHIER', v_rotate.device_credential
  ) limit 1;
  if v_new_authz.ok <> false or v_new_authz.reason <> 'DEVICE_UNREGISTERED' then
    raise exception 'expected revoked rotated credential invalid immediately, got %/%', v_new_authz.ok, v_new_authz.reason;
  end if;

  select count(*) into v_audit_count
  from public.audit_events
  where location_id = 'dd011-location'
    and command in ('dd011_link_staff_by_email', 'assign_staff_role_at_location', 'register_workstation_device', 'dd011_rotate_workstation_device', 'revoke_workstation_device');
  if v_audit_count < 5 then
    raise exception 'expected DD011 security mutations audited, got %', v_audit_count;
  end if;
end $$;

reset role;

-- AAL2 MANAGER cannot grant/revoke above its permission ceiling.
set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000002';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';

do $$
declare
  v_assign record;
  v_deactivate record;
begin
  select * into v_assign
  from public.assign_staff_role_at_location(
    'dd011-cashier', 'dd011-location', 'OWNER', 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_assign.ok <> false or v_assign.reason <> 'PRIVILEGE_CEILING_EXCEEDED' then
    raise exception 'expected manager OWNER grant blocked, got %/%', v_assign.ok, v_assign.reason;
  end if;

  select * into v_deactivate
  from public.dd011_set_staff_active(
    'dd011-location', 'dd011-owner', false, 'ADMIN', 'dd011-admin-token-000000000000000000000001'
  ) limit 1;
  if v_deactivate.ok <> false or v_deactivate.reason <> 'PRIVILEGE_CEILING_EXCEEDED' then
    raise exception 'expected manager unable to deactivate owner, got %/%', v_deactivate.ok, v_deactivate.reason;
  end if;
end $$;

reset role;

-- A lower role using a copied ADMIN device credential is still constrained by RBAC.
set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000003';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';

do $$
declare
  v_authz record;
  v_devices integer;
begin
  select * into v_authz
  from public.authorize_staff_access('dd011-location', 'devices.manage', 'ADMIN', 'dd011-admin-token-000000000000000000000001')
  limit 1;
  if v_authz.ok <> false or v_authz.reason <> 'PERMISSION_DENIED' then
    raise exception 'expected copied ADMIN credential not to elevate CASHIER, got %/%', v_authz.ok, v_authz.reason;
  end if;

  select count(*) into v_devices
  from public.dd011_list_devices_admin('dd011-location', 'ADMIN', 'dd011-admin-token-000000000000000000000001');
  if v_devices <> 0 then
    raise exception 'expected cashier unable to enumerate devices through admin RPC';
  end if;
end $$;

reset role;

rollback;
