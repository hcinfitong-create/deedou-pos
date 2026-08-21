-- DD-011 follow-up: keep dd011_list_staff_admin output types exact for PL/pgSQL RETURN QUERY.
-- auth.users.email is varchar in GoTrue; the public RPC contract deliberately exposes text.

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
    coalesce(auth.users.email::text, ''::text),
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
