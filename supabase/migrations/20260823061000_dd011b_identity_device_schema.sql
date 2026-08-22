-- DD-011B: single-owner identity, pending staff activation, and backend-managed device trust.

alter table public.staff_profiles
  add column if not exists username text,
  add column if not exists provisioning_status text not null default 'ACTIVE';

alter table public.staff_profiles
  drop constraint if exists staff_profiles_username_check,
  add constraint staff_profiles_username_check check (
    username is null
    or (
      username = lower(username)
      and username ~ '^[a-z0-9][a-z0-9_-]{2,31}$'
    )
  ),
  drop constraint if exists staff_profiles_provisioning_status_check,
  add constraint staff_profiles_provisioning_status_check check (
    provisioning_status in ('ACTIVE', 'PENDING_FIRST_LOGIN', 'PENDING_OWNER_APPROVAL', 'DISABLED')
  );

create unique index if not exists staff_profiles_username_ci_unique
on public.staff_profiles (lower(username))
where username is not null;

-- The accepted DeeDou model has exactly one active OWNER globally.
-- Production already contains one active OWNER; this index prevents a second.
create unique index if not exists staff_role_assignments_single_active_owner_idx
on public.staff_role_assignments ((role_id))
where role_id = 'OWNER' and active = true;

-- Security/device issuance is OWNER-authoritative. Existing permission rows are
-- preserved for compatibility/read surfaces; mutation tables below enforce OWNER + AAL2.

create table if not exists public.workstation_device_secrets (
  device_id text primary key references public.workstation_devices(id) on delete cascade,
  credential text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table if not exists public.workstation_device_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  device_id text not null references public.workstation_devices(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  session_token_hash text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint workstation_device_sessions_hash_check check (session_token_hash ~ '^[0-9a-f]{64}$'),
  constraint workstation_device_sessions_expiry_check check (expires_at > created_at)
);

create index if not exists workstation_device_sessions_user_active_idx
on public.workstation_device_sessions(auth_user_id, active, expires_at desc);

create index if not exists workstation_device_sessions_device_active_idx
on public.workstation_device_sessions(device_id, active, expires_at desc);

create table if not exists public.staff_activation_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  staff_profile_id text not null references public.staff_profiles(id) on delete restrict,
  location_id text not null references public.locations(id) on delete restrict,
  role_id text not null references public.roles(id) on delete restrict,
  device_label text not null,
  workstation_mode text not null,
  verification_code text not null,
  request_token_hash text not null unique,
  activation_kind text not null default 'FIRST_LOGIN',
  status text not null default 'PENDING',
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  approved_by_staff_profile_id text references public.staff_profiles(id) on delete restrict,
  rejected_at timestamptz,
  completed_at timestamptz,
  device_id text references public.workstation_devices(id) on delete restrict,
  constraint staff_activation_requests_code_check check (verification_code ~ '^[0-9]{6}$'),
  constraint staff_activation_requests_token_hash_check check (request_token_hash ~ '^[0-9a-f]{64}$'),
  constraint staff_activation_requests_kind_check check (activation_kind in ('FIRST_LOGIN', 'NEW_DEVICE')),
  constraint staff_activation_requests_status_check check (status in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'COMPLETED')),
  constraint staff_activation_requests_expiry_check check (expires_at > requested_at),
  constraint staff_activation_requests_mode_check check (workstation_mode in ('CASHIER', 'STAFF', 'KDS_KITCHEN', 'KDS_BAR', 'KDS_DESSERT', 'ADMIN'))
);

create index if not exists staff_activation_requests_pending_idx
on public.staff_activation_requests(status, expires_at, requested_at desc);

create index if not exists staff_activation_requests_staff_idx
on public.staff_activation_requests(staff_profile_id, requested_at desc);

alter table public.workstation_device_secrets enable row level security;
alter table public.workstation_device_sessions enable row level security;
alter table public.staff_activation_requests enable row level security;

revoke all on public.workstation_device_secrets from anon, authenticated;
revoke all on public.workstation_device_sessions from anon, authenticated;
revoke all on public.staff_activation_requests from anon, authenticated;
grant select, insert, update, delete on public.workstation_device_secrets to service_role;
grant select, insert, update, delete on public.workstation_device_sessions to service_role;
grant select, insert, update, delete on public.staff_activation_requests to service_role;

create or replace function public.dd011b_is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles sp
    join public.staff_location_assignments sla
      on sla.staff_profile_id = sp.id
     and sla.active = true
    join public.staff_role_assignments sra
      on sra.staff_profile_id = sp.id
     and sra.location_id = sla.location_id
     and sra.role_id = 'OWNER'
     and sra.active = true
    where sp.auth_user_id = auth.uid()
      and sp.active = true
  )
$$;

-- OWNER sessions must be AAL2 for every protected staff/admin RPC, not only
-- security mutations. Initial Owner bootstrap uses dd011b_owner_bootstrap_eligible()
-- because no trusted device exists yet.
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
  v_context record;
begin
  select *
  into v_context
  from public.resolve_staff_workstation_context(p_location_id, p_workstation_mode, p_device_credential)
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
    return query select false, 'MFA_REQUIRED', v_context.staff_profile_id, p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  if public.has_permission(p_location_id, p_permission_key) = false then
    return query select false, 'PERMISSION_DENIED', v_context.staff_profile_id, p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  if public.workstation_mode_allows_permission(v_context.workstation_mode, p_permission_key) = false then
    return query select false, 'DEVICE_MODE_DENIED', v_context.staff_profile_id, p_location_id, v_context.device_id, v_context.workstation_mode;
    return;
  end if;

  return query select true, ''::text, v_context.staff_profile_id, p_location_id, v_context.device_id, v_context.workstation_mode;
end
$$;

create or replace function public.dd011b_owner_bootstrap_eligible()
returns table (ok boolean, reason text, staff_profile_id text, location_id text)
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

  if exists (
    select 1
    from public.workstation_device_sessions s
    where s.auth_user_id = auth.uid()
      and s.active = true
      and s.expires_at > now()
  ) then
    return query select false, 'OWNER_DEVICE_ALREADY_ACTIVE', v_staff_id, v_location_id;
    return;
  end if;

  return query select true, '', v_staff_id, v_location_id;
end
$$;

-- Service-role helper used only by the same-origin backend after the caller's
-- Supabase JWT has independently passed dd011b_owner_bootstrap_eligible().
create or replace function public.dd011b_service_bootstrap_owner_device(
  p_owner_auth_user_id uuid,
  p_label text,
  p_session_token_hash text,
  p_expires_at timestamptz
)
returns table (ok boolean, reason text, device_id text, location_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff_id text;
  v_location_id text;
  v_device_id text;
  v_credential text;
begin

  if p_session_token_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    return query select false, 'VALIDATION_ERROR', ''::text, ''::text;
    return;
  end if;

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
  where sp.auth_user_id = p_owner_auth_user_id
    and sp.active = true
  limit 1;

  if v_staff_id is null then
    return query select false, 'OWNER_REQUIRED', ''::text, ''::text;
    return;
  end if;

  if exists (
    select 1 from public.workstation_device_sessions
    where auth_user_id = p_owner_auth_user_id
      and active = true
      and expires_at > now()
  ) then
    return query select false, 'OWNER_DEVICE_ALREADY_ACTIVE', ''::text, v_location_id;
    return;
  end if;

  v_device_id := public.generate_device_id();
  v_credential := public.generate_device_credential();

  insert into public.workstation_devices (
    id, location_id, label, mode, credential_hash, active,
    registered_by_staff_profile_id
  ) values (
    v_device_id,
    v_location_id,
    coalesce(nullif(btrim(p_label), ''), 'Owner Admin'),
    'ADMIN',
    public.hash_device_credential(v_credential),
    true,
    v_staff_id
  );

  insert into public.workstation_device_secrets(device_id, credential)
  values (v_device_id, v_credential);

  insert into public.workstation_device_sessions(
    device_id, auth_user_id, session_token_hash, expires_at
  ) values (
    v_device_id, p_owner_auth_user_id, p_session_token_hash, p_expires_at
  );

  perform public.dd008c_write_audit(
    v_location_id, 'STAFF', v_staff_id, v_staff_id, v_device_id,
    'dd011b_service_bootstrap_owner_device', 'workstation_device', v_device_id,
    'REGISTERED', jsonb_build_object('mode', 'ADMIN', 'backendManaged', true)
  );

  return query select true, '', v_device_id, v_location_id;
end
$$;

-- Explicit ACLs for bootstrap helpers.
revoke all on function public.dd011b_is_owner() from public, anon, authenticated;
revoke all on function public.dd011b_service_bootstrap_owner_device(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.dd011b_service_bootstrap_owner_device(uuid, text, text, timestamptz) to service_role;
revoke all on function public.dd011b_owner_bootstrap_eligible() from public, anon;
grant execute on function public.dd011b_owner_bootstrap_eligible() to authenticated;
