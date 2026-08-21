-- DD-010A authoritative Admin table, floor layout and QR management.

alter table public.physical_tables
  add column if not exists seat_count integer not null default 4,
  add column if not exists layout_x integer not null default 0,
  add column if not exists layout_y integer not null default 0,
  add column if not exists layout_width integer not null default 2,
  add column if not exists layout_height integer not null default 2,
  add column if not exists shape text not null default 'RECTANGLE',
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_seat_count_bounds' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_seat_count_bounds check (seat_count between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_layout_x_bounds' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_layout_x_bounds check (layout_x between 0 and 99);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_layout_y_bounds' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_layout_y_bounds check (layout_y between 0 and 99);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_layout_width_bounds' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_layout_width_bounds check (layout_width between 1 and 12);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_layout_height_bounds' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_layout_height_bounds check (layout_height between 1 and 12);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_shape_allowed' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_shape_allowed check (shape in ('RECTANGLE', 'ROUND', 'SQUARE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'physical_tables_version_positive' and conrelid = 'public.physical_tables'::regclass) then
    alter table public.physical_tables add constraint physical_tables_version_positive check (version > 0);
  end if;
end $$;

insert into public.permissions (id, permission_key, description)
values
  ('tables.manage_layout', 'tables.manage_layout', 'Create and manage physical table layout/configuration'),
  ('tables.rotate_qr', 'tables.rotate_qr', 'Rotate physical table QR identity')
on conflict (id) do update
set permission_key = excluded.permission_key,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
values
  ('OWNER', 'tables.manage_layout'),
  ('OWNER', 'tables.rotate_qr'),
  ('MANAGER', 'tables.manage_layout'),
  ('ADMIN_MENU', 'tables.read'),
  ('ADMIN_MENU', 'tables.manage_layout'),
  ('ADMIN_MENU', 'tables.rotate_qr')
on conflict do nothing;

create or replace function public.workstation_mode_allows_permission(p_mode text, p_permission_key text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_mode
    when 'CASHIER' then p_permission_key in (
      'menu.read', 'orders.read', 'orders.create_staff', 'orders.void',
      'service_requests.read', 'tables.read', 'tables.manage_session',
      'payments.read', 'payments.record', 'payments.void', 'payments.refund'
    )
    when 'STAFF' then p_permission_key in (
      'menu.read', 'orders.read', 'orders.accept', 'service.serve',
      'service_requests.read', 'service_requests.complete', 'course.manage', 'tables.read'
    )
    when 'KDS_KITCHEN' then p_permission_key in ('orders.read', 'kds.kitchen')
    when 'KDS_BAR' then p_permission_key in ('orders.read', 'kds.bar')
    when 'KDS_DESSERT' then p_permission_key in ('orders.read', 'kds.dessert')
    when 'ADMIN' then p_permission_key in (
      'menu.read', 'menu.manage', 'tables.read', 'tables.manage_layout', 'tables.rotate_qr',
      'payments.read', 'audit.read', 'staff.read', 'staff.manage', 'devices.manage', 'migration.manage'
    )
    else false
  end
$$;

create or replace function public.dd010a_generate_table_id()
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select 'TBL-' || replace(extensions.gen_random_uuid()::text, '-', '')
$$;

create or replace function public.dd010a_generate_qr_token()
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select 'ddt_' || rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=')
$$;

create or replace function public.dd010a_table_payload(p_table_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', pt.id,
    'code', pt.code,
    'zone', pt.zone,
    'qrToken', pt.qr_token,
    'isActive', pt.is_active,
    'displayOrder', pt.display_order,
    'seatCount', pt.seat_count,
    'layoutX', pt.layout_x,
    'layoutY', pt.layout_y,
    'layoutWidth', pt.layout_width,
    'layoutHeight', pt.layout_height,
    'shape', pt.shape,
    'version', pt.version,
    'updatedAt', pt.updated_at,
    'hasOpenSession', exists (
      select 1 from public.table_sessions ts
      where ts.location_id = pt.location_id
        and ts.physical_table_id = pt.id
        and ts.status = 'OPEN'
    )
  )
  from public.physical_tables pt
  where pt.id = p_table_id
  limit 1
$$;

create or replace function public.dd010a_get_admin_table_layout(
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
  from public.authorize_staff_access(p_location_id, 'tables.manage_layout', p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure('FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED'));
    return;
  end if;

  select jsonb_build_object(
    'locationId', p_location_id,
    'tables', coalesce(
      jsonb_agg(public.dd010a_table_payload(pt.id) order by pt.zone, pt.display_order, pt.code)
      filter (where pt.id is not null),
      '[]'::jsonb
    )
  ) into v_payload
  from public.physical_tables pt
  where pt.location_id = p_location_id;

  return query select * from public.dd008c_success('table_layout', p_location_id, null, v_payload);
end
$$;

create or replace function public.dd010a_create_physical_table(
  p_location_id text,
  p_code text,
  p_zone text,
  p_seat_count integer default 4,
  p_shape text default 'RECTANGLE',
  p_layout_x integer default 0,
  p_layout_y integer default 0,
  p_layout_width integer default 2,
  p_layout_height integer default 2,
  p_display_order integer default 0,
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
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_zone text := btrim(coalesce(p_zone, ''));
  v_shape text := upper(btrim(coalesce(p_shape, 'RECTANGLE')));
  v_hash text;
  v_replay jsonb;
  v_table public.physical_tables;
  v_result jsonb;
  v_table_id text;
  v_qr_token text;
  v_attempt integer := 0;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'tables.manage_layout', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_create_physical_table', 'physical_table', v_code,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,15}$' then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_create_physical_table', 'physical_table', v_code,
      'VALIDATION_ERROR', 'INVALID_TABLE_CODE'
    );
    return;
  end if;
  if length(v_zone) < 1 or length(v_zone) > 64 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_create_physical_table', 'physical_table', v_code,
      'VALIDATION_ERROR', 'INVALID_ZONE'
    );
    return;
  end if;
  if p_seat_count is null or p_seat_count not between 1 and 50
     or v_shape not in ('RECTANGLE', 'ROUND', 'SQUARE')
     or p_layout_x is null or p_layout_x not between 0 and 99
     or p_layout_y is null or p_layout_y not between 0 and 99
     or p_layout_width is null or p_layout_width not between 1 and 12
     or p_layout_height is null or p_layout_height not between 1 and 12
     or p_display_order is null or p_display_order not between 0 and 9999 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_create_physical_table', 'physical_table', v_code,
      'VALIDATION_ERROR', 'INVALID_TABLE_LAYOUT'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'code', v_code, 'zone', v_zone,
    'seatCount', p_seat_count, 'shape', v_shape,
    'layoutX', p_layout_x, 'layoutY', p_layout_y,
    'layoutWidth', p_layout_width, 'layoutHeight', p_layout_height,
    'displayOrder', p_display_order
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd010a_create_physical_table', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  if exists (select 1 from public.physical_tables pt where pt.location_id = p_location_id and pt.code = v_code) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_create_physical_table', 'physical_table', v_code,
      'VALIDATION_ERROR', 'TABLE_CODE_EXISTS'
    );
    return;
  end if;

  v_table_id := public.dd010a_generate_table_id();
  loop
    v_attempt := v_attempt + 1;
    v_qr_token := public.dd010a_generate_qr_token();
    exit when not exists (select 1 from public.physical_tables pt where pt.qr_token = v_qr_token);
    if v_attempt >= 5 then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd010a_create_physical_table', 'physical_table', v_code,
        'BACKEND_UNAVAILABLE', 'QR_TOKEN_GENERATION_FAILED'
      );
      return;
    end if;
  end loop;

  insert into public.physical_tables (
    id, location_id, code, zone, qr_token, is_active, display_order,
    seat_count, layout_x, layout_y, layout_width, layout_height, shape, version, updated_at
  ) values (
    v_table_id, p_location_id, v_code, v_zone, v_qr_token, true, p_display_order,
    p_seat_count, p_layout_x, p_layout_y, p_layout_width, p_layout_height, v_shape, 1, now()
  ) returning * into v_table;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'physical_table', v_table.id, v_table.version,
    jsonb_build_object('table', public.dd010a_table_payload(v_table.id))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd010a_create_physical_table', 'physical_table', v_table.id,
    v_result, jsonb_build_object('code', v_code, 'zone', v_zone)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd010a_create_physical_table', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_LAYOUT_CHANGED', 'action', 'CREATE'));
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_LAYOUT_CHANGED', 'action', 'CREATE'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd010a_update_physical_table(
  p_location_id text,
  p_table_id text,
  p_code text,
  p_zone text,
  p_seat_count integer,
  p_shape text,
  p_layout_x integer,
  p_layout_y integer,
  p_layout_width integer,
  p_layout_height integer,
  p_display_order integer,
  p_expected_version integer,
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
  v_table public.physical_tables;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_zone text := btrim(coalesce(p_zone, ''));
  v_shape text := upper(btrim(coalesce(p_shape, 'RECTANGLE')));
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_has_open boolean;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'tables.manage_layout', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', p_table_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,15}$' or length(v_zone) < 1 or length(v_zone) > 64
     or p_seat_count is null or p_seat_count not between 1 and 50
     or v_shape not in ('RECTANGLE', 'ROUND', 'SQUARE')
     or p_layout_x is null or p_layout_x not between 0 and 99
     or p_layout_y is null or p_layout_y not between 0 and 99
     or p_layout_width is null or p_layout_width not between 1 and 12
     or p_layout_height is null or p_layout_height not between 1 and 12
     or p_display_order is null or p_display_order not between 0 and 9999 then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', p_table_id,
      'VALIDATION_ERROR', 'INVALID_TABLE_LAYOUT'
    );
    return;
  end if;

  v_hash := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'tableId', p_table_id,
    'code', v_code, 'zone', v_zone, 'seatCount', p_seat_count, 'shape', v_shape,
    'layoutX', p_layout_x, 'layoutY', p_layout_y,
    'layoutWidth', p_layout_width, 'layoutHeight', p_layout_height,
    'displayOrder', p_display_order, 'expectedVersion', p_expected_version
  ));
  v_replay := public.dd008c_replay_command(p_location_id, 'dd010a_update_physical_table', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_table
  from public.physical_tables pt
  where pt.id = p_table_id and pt.location_id = p_location_id
  for update;
  if v_table.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', p_table_id,
      'VALIDATION_ERROR', 'TABLE_NOT_FOUND'
    );
    return;
  end if;
  if p_expected_version is null or v_table.version <> p_expected_version then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', p_table_id,
      'CONFLICT', 'STALE_VERSION', jsonb_build_object('currentVersion', v_table.version)
    );
    return;
  end if;
  if exists (select 1 from public.physical_tables pt where pt.location_id = p_location_id and pt.code = v_code and pt.id <> p_table_id) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', p_table_id,
      'VALIDATION_ERROR', 'TABLE_CODE_EXISTS'
    );
    return;
  end if;

  select exists (
    select 1 from public.table_sessions ts
    where ts.location_id = p_location_id and ts.physical_table_id = p_table_id and ts.status = 'OPEN'
  ) into v_has_open;
  if v_has_open and (v_table.code <> v_code or v_table.zone <> v_zone) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', p_table_id,
      'CONFLICT', 'OPEN_SESSION_IDENTITY_LOCKED'
    );
    return;
  end if;

  if v_table.code = v_code
     and v_table.zone = v_zone
     and v_table.seat_count = p_seat_count
     and v_table.shape = v_shape
     and v_table.layout_x = p_layout_x
     and v_table.layout_y = p_layout_y
     and v_table.layout_width = p_layout_width
     and v_table.layout_height = p_layout_height
     and v_table.display_order = p_display_order then
    v_result := public.dd008c_result_json(
      true, 'OK', 'ALREADY_SET', 'physical_table', v_table.id, v_table.version,
      jsonb_build_object('table', public.dd010a_table_payload(v_table.id), 'noOp', true)
    );
    perform public.dd008c_audit_staff_result(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_update_physical_table', 'physical_table', v_table.id,
      v_result, jsonb_build_object('noOp', true)
    );
    perform public.dd008c_store_command(
      p_location_id, 'dd010a_update_physical_table', p_idempotency_key,
      'STAFF', v_authz.staff_profile_id, v_hash, v_result
    );
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;

  update public.physical_tables pt
  set code = v_code,
      zone = v_zone,
      seat_count = p_seat_count,
      shape = v_shape,
      layout_x = p_layout_x,
      layout_y = p_layout_y,
      layout_width = p_layout_width,
      layout_height = p_layout_height,
      display_order = p_display_order,
      version = pt.version + 1,
      updated_at = now()
  where pt.id = p_table_id and pt.location_id = p_location_id
  returning * into v_table;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'physical_table', v_table.id, v_table.version,
    jsonb_build_object('table', public.dd010a_table_payload(v_table.id))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd010a_update_physical_table', 'physical_table', v_table.id,
    v_result, jsonb_build_object('code', v_code, 'zone', v_zone)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd010a_update_physical_table', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_LAYOUT_CHANGED', 'action', 'UPDATE'));
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_LAYOUT_CHANGED', 'action', 'UPDATE'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd010a_set_physical_table_active(
  p_location_id text,
  p_table_id text,
  p_active boolean,
  p_expected_version integer,
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
  v_table public.physical_tables;
  v_hash text := public.dd008c_hash_request(jsonb_build_object(
    'locationId', p_location_id, 'tableId', p_table_id, 'active', p_active, 'expectedVersion', p_expected_version
  ));
  v_replay jsonb;
  v_result jsonb;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'tables.manage_layout', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_set_physical_table_active', 'physical_table', p_table_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;
  if p_active is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_set_physical_table_active', 'physical_table', p_table_id,
      'VALIDATION_ERROR', 'ACTIVE_REQUIRED'
    );
    return;
  end if;

  v_replay := public.dd008c_replay_command(p_location_id, 'dd010a_set_physical_table_active', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_table
  from public.physical_tables pt
  where pt.id = p_table_id and pt.location_id = p_location_id
  for update;
  if v_table.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_set_physical_table_active', 'physical_table', p_table_id,
      'VALIDATION_ERROR', 'TABLE_NOT_FOUND'
    );
    return;
  end if;
  if p_expected_version is null or v_table.version <> p_expected_version then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_set_physical_table_active', 'physical_table', p_table_id,
      'CONFLICT', 'STALE_VERSION', jsonb_build_object('currentVersion', v_table.version)
    );
    return;
  end if;
  if v_table.is_active is not distinct from p_active then
    v_result := public.dd008c_result_json(
      true, 'OK', 'ALREADY_SET', 'physical_table', v_table.id, v_table.version,
      jsonb_build_object('table', public.dd010a_table_payload(v_table.id), 'noOp', true)
    );
    perform public.dd008c_audit_staff_result(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_set_physical_table_active', 'physical_table', v_table.id,
      v_result, jsonb_build_object('active', p_active)
    );
    perform public.dd008c_store_command(
      p_location_id, 'dd010a_set_physical_table_active', p_idempotency_key,
      'STAFF', v_authz.staff_profile_id, v_hash, v_result
    );
    return query select * from public.dd008c_result_from_json(v_result);
    return;
  end if;
  if p_active = false and exists (
    select 1 from public.table_sessions ts
    where ts.location_id = p_location_id and ts.physical_table_id = p_table_id and ts.status = 'OPEN'
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_set_physical_table_active', 'physical_table', p_table_id,
      'CONFLICT', 'OPEN_SESSION_ACTIVE_LOCKED'
    );
    return;
  end if;

  update public.physical_tables pt
  set is_active = p_active,
      version = pt.version + 1,
      updated_at = now()
  where pt.id = p_table_id and pt.location_id = p_location_id
  returning * into v_table;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'physical_table', v_table.id, v_table.version,
    jsonb_build_object('table', public.dd010a_table_payload(v_table.id))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd010a_set_physical_table_active', 'physical_table', v_table.id,
    v_result, jsonb_build_object('active', p_active)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd010a_set_physical_table_active', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_LAYOUT_CHANGED', 'action', case when p_active then 'ACTIVATE' else 'DEACTIVATE' end));
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_LAYOUT_CHANGED', 'action', case when p_active then 'ACTIVATE' else 'DEACTIVATE' end));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

create or replace function public.dd010a_rotate_physical_table_qr(
  p_location_id text,
  p_table_id text,
  p_expected_version integer,
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
  v_table public.physical_tables;
  v_hash text := public.dd008c_hash_request(jsonb_build_object('locationId', p_location_id, 'tableId', p_table_id, 'expectedVersion', p_expected_version));
  v_replay jsonb;
  v_result jsonb;
  v_qr_token text;
  v_attempt integer := 0;
begin
  select * into v_authz
  from public.dd008c_authorize_command(p_location_id, 'tables.rotate_qr', p_workstation_mode, p_device_credential)
  limit 1;
  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_rotate_physical_table_qr', 'physical_table', p_table_id,
      'FORBIDDEN', coalesce(v_authz.reason, 'PERMISSION_DENIED')
    );
    return;
  end if;

  v_replay := public.dd008c_replay_command(p_location_id, 'dd010a_rotate_physical_table_qr', p_idempotency_key, v_hash);
  if v_replay is not null then
    return query select * from public.dd008c_result_from_json(v_replay);
    return;
  end if;

  select * into v_table
  from public.physical_tables pt
  where pt.id = p_table_id and pt.location_id = p_location_id
  for update;
  if v_table.id is null then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_rotate_physical_table_qr', 'physical_table', p_table_id,
      'VALIDATION_ERROR', 'TABLE_NOT_FOUND'
    );
    return;
  end if;
  if p_expected_version is null or v_table.version <> p_expected_version then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_rotate_physical_table_qr', 'physical_table', p_table_id,
      'CONFLICT', 'STALE_VERSION', jsonb_build_object('currentVersion', v_table.version)
    );
    return;
  end if;
  if exists (
    select 1 from public.table_sessions ts
    where ts.location_id = p_location_id and ts.physical_table_id = p_table_id and ts.status = 'OPEN'
  ) then
    return query select * from public.dd008c_audited_failure(
      p_location_id, v_authz.staff_profile_id, v_authz.device_id,
      'dd010a_rotate_physical_table_qr', 'physical_table', p_table_id,
      'CONFLICT', 'OPEN_SESSION_QR_LOCKED'
    );
    return;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_qr_token := public.dd010a_generate_qr_token();
    exit when not exists (select 1 from public.physical_tables pt where pt.qr_token = v_qr_token);
    if v_attempt >= 5 then
      return query select * from public.dd008c_audited_failure(
        p_location_id, v_authz.staff_profile_id, v_authz.device_id,
        'dd010a_rotate_physical_table_qr', 'physical_table', p_table_id,
        'BACKEND_UNAVAILABLE', 'QR_TOKEN_GENERATION_FAILED'
      );
      return;
    end if;
  end loop;

  update public.physical_tables pt
  set qr_token = v_qr_token,
      version = pt.version + 1,
      updated_at = now()
  where pt.id = p_table_id and pt.location_id = p_location_id
  returning * into v_table;

  v_result := public.dd008c_result_json(
    true, 'OK', '', 'physical_table', v_table.id, v_table.version,
    jsonb_build_object('table', public.dd010a_table_payload(v_table.id))
  );
  perform public.dd008c_audit_staff_result(
    p_location_id, v_authz.staff_profile_id, v_authz.device_id,
    'dd010a_rotate_physical_table_qr', 'physical_table', v_table.id,
    v_result, jsonb_build_object('rotated', true)
  );
  perform public.dd008c_store_command(
    p_location_id, 'dd010a_rotate_physical_table_qr', p_idempotency_key,
    'STAFF', v_authz.staff_profile_id, v_hash, v_result
  );
  perform public.dd008c_emit_refresh(p_location_id, 'ops', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_QR_ROTATED'));
  perform public.dd008c_emit_refresh(p_location_id, 'admin', 'physical_table', v_table.id, jsonb_build_object('reason', 'TABLE_QR_ROTATED'));
  return query select * from public.dd008c_result_from_json(v_result);
end
$$;

revoke all on function public.dd010a_generate_table_id() from public, anon, authenticated;
revoke all on function public.dd010a_generate_qr_token() from public, anon, authenticated;
revoke all on function public.dd010a_table_payload(text) from public, anon, authenticated;
revoke all on function public.dd010a_get_admin_table_layout(text, text, text) from public, anon;
revoke all on function public.dd010a_create_physical_table(text, text, text, integer, text, integer, integer, integer, integer, integer, text, text, text) from public, anon;
revoke all on function public.dd010a_update_physical_table(text, text, text, text, integer, text, integer, integer, integer, integer, integer, integer, text, text, text) from public, anon;
revoke all on function public.dd010a_set_physical_table_active(text, text, boolean, integer, text, text, text) from public, anon;
revoke all on function public.dd010a_rotate_physical_table_qr(text, text, integer, text, text, text) from public, anon;

grant execute on function public.dd010a_get_admin_table_layout(text, text, text) to authenticated;
grant execute on function public.dd010a_create_physical_table(text, text, text, integer, text, integer, integer, integer, integer, integer, text, text, text) to authenticated;
grant execute on function public.dd010a_update_physical_table(text, text, text, text, integer, text, integer, integer, integer, integer, integer, integer, text, text, text) to authenticated;
grant execute on function public.dd010a_set_physical_table_active(text, text, boolean, integer, text, text, text) to authenticated;
grant execute on function public.dd010a_rotate_physical_table_qr(text, text, integer, text, text, text) to authenticated;
