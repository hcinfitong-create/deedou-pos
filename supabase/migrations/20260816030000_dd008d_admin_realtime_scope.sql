-- DD-008D least-privilege realtime scope for ADMIN_MENU surfaces.
-- Admin menu users should not gain orders.read merely to obtain connection health.
-- The admin audience is scoped to menu.manage so CASHIER/FLOOR devices cannot subscribe.

create or replace function public.dd008c_refresh_permission_for_audience(p_audience text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case coalesce(nullif(btrim(p_audience), ''), 'ops')
    when 'cashier' then 'payments.read'
    when 'audit' then 'audit.read'
    when 'admin' then 'menu.manage'
    else 'orders.read'
  end
$$;

create or replace function public.dd008c_refresh_audience_allowed(
  p_location_id text,
  p_audience text,
  p_ticket_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_audience text := coalesce(nullif(btrim(p_audience), ''), 'ops');
  v_ticket_id uuid;
begin
  if auth.uid() is null or coalesce(p_ticket_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_audience not in ('ops', 'cashier', 'audit', 'admin') then
    return false;
  end if;

  v_ticket_id := p_ticket_id::uuid;

  return exists (
    select 1
    from public.dd008c_realtime_subscription_tickets
    join public.workstation_devices
      on public.workstation_devices.id = public.dd008c_realtime_subscription_tickets.device_id
     and public.workstation_devices.location_id = public.dd008c_realtime_subscription_tickets.location_id
     and public.workstation_devices.mode = public.dd008c_realtime_subscription_tickets.workstation_mode
     and public.workstation_devices.active = true
    where public.dd008c_realtime_subscription_tickets.id = v_ticket_id
      and public.dd008c_realtime_subscription_tickets.auth_user_id = auth.uid()
      and public.dd008c_realtime_subscription_tickets.staff_profile_id = public.current_staff_id()
      and public.dd008c_realtime_subscription_tickets.location_id = p_location_id
      and public.dd008c_realtime_subscription_tickets.audience = v_audience
      and public.dd008c_realtime_subscription_tickets.expires_at > now()
      and public.is_active_staff() = true
      and public.has_location_access(p_location_id) = true
      and public.has_permission(p_location_id, public.dd008c_realtime_subscription_tickets.permission_key) = true
      and public.workstation_mode_allows_permission(
        public.dd008c_realtime_subscription_tickets.workstation_mode,
        public.dd008c_realtime_subscription_tickets.permission_key
      ) = true
  );
end
$$;

create or replace function public.dd008c_issue_realtime_ticket(
  p_location_id text,
  p_audience text default 'ops',
  p_workstation_mode text default '',
  p_device_credential text default ''
)
returns table (
  ok boolean,
  category text,
  reason text,
  entity_type text,
  entity_id text,
  version integer,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_audience text := coalesce(nullif(btrim(p_audience), ''), 'ops');
  v_permission text := public.dd008c_refresh_permission_for_audience(p_audience);
  v_authz record;
  v_ticket_id uuid := extensions.gen_random_uuid();
  v_expires_at timestamptz := now() + interval '30 minutes';
  v_topic text;
begin
  if v_audience not in ('ops', 'cashier', 'audit', 'admin') then
    return query select * from public.dd008c_failure(
      'VALIDATION_ERROR',
      'INVALID_REALTIME_AUDIENCE',
      'realtime_subscription',
      ''
    );
    return;
  end if;

  select *
  into v_authz
  from public.authorize_staff_access(p_location_id, v_permission, p_workstation_mode, p_device_credential)
  limit 1;

  if v_authz.ok is distinct from true then
    return query select * from public.dd008c_failure(
      case when coalesce(v_authz.reason, '') = 'SIGN_IN_REQUIRED' then 'UNAUTHENTICATED' else 'FORBIDDEN' end,
      coalesce(v_authz.reason, 'PERMISSION_DENIED'),
      'realtime_subscription',
      ''
    );
    return;
  end if;

  insert into public.dd008c_realtime_subscription_tickets (
    id,
    auth_user_id,
    staff_profile_id,
    location_id,
    audience,
    permission_key,
    device_id,
    workstation_mode,
    expires_at
  )
  values (
    v_ticket_id,
    auth.uid(),
    v_authz.staff_profile_id,
    p_location_id,
    v_audience,
    v_permission,
    v_authz.device_id,
    v_authz.workstation_mode,
    v_expires_at
  );

  v_topic := 'location:' || p_location_id || ':' || v_audience || ':' || v_ticket_id::text;

  return query select * from public.dd008c_success(
    'realtime_subscription',
    v_ticket_id::text,
    null,
    jsonb_build_object(
      'locationId', p_location_id,
      'audience', v_audience,
      'topic', v_topic,
      'expiresAt', v_expires_at,
      'workstationMode', v_authz.workstation_mode
    )
  );
end
$$;

create or replace function public.dd008d_product_availability_admin_refresh()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if old.available is distinct from new.available then
    perform public.dd008c_emit_refresh(
      new.location_id,
      'admin',
      'product',
      new.id,
      jsonb_build_object(
        'reason', 'PRODUCT_AVAILABILITY_CHANGED',
        'available', new.available
      )
    );
  end if;
  return new;
end
$$;

drop trigger if exists dd008d_products_admin_refresh on public.products;
create trigger dd008d_products_admin_refresh
after update of available on public.products
for each row
when (old.available is distinct from new.available)
execute function public.dd008d_product_availability_admin_refresh();

revoke all on function public.dd008d_product_availability_admin_refresh() from public;
revoke all on function public.dd008c_refresh_permission_for_audience(text) from public;
revoke all on function public.dd008c_refresh_audience_allowed(text, text, text) from public;
revoke all on function public.dd008c_issue_realtime_ticket(text, text, text, text) from public;

grant execute on function public.dd008c_refresh_audience_allowed(text, text, text) to authenticated;
grant execute on function public.dd008c_issue_realtime_ticket(text, text, text, text) to authenticated;
