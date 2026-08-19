begin;

-- Internal helpers must not be directly executable by browser roles.
do $$
declare
  fn regprocedure;
begin
  foreach fn in array array[
    'public.hash_device_credential(text)'::regprocedure,
    'public.generate_device_credential()'::regprocedure,
    'public.generate_device_id()'::regprocedure,
    'public.resolve_registered_device(text,text)'::regprocedure,
    'public.resolve_staff_workstation_context(text,text,text)'::regprocedure
  ]
  loop
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception 'anon unexpectedly has EXECUTE on %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'authenticated unexpectedly has EXECUTE on internal helper %', fn;
    end if;
  end loop;
end
$$;

-- Only authorize_staff_access is intentionally callable by anon for deterministic
-- SIGN_IN_REQUIRED responses. All other DD-008B browser RPCs require authentication.
do $$
declare
  fn regprocedure;
begin
  if not has_function_privilege('anon', 'public.authorize_staff_access(text,text,text,text)'::regprocedure, 'EXECUTE') then
    raise exception 'anon must be able to call authorize_staff_access';
  end if;
  if not has_function_privilege('authenticated', 'public.authorize_staff_access(text,text,text,text)'::regprocedure, 'EXECUTE') then
    raise exception 'authenticated must be able to call authorize_staff_access';
  end if;

  foreach fn in array array[
    'public.current_staff_id()'::regprocedure,
    'public.is_active_staff()'::regprocedure,
    'public.has_location_access(text)'::regprocedure,
    'public.has_permission(text,text)'::regprocedure,
    'public.workstation_mode_allows_permission(text,text)'::regprocedure,
    'public.get_my_staff_context(text,text,text)'::regprocedure,
    'public.list_staff_menu_products(text,text,text)'::regprocedure,
    'public.list_staff_tables(text,text,text)'::regprocedure,
    'public.list_staff_orders(text,text,text)'::regprocedure,
    'public.list_staff_service_requests(text,text,text)'::regprocedure,
    'public.list_staff_payment_transactions(text,text,text)'::regprocedure,
    'public.prepare_audit_context(text,text,text,text,text,text,text,text)'::regprocedure,
    'public.can_assign_staff_location(text,text,text,text)'::regprocedure,
    'public.assign_staff_to_location(text,text,text,text)'::regprocedure,
    'public.can_grant_role_at_location(text,text,text,text,text)'::regprocedure,
    'public.assign_staff_role_at_location(text,text,text,text,text)'::regprocedure,
    'public.register_workstation_device(text,text,text,text,text)'::regprocedure,
    'public.revoke_workstation_device(text,text,text,text)'::regprocedure
  ]
  loop
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception 'anon unexpectedly has EXECUTE on authenticated RPC %', fn;
    end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'authenticated missing EXECUTE on %', fn;
    end if;
  end loop;
end
$$;

-- Hosted Supabase grants public-function EXECUTE through default privileges.
-- The hardening migration must make future DeeDou public functions deny-by-default.
create function public.dd008b_acl_probe()
returns boolean
language sql
as $$ select true $$;

do $$
begin
  if has_function_privilege('anon', 'public.dd008b_acl_probe()'::regprocedure, 'EXECUTE') then
    raise exception 'anon inherited EXECUTE on newly-created public function';
  end if;
  if has_function_privilege('authenticated', 'public.dd008b_acl_probe()'::regprocedure, 'EXECUTE') then
    raise exception 'authenticated inherited EXECUTE on newly-created public function';
  end if;
end
$$;

drop function public.dd008b_acl_probe();

rollback;
