-- DD-008B Auth/RBAC foundation.
-- Staff identity, location-scoped RBAC, workstation devices, and authz helpers only.

create table if not exists public.staff_profiles (
  id text primary key,
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roles (
  id text primary key,
  role_key text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id text primary key,
  permission_key text not null unique,
  description text not null default ''
);

create table if not exists public.role_permissions (
  role_id text not null references public.roles(id) on delete cascade,
  permission_id text not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists public.staff_location_assignments (
  staff_profile_id text not null references public.staff_profiles(id) on delete restrict,
  location_id text not null references public.locations(id) on delete restrict,
  active boolean not null default true,
  assigned_at timestamptz not null default now(),
  primary key (staff_profile_id, location_id)
);

create table if not exists public.staff_role_assignments (
  staff_profile_id text not null references public.staff_profiles(id) on delete restrict,
  location_id text not null references public.locations(id) on delete restrict,
  role_id text not null references public.roles(id) on delete restrict,
  active boolean not null default true,
  assigned_at timestamptz not null default now(),
  primary key (staff_profile_id, location_id, role_id)
);

create table if not exists public.workstation_devices (
  id text primary key,
  location_id text not null references public.locations(id) on delete restrict,
  label text not null,
  mode text not null check (mode in ('CASHIER', 'STAFF', 'KDS_KITCHEN', 'KDS_BAR', 'KDS_DESSERT', 'ADMIN')),
  credential_hash text not null unique,
  active boolean not null default true,
  registered_by_staff_profile_id text references public.staff_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists staff_profiles_auth_user_idx
on public.staff_profiles(auth_user_id);

create index if not exists staff_location_assignments_location_idx
on public.staff_location_assignments(location_id, active);

create index if not exists staff_role_assignments_staff_location_idx
on public.staff_role_assignments(staff_profile_id, location_id, active);

create index if not exists role_permissions_permission_idx
on public.role_permissions(permission_id, role_id);

create index if not exists workstation_devices_location_hash_idx
on public.workstation_devices(location_id, credential_hash, active);

alter table public.staff_profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.staff_location_assignments enable row level security;
alter table public.staff_role_assignments enable row level security;
alter table public.workstation_devices enable row level security;

revoke all on public.staff_profiles from anon, authenticated;
revoke all on public.roles from anon, authenticated;
revoke all on public.permissions from anon, authenticated;
revoke all on public.role_permissions from anon, authenticated;
revoke all on public.staff_location_assignments from anon, authenticated;
revoke all on public.staff_role_assignments from anon, authenticated;
revoke all on public.workstation_devices from anon, authenticated;

insert into public.permissions (id, permission_key, description)
values
  ('menu.read', 'menu.read', 'Read staff menu catalog'),
  ('menu.manage', 'menu.manage', 'Manage menu products and pricing'),
  ('orders.read', 'orders.read', 'Read operational orders'),
  ('orders.accept', 'orders.accept', 'Accept or reject customer orders'),
  ('orders.create_staff', 'orders.create_staff', 'Create staff/counter orders'),
  ('service.serve', 'service.serve', 'Mark prepared items served'),
  ('service_requests.read', 'service_requests.read', 'Read open service requests'),
  ('service_requests.complete', 'service_requests.complete', 'Complete service requests'),
  ('course.manage', 'course.manage', 'Manage course pacing'),
  ('kds.kitchen', 'kds.kitchen', 'Use kitchen KDS'),
  ('kds.bar', 'kds.bar', 'Use bar KDS'),
  ('kds.dessert', 'kds.dessert', 'Use dessert KDS'),
  ('tables.read', 'tables.read', 'Read floor table state'),
  ('tables.manage_session', 'tables.manage_session', 'Open, close, and transfer table visits'),
  ('payments.read', 'payments.read', 'Read payment ledger'),
  ('payments.record', 'payments.record', 'Record local/manual payment'),
  ('payments.void', 'payments.void', 'Void a payment'),
  ('payments.refund', 'payments.refund', 'Refund a selected payment'),
  ('audit.read', 'audit.read', 'Read audit trail'),
  ('staff.read', 'staff.read', 'Read staff profiles and assignments'),
  ('staff.manage', 'staff.manage', 'Manage staff assignments within delegation ceiling'),
  ('devices.manage', 'devices.manage', 'Register and revoke workstation devices')
on conflict (id) do update
set permission_key = excluded.permission_key,
    description = excluded.description;

insert into public.roles (id, role_key, name)
values
  ('OWNER', 'OWNER', 'Owner'),
  ('MANAGER', 'MANAGER', 'Manager'),
  ('CASHIER', 'CASHIER', 'Cashier'),
  ('FLOOR_STAFF', 'FLOOR_STAFF', 'Floor Staff'),
  ('KITCHEN', 'KITCHEN', 'Kitchen'),
  ('BAR', 'BAR', 'Bar'),
  ('DESSERT', 'DESSERT', 'Dessert'),
  ('ADMIN_MENU', 'ADMIN_MENU', 'Menu Admin')
on conflict (id) do update
set role_key = excluded.role_key,
    name = excluded.name;

insert into public.role_permissions (role_id, permission_id)
select 'OWNER', public.permissions.id
from public.permissions
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
values
  ('MANAGER', 'menu.read'),
  ('MANAGER', 'orders.read'),
  ('MANAGER', 'orders.accept'),
  ('MANAGER', 'orders.create_staff'),
  ('MANAGER', 'service.serve'),
  ('MANAGER', 'service_requests.read'),
  ('MANAGER', 'service_requests.complete'),
  ('MANAGER', 'course.manage'),
  ('MANAGER', 'tables.read'),
  ('MANAGER', 'tables.manage_session'),
  ('MANAGER', 'payments.read'),
  ('MANAGER', 'payments.record'),
  ('MANAGER', 'payments.void'),
  ('MANAGER', 'payments.refund'),
  ('MANAGER', 'audit.read'),
  ('MANAGER', 'staff.read'),
  ('MANAGER', 'staff.manage'),
  ('MANAGER', 'devices.manage'),
  ('CASHIER', 'menu.read'),
  ('CASHIER', 'orders.read'),
  ('CASHIER', 'orders.create_staff'),
  ('CASHIER', 'service_requests.read'),
  ('CASHIER', 'tables.read'),
  ('CASHIER', 'tables.manage_session'),
  ('CASHIER', 'payments.read'),
  ('CASHIER', 'payments.record'),
  ('CASHIER', 'payments.void'),
  ('FLOOR_STAFF', 'menu.read'),
  ('FLOOR_STAFF', 'orders.read'),
  ('FLOOR_STAFF', 'orders.accept'),
  ('FLOOR_STAFF', 'service.serve'),
  ('FLOOR_STAFF', 'service_requests.read'),
  ('FLOOR_STAFF', 'service_requests.complete'),
  ('FLOOR_STAFF', 'course.manage'),
  ('FLOOR_STAFF', 'tables.read'),
  ('KITCHEN', 'orders.read'),
  ('KITCHEN', 'kds.kitchen'),
  ('BAR', 'orders.read'),
  ('BAR', 'kds.bar'),
  ('DESSERT', 'orders.read'),
  ('DESSERT', 'kds.dessert'),
  ('ADMIN_MENU', 'menu.read'),
  ('ADMIN_MENU', 'menu.manage')
on conflict do nothing;

create or replace function public.hash_device_credential(p_device_credential text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when length(btrim(coalesce(p_device_credential, ''))) = 0 then ''
    else md5('deedou-device-v1:' || p_device_credential)
  end
$$;

create or replace function public.current_staff_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.staff_profiles.id
  from public.staff_profiles
  where public.staff_profiles.auth_user_id = auth.uid()
  limit 1
$$;

create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles
    where public.staff_profiles.auth_user_id = auth.uid()
      and public.staff_profiles.active = true
  )
$$;

create or replace function public.has_location_access(p_location_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles
    join public.staff_location_assignments
      on public.staff_location_assignments.staff_profile_id = public.staff_profiles.id
    where public.staff_profiles.auth_user_id = auth.uid()
      and public.staff_profiles.active = true
      and public.staff_location_assignments.location_id = p_location_id
      and public.staff_location_assignments.active = true
  )
$$;

create or replace function public.has_permission(p_location_id text, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles
    join public.staff_location_assignments
      on public.staff_location_assignments.staff_profile_id = public.staff_profiles.id
     and public.staff_location_assignments.location_id = p_location_id
     and public.staff_location_assignments.active = true
    join public.staff_role_assignments
      on public.staff_role_assignments.staff_profile_id = public.staff_profiles.id
     and public.staff_role_assignments.location_id = p_location_id
     and public.staff_role_assignments.active = true
    join public.role_permissions
      on public.role_permissions.role_id = public.staff_role_assignments.role_id
    join public.permissions
      on public.permissions.id = public.role_permissions.permission_id
    where public.staff_profiles.auth_user_id = auth.uid()
      and public.staff_profiles.active = true
      and public.permissions.permission_key = p_permission_key
  )
$$;

create or replace function public.workstation_mode_allows_permission(p_mode text, p_permission_key text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_mode
    when 'CASHIER' then p_permission_key in (
      'menu.read',
      'orders.read',
      'orders.create_staff',
      'service_requests.read',
      'tables.read',
      'tables.manage_session',
      'payments.read',
      'payments.record',
      'payments.void',
      'payments.refund'
    )
    when 'STAFF' then p_permission_key in (
      'menu.read',
      'orders.read',
      'orders.accept',
      'service.serve',
      'service_requests.read',
      'service_requests.complete',
      'course.manage',
      'tables.read'
    )
    when 'KDS_KITCHEN' then p_permission_key in ('orders.read', 'kds.kitchen')
    when 'KDS_BAR' then p_permission_key in ('orders.read', 'kds.bar')
    when 'KDS_DESSERT' then p_permission_key in ('orders.read', 'kds.dessert')
    when 'ADMIN' then p_permission_key in (
      'menu.read',
      'menu.manage',
      'tables.read',
      'audit.read',
      'staff.read',
      'staff.manage',
      'devices.manage'
    )
    else false
  end
$$;

create or replace function public.resolve_registered_device(p_location_id text, p_device_credential text)
returns table (
  device_id text,
  location_id text,
  mode text,
  active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.workstation_devices.id,
    public.workstation_devices.location_id,
    public.workstation_devices.mode,
    public.workstation_devices.active
  from public.workstation_devices
  where public.workstation_devices.location_id = p_location_id
    and public.workstation_devices.credential_hash = public.hash_device_credential(p_device_credential)
    and public.workstation_devices.active = true
    and public.has_location_access(p_location_id)
  limit 1
$$;

create or replace function public.authorize_staff_access(
  p_location_id text,
  p_permission_key text,
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
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
  v_staff_id text;
  v_device_id text := '';
  v_device_mode text := '';
begin
  if auth.uid() is null then
    return query select false, 'SIGN_IN_REQUIRED', ''::text, p_location_id, ''::text, ''::text;
    return;
  end if;

  v_staff_id := public.current_staff_id();
  if v_staff_id is null or public.is_active_staff() = false then
    return query select false, 'STAFF_INACTIVE', coalesce(v_staff_id, ''), p_location_id, ''::text, ''::text;
    return;
  end if;

  if public.has_location_access(p_location_id) = false then
    return query select false, 'LOCATION_DENIED', v_staff_id, p_location_id, ''::text, ''::text;
    return;
  end if;

  if public.has_permission(p_location_id, p_permission_key) = false then
    return query select false, 'PERMISSION_DENIED', v_staff_id, p_location_id, ''::text, ''::text;
    return;
  end if;

  select resolved_device.device_id, resolved_device.mode
  into v_device_id, v_device_mode
  from public.resolve_registered_device(p_location_id, p_device_credential) as resolved_device
  limit 1;

  if v_device_id is null or v_device_id = '' then
    return query select false, 'DEVICE_UNREGISTERED', v_staff_id, p_location_id, ''::text, ''::text;
    return;
  end if;

  if length(btrim(coalesce(p_workstation_mode, ''))) > 0
     and v_device_mode <> p_workstation_mode then
    return query select false, 'DEVICE_MODE_DENIED', v_staff_id, p_location_id, v_device_id, v_device_mode;
    return;
  end if;

  if public.workstation_mode_allows_permission(v_device_mode, p_permission_key) = false then
    return query select false, 'DEVICE_MODE_DENIED', v_staff_id, p_location_id, v_device_id, v_device_mode;
    return;
  end if;

  return query select true, ''::text, v_staff_id, p_location_id, v_device_id, v_device_mode;
end
$$;

create or replace function public.get_my_staff_context(
  p_location_id text default null,
  p_device_credential text default ''
)
returns table (
  staff_profile_id text,
  display_name text,
  active boolean,
  location_id text,
  location_name text,
  roles text[],
  permissions text[],
  device_id text,
  workstation_mode text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.staff_profiles.id,
    public.staff_profiles.display_name,
    public.staff_profiles.active,
    public.locations.id,
    public.locations.name,
    coalesce(
      array_remove(array_agg(distinct public.roles.role_key), null),
      array[]::text[]
    ),
    coalesce(
      array_remove(array_agg(distinct public.permissions.permission_key), null),
      array[]::text[]
    ),
    public.workstation_devices.id,
    public.workstation_devices.mode
  from public.staff_profiles
  join public.staff_location_assignments
    on public.staff_location_assignments.staff_profile_id = public.staff_profiles.id
   and public.staff_location_assignments.active = true
  join public.locations
    on public.locations.id = public.staff_location_assignments.location_id
  left join public.staff_role_assignments
    on public.staff_role_assignments.staff_profile_id = public.staff_profiles.id
   and public.staff_role_assignments.location_id = public.locations.id
   and public.staff_role_assignments.active = true
  left join public.roles
    on public.roles.id = public.staff_role_assignments.role_id
  left join public.role_permissions
    on public.role_permissions.role_id = public.roles.id
  left join public.permissions
    on public.permissions.id = public.role_permissions.permission_id
  left join public.workstation_devices
    on public.workstation_devices.location_id = public.locations.id
   and public.workstation_devices.credential_hash = public.hash_device_credential(p_device_credential)
   and public.workstation_devices.active = true
  where public.staff_profiles.auth_user_id = auth.uid()
    and public.staff_profiles.active = true
    and (p_location_id is null or public.locations.id = p_location_id)
  group by
    public.staff_profiles.id,
    public.staff_profiles.display_name,
    public.staff_profiles.active,
    public.locations.id,
    public.locations.name,
    public.workstation_devices.id,
    public.workstation_devices.mode
$$;

create or replace function public.list_staff_menu_products(p_location_id text)
returns table (
  id text,
  location_id text,
  kind text,
  category text,
  name_vi text,
  name_en text,
  price_vnd integer,
  station_code text,
  available boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.products.id,
    public.products.location_id,
    public.products.kind,
    public.products.category,
    public.products.name_vi,
    public.products.name_en,
    public.products.price_vnd,
    public.products.station_code,
    public.products.available
  from public.products
  where public.products.location_id = p_location_id
    and public.has_permission(p_location_id, 'menu.read')
$$;

create or replace function public.list_staff_tables(p_location_id text)
returns table (
  id text,
  location_id text,
  code text,
  zone text,
  is_active boolean,
  display_order integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.physical_tables.id,
    public.physical_tables.location_id,
    public.physical_tables.code,
    public.physical_tables.zone,
    public.physical_tables.is_active,
    public.physical_tables.display_order
  from public.physical_tables
  where public.physical_tables.location_id = p_location_id
    and public.has_permission(p_location_id, 'tables.read')
  order by public.physical_tables.display_order, public.physical_tables.code
$$;

create or replace function public.list_staff_orders(p_location_id text)
returns table (
  id text,
  location_id text,
  order_no text,
  table_session_id text,
  table_code text,
  zone text,
  status text,
  service_mode text,
  fulfillment_type text,
  total_vnd integer,
  payment_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.orders.id,
    public.orders.location_id,
    public.orders.order_no,
    public.orders.table_session_id,
    public.orders.table_code,
    public.orders.zone,
    public.orders.status,
    public.orders.service_mode,
    public.orders.fulfillment_type,
    public.orders.total_vnd,
    public.orders.payment_status
  from public.orders
  where public.orders.location_id = p_location_id
    and public.has_permission(p_location_id, 'orders.read')
  order by public.orders.created_at desc, public.orders.id
$$;

create or replace function public.list_staff_service_requests(p_location_id text)
returns table (
  id text,
  location_id text,
  table_session_id text,
  table_code text,
  zone text,
  type text,
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.service_requests.id,
    public.service_requests.location_id,
    public.service_requests.table_session_id,
    public.service_requests.table_code,
    public.service_requests.zone,
    public.service_requests.type,
    public.service_requests.status,
    public.service_requests.created_at
  from public.service_requests
  where public.service_requests.location_id = p_location_id
    and public.has_permission(p_location_id, 'service_requests.read')
  order by public.service_requests.created_at desc, public.service_requests.id
$$;

create or replace function public.list_staff_payment_transactions(p_location_id text)
returns table (
  id text,
  location_id text,
  order_id text,
  type text,
  method text,
  provider text,
  amount_vnd integer,
  status text,
  related_payment_id text,
  tender_group_id text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.payment_transactions.id,
    public.payment_transactions.location_id,
    public.payment_transactions.order_id,
    public.payment_transactions.type,
    public.payment_transactions.method,
    public.payment_transactions.provider,
    public.payment_transactions.amount_vnd,
    public.payment_transactions.status,
    public.payment_transactions.related_payment_id,
    public.payment_transactions.tender_group_id,
    public.payment_transactions.created_at
  from public.payment_transactions
  where public.payment_transactions.location_id = p_location_id
    and public.has_permission(p_location_id, 'payments.read')
  order by public.payment_transactions.created_at desc, public.payment_transactions.id
$$;

create or replace function public.prepare_audit_context(
  p_location_id text,
  p_device_credential text default '',
  p_workstation_mode text default '',
  p_command text default '',
  p_target_type text default '',
  p_target_id text default '',
  p_outcome text default '',
  p_client_actor_id text default ''
)
returns table (
  auth_user_id uuid,
  staff_profile_id text,
  location_id text,
  device_id text,
  workstation_mode text,
  command text,
  target_type text,
  target_id text,
  outcome text,
  client_actor_ignored boolean,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff_id text := public.current_staff_id();
  v_device_id text := '';
  v_device_mode text := '';
begin
  select resolved_device.device_id, resolved_device.mode
  into v_device_id, v_device_mode
  from public.resolve_registered_device(p_location_id, p_device_credential) as resolved_device
  limit 1;

  return query select
    auth.uid(),
    coalesce(v_staff_id, ''),
    p_location_id,
    coalesce(v_device_id, ''),
    case
      when length(btrim(coalesce(p_workstation_mode, ''))) > 0 then p_workstation_mode
      else coalesce(v_device_mode, '')
    end,
    p_command,
    p_target_type,
    p_target_id,
    p_outcome,
    length(btrim(coalesce(p_client_actor_id, ''))) > 0
      and p_client_actor_id <> coalesce(v_staff_id, ''),
    now();
end
$$;

create or replace function public.can_assign_staff_location(
  p_target_staff_profile_id text,
  p_location_id text
)
returns table (
  ok boolean,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_staff_id text := public.current_staff_id();
begin
  if v_actor_staff_id is null or public.is_active_staff() = false then
    return query select false, 'STAFF_INACTIVE';
    return;
  end if;

  if p_target_staff_profile_id = v_actor_staff_id then
    return query select false, 'SELF_ESCALATION_BLOCKED';
    return;
  end if;

  if public.has_permission(p_location_id, 'staff.manage') = false then
    return query select false, 'LOCATION_DENIED';
    return;
  end if;

  if not exists (
    select 1
    from public.staff_profiles
    where public.staff_profiles.id = p_target_staff_profile_id
  ) then
    return query select false, 'TARGET_STAFF_NOT_FOUND';
    return;
  end if;

  return query select true, '';
end
$$;

create or replace function public.assign_staff_to_location(
  p_target_staff_profile_id text,
  p_location_id text
)
returns table (
  ok boolean,
  reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allowed record;
begin
  select *
  into v_allowed
  from public.can_assign_staff_location(p_target_staff_profile_id, p_location_id)
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

create or replace function public.can_grant_role_at_location(
  p_target_staff_profile_id text,
  p_location_id text,
  p_role_id text
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

  if public.has_permission(p_location_id, 'staff.manage') = false then
    return query select false, 'LOCATION_DENIED', v_missing_permissions;
    return;
  end if;

  if not exists (
    select 1
    from public.staff_location_assignments
    where public.staff_location_assignments.staff_profile_id = p_target_staff_profile_id
      and public.staff_location_assignments.location_id = p_location_id
      and public.staff_location_assignments.active = true
  ) then
    return query select false, 'TARGET_LOCATION_DENIED', v_missing_permissions;
    return;
  end if;

  if not exists (
    select 1
    from public.roles
    where public.roles.id = p_role_id
  ) then
    return query select false, 'ROLE_NOT_FOUND', v_missing_permissions;
    return;
  end if;

  select coalesce(array_agg(public.permissions.permission_key order by public.permissions.permission_key), array[]::text[])
  into v_missing_permissions
  from public.role_permissions
  join public.permissions
    on public.permissions.id = public.role_permissions.permission_id
  where public.role_permissions.role_id = p_role_id
    and public.has_permission(p_location_id, public.permissions.permission_key) = false;

  if cardinality(v_missing_permissions) > 0 then
    return query select false, 'PRIVILEGE_CEILING_EXCEEDED', v_missing_permissions;
    return;
  end if;

  return query select true, '', v_missing_permissions;
end
$$;

create or replace function public.assign_staff_role_at_location(
  p_target_staff_profile_id text,
  p_location_id text,
  p_role_id text
)
returns table (
  ok boolean,
  reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allowed record;
begin
  select *
  into v_allowed
  from public.can_grant_role_at_location(p_target_staff_profile_id, p_location_id, p_role_id)
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

  return query select true, '';
end
$$;

create or replace function public.register_workstation_device(
  p_location_id text,
  p_label text,
  p_mode text,
  p_device_credential text,
  p_device_id text default ''
)
returns table (
  ok boolean,
  reason text,
  device_id text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device_id text;
begin
  if public.has_permission(p_location_id, 'devices.manage') = false then
    return query select false, 'PERMISSION_DENIED', ''::text;
    return;
  end if;

  if public.workstation_mode_allows_permission(p_mode, 'orders.read') = false
     and p_mode <> 'ADMIN' then
    return query select false, 'DEVICE_MODE_DENIED', ''::text;
    return;
  end if;

  if length(btrim(coalesce(p_device_credential, ''))) < 20 then
    return query select false, 'DEVICE_CREDENTIAL_WEAK', ''::text;
    return;
  end if;

  v_device_id := coalesce(
    nullif(btrim(p_device_id), ''),
    'DEV-' || substring(public.hash_device_credential(p_device_credential) from 1 for 24)
  );

  insert into public.workstation_devices (
    id,
    location_id,
    label,
    mode,
    credential_hash,
    active,
    registered_by_staff_profile_id,
    revoked_at
  )
  values (
    v_device_id,
    p_location_id,
    coalesce(nullif(btrim(p_label), ''), p_mode),
    p_mode,
    public.hash_device_credential(p_device_credential),
    true,
    public.current_staff_id(),
    null
  )
  on conflict (credential_hash) do update
  set location_id = excluded.location_id,
      label = excluded.label,
      mode = excluded.mode,
      active = true,
      registered_by_staff_profile_id = excluded.registered_by_staff_profile_id,
      revoked_at = null;

  return query select true, '', v_device_id;
end
$$;

create or replace function public.revoke_workstation_device(
  p_location_id text,
  p_device_id text
)
returns table (
  ok boolean,
  reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if public.has_permission(p_location_id, 'devices.manage') = false then
    return query select false, 'PERMISSION_DENIED';
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

  return query select true, '';
end
$$;

revoke all on function public.hash_device_credential(text) from public;
revoke all on function public.current_staff_id() from public;
revoke all on function public.is_active_staff() from public;
revoke all on function public.has_location_access(text) from public;
revoke all on function public.has_permission(text, text) from public;
revoke all on function public.workstation_mode_allows_permission(text, text) from public;
revoke all on function public.resolve_registered_device(text, text) from public;
revoke all on function public.authorize_staff_access(text, text, text, text) from public;
revoke all on function public.get_my_staff_context(text, text) from public;
revoke all on function public.list_staff_menu_products(text) from public;
revoke all on function public.list_staff_tables(text) from public;
revoke all on function public.list_staff_orders(text) from public;
revoke all on function public.list_staff_service_requests(text) from public;
revoke all on function public.list_staff_payment_transactions(text) from public;
revoke all on function public.prepare_audit_context(text, text, text, text, text, text, text, text) from public;
revoke all on function public.can_assign_staff_location(text, text) from public;
revoke all on function public.assign_staff_to_location(text, text) from public;
revoke all on function public.can_grant_role_at_location(text, text, text) from public;
revoke all on function public.assign_staff_role_at_location(text, text, text) from public;
revoke all on function public.register_workstation_device(text, text, text, text, text) from public;
revoke all on function public.revoke_workstation_device(text, text) from public;

grant execute on function public.authorize_staff_access(text, text, text, text) to anon, authenticated;
grant execute on function public.current_staff_id() to authenticated;
grant execute on function public.is_active_staff() to authenticated;
grant execute on function public.has_location_access(text) to authenticated;
grant execute on function public.has_permission(text, text) to authenticated;
grant execute on function public.workstation_mode_allows_permission(text, text) to authenticated;
grant execute on function public.resolve_registered_device(text, text) to authenticated;
grant execute on function public.get_my_staff_context(text, text) to authenticated;
grant execute on function public.list_staff_menu_products(text) to authenticated;
grant execute on function public.list_staff_tables(text) to authenticated;
grant execute on function public.list_staff_orders(text) to authenticated;
grant execute on function public.list_staff_service_requests(text) to authenticated;
grant execute on function public.list_staff_payment_transactions(text) to authenticated;
grant execute on function public.prepare_audit_context(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.can_assign_staff_location(text, text) to authenticated;
grant execute on function public.assign_staff_to_location(text, text) to authenticated;
grant execute on function public.can_grant_role_at_location(text, text, text) to authenticated;
grant execute on function public.assign_staff_role_at_location(text, text, text) to authenticated;
grant execute on function public.register_workstation_device(text, text, text, text, text) to authenticated;
grant execute on function public.revoke_workstation_device(text, text) to authenticated;
