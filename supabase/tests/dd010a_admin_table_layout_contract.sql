-- DD-010A Admin table/floor/QR authority contract.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin
)
values
  ('00000000-0000-0000-0000-000000000000','40000000-0000-4000-8000-000000000001','authenticated','authenticated','dd010a-admin@example.invalid',crypt('local-dd010a-admin', gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false),
  ('00000000-0000-0000-0000-000000000000','40000000-0000-4000-8000-000000000002','authenticated','authenticated','dd010a-staff@example.invalid',crypt('local-dd010a-staff', gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false),
  ('00000000-0000-0000-0000-000000000000','40000000-0000-4000-8000-000000000003','authenticated','authenticated','dd010a-cashier@example.invalid',crypt('local-dd010a-cashier', gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false)
on conflict (id) do nothing;

insert into public.staff_profiles (id, auth_user_id, display_name, active)
values
  ('dd010a-staff-admin','40000000-0000-4000-8000-000000000001','DD-010A Admin',true),
  ('dd010a-staff-floor','40000000-0000-4000-8000-000000000002','DD-010A Floor',true),
  ('dd010a-staff-cashier','40000000-0000-4000-8000-000000000003','DD-010A Cashier',true)
on conflict (id) do nothing;

insert into public.staff_location_assignments (staff_profile_id, location_id, active)
values
  ('dd010a-staff-admin','deedou-demo',true),
  ('dd010a-staff-floor','deedou-demo',true),
  ('dd010a-staff-cashier','deedou-demo',true)
on conflict (staff_profile_id, location_id) do update set active = excluded.active;

insert into public.staff_role_assignments (staff_profile_id, location_id, role_id, active)
values
  ('dd010a-staff-admin','deedou-demo','ADMIN_MENU',true),
  ('dd010a-staff-floor','deedou-demo','FLOOR_STAFF',true),
  ('dd010a-staff-cashier','deedou-demo','CASHIER',true)
on conflict (staff_profile_id, location_id, role_id) do update set active = excluded.active;

insert into public.workstation_devices (id, location_id, label, mode, credential_hash, active, registered_by_staff_profile_id)
values
  ('dd010a-device-admin','deedou-demo','DD-010A Admin','ADMIN',public.hash_device_credential('dd010a-admin-device'),true,'dd010a-staff-admin'),
  ('dd010a-device-staff','deedou-demo','DD-010A Staff','STAFF',public.hash_device_credential('dd010a-staff-device'),true,'dd010a-staff-floor'),
  ('dd010a-device-cashier','deedou-demo','DD-010A Cashier','CASHIER',public.hash_device_credential('dd010a-cashier-device'),true,'dd010a-staff-cashier')
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
begin
  begin
    insert into public.physical_tables (id, location_id, code, zone, qr_token)
    values ('dd010a-raw-denied','deedou-demo','RAW1','Denied','dd010a-raw-denied-token');
    raise exception 'authenticated direct physical_tables INSERT unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
end $$;

do $$
declare
  v_result record;
  v_table jsonb;
  v_table_id text;
  v_old_token text;
  v_new_token text;
  v_version integer;
  v_count integer;
begin
  select * into v_result
  from public.dd010a_create_physical_table(
    'deedou-demo','A95','Beach',6,'ROUND',12,18,3,3,95,
    'dd010a-create-a95','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> true then
    raise exception 'admin create failed: %/%', v_result.category, v_result.reason;
  end if;
  v_table := v_result.payload->'table';
  v_table_id := v_table->>'id';
  v_old_token := v_table->>'qrToken';
  v_version := v_result.version;
  if v_table_id = '' or length(v_old_token) < 20 or (v_table->>'code') <> 'A95' or (v_table->>'zone') <> 'Beach' then
    raise exception 'create payload invalid: %', v_table;
  end if;

  select count(*) into v_count from public.resolve_table_token(v_old_token);
  if v_count <> 1 then raise exception 'new QR token does not resolve'; end if;

  select * into v_result
  from public.dd010a_create_physical_table(
    'deedou-demo','A95','Beach',4,'RECTANGLE',0,0,2,2,96,
    'dd010a-duplicate-a95','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'TABLE_CODE_EXISTS' then
    raise exception 'duplicate code must be rejected, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd010a_get_admin_table_layout('deedou-demo','ADMIN','dd010a-admin-device')
  limit 1;
  if v_result.ok <> true then raise exception 'admin layout snapshot failed'; end if;
  select count(*) into v_count
  from jsonb_array_elements(v_result.payload->'tables') item
  where item->>'id' = v_table_id and item->>'code' = 'A95';
  if v_count <> 1 then raise exception 'created table absent from admin layout'; end if;

  select * into v_result
  from public.dd010a_rotate_physical_table_qr(
    'deedou-demo',v_table_id,v_version,'dd010a-rotate-a95','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'QR rotate failed: %/%', v_result.category, v_result.reason; end if;
  v_new_token := v_result.payload->'table'->>'qrToken';
  if v_new_token = v_old_token or length(v_new_token) < 20 then raise exception 'QR token did not rotate'; end if;
  select count(*) into v_count from public.resolve_table_token(v_old_token);
  if v_count <> 0 then raise exception 'old QR token still resolves after rotation'; end if;
  select count(*) into v_count from public.resolve_table_token(v_new_token);
  if v_count <> 1 then raise exception 'new QR token does not resolve after rotation'; end if;

  select * into v_result
  from public.dd010a_update_physical_table(
    'deedou-demo',v_table_id,'A95','Beach',6,'ROUND',20,24,3,3,95,
    v_version,'dd010a-stale-update','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'CONFLICT' or v_result.reason <> 'STALE_VERSION' then
    raise exception 'expected stale version conflict, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000002';

do $$
declare v_result record;
begin
  select * into v_result
  from public.dd010a_create_physical_table(
    'deedou-demo','S95','Beach',4,'RECTANGLE',0,0,2,2,0,
    'dd010a-staff-create','STAFF','dd010a-staff-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'staff table create must be forbidden, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000003';

do $$
declare v_result record;
begin
  select * into v_result
  from public.dd010a_create_physical_table(
    'deedou-demo','C95','Beach',4,'RECTANGLE',0,0,2,2,0,
    'dd010a-cashier-create','CASHIER','dd010a-cashier-device'
  ) limit 1;
  if v_result.ok <> false or v_result.category <> 'FORBIDDEN' then
    raise exception 'cashier table create must be forbidden, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

insert into public.table_sessions (id, location_id, physical_table_id, table_code, zone, status, source)
select 'dd010a-open-session', pt.location_id, pt.id, pt.code, pt.zone, 'OPEN', 'DD010A_CONTRACT'
from public.physical_tables pt
where pt.location_id = 'deedou-demo' and pt.code = 'A95';

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_table jsonb;
  v_table_id text;
  v_version integer;
begin
  select * into v_result from public.dd010a_get_admin_table_layout('deedou-demo','ADMIN','dd010a-admin-device') limit 1;
  select item into v_table
  from jsonb_array_elements(v_result.payload->'tables') item
  where item->>'code' = 'A95' limit 1;
  v_table_id := v_table->>'id';
  v_version := (v_table->>'version')::integer;
  if (v_table->>'hasOpenSession')::boolean <> true then raise exception 'snapshot must flag open session'; end if;

  select * into v_result
  from public.dd010a_update_physical_table(
    'deedou-demo',v_table_id,'A95','Beach',6,'ROUND',42,44,4,3,95,
    v_version,'dd010a-open-layout-move','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> true then raise exception 'layout movement during open session must succeed: %/%', v_result.category, v_result.reason; end if;
  v_version := v_result.version;

  select * into v_result
  from public.dd010a_update_physical_table(
    'deedou-demo',v_table_id,'A96','Indoor',6,'ROUND',42,44,4,3,95,
    v_version,'dd010a-open-identity-change','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'OPEN_SESSION_IDENTITY_LOCKED' then
    raise exception 'open session identity mutation must be blocked, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd010a_set_physical_table_active(
    'deedou-demo',v_table_id,false,v_version,'dd010a-open-deactivate','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'OPEN_SESSION_ACTIVE_LOCKED' then
    raise exception 'open session deactivate must be blocked, got %/%', v_result.category, v_result.reason;
  end if;

  select * into v_result
  from public.dd010a_rotate_physical_table_qr(
    'deedou-demo',v_table_id,v_version,'dd010a-open-rotate','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> false or v_result.reason <> 'OPEN_SESSION_QR_LOCKED' then
    raise exception 'open session QR rotate must be blocked, got %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare v_code text; v_zone text;
begin
  select table_code, zone into v_code, v_zone from public.table_sessions where id = 'dd010a-open-session';
  if v_code <> 'A95' or v_zone <> 'Beach' then
    raise exception 'historical table session snapshot mutated: %/%', v_code, v_zone;
  end if;
end $$;

update public.table_sessions
set status = 'CLOSED', closed_at = now()
where id = 'dd010a-open-session';

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

do $$
declare
  v_result record;
  v_table jsonb;
  v_table_id text;
  v_version integer;
begin
  select * into v_result from public.dd010a_get_admin_table_layout('deedou-demo','ADMIN','dd010a-admin-device') limit 1;
  select item into v_table from jsonb_array_elements(v_result.payload->'tables') item where item->>'code' = 'A95' limit 1;
  v_table_id := v_table->>'id';
  v_version := (v_table->>'version')::integer;
  select * into v_result
  from public.dd010a_set_physical_table_active(
    'deedou-demo',v_table_id,false,v_version,'dd010a-deactivate-after-close','ADMIN','dd010a-admin-device'
  ) limit 1;
  if v_result.ok <> true or (v_result.payload->'table'->>'isActive')::boolean <> false then
    raise exception 'deactivate after close failed: %/%', v_result.category, v_result.reason;
  end if;
end $$;

reset role;

do $$
declare v_count integer;
begin
  select count(distinct command) into v_count
  from public.audit_events
  where staff_id = 'dd010a-staff-admin'
    and command in (
      'dd010a_create_physical_table',
      'dd010a_update_physical_table',
      'dd010a_rotate_physical_table_qr',
      'dd010a_set_physical_table_active'
    )
    and outcome = 'OK';
  if v_count <> 4 then raise exception 'expected four successful DD-010A audit command types, got %', v_count; end if;
end $$;

rollback;
