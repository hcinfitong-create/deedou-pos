-- DD-008B hosted Supabase function ACL hardening.
-- Hosted projects explicitly grant EXECUTE on new public functions to anon/authenticated
-- through default privileges. Normalize DeeDou to deny-by-default, then grant only the
-- intended DD-008B RPC surface.

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Internal helpers: callable only from privileged/server-side SQL paths.
revoke all on function public.hash_device_credential(text) from public, anon, authenticated;
revoke all on function public.generate_device_credential() from public, anon, authenticated;
revoke all on function public.generate_device_id() from public, anon, authenticated;
revoke all on function public.resolve_registered_device(text, text) from public, anon, authenticated;
revoke all on function public.resolve_staff_workstation_context(text, text, text) from public, anon, authenticated;

-- The authorization boundary intentionally accepts anon so callers receive deterministic
-- SIGN_IN_REQUIRED instead of relying on transport-level permission behavior.
revoke all on function public.authorize_staff_access(text, text, text, text) from public, anon, authenticated;
grant execute on function public.authorize_staff_access(text, text, text, text) to anon, authenticated;

-- Authenticated staff API. Explicitly remove hosted anon defaults before re-granting.
revoke all on function public.current_staff_id() from public, anon, authenticated;
revoke all on function public.is_active_staff() from public, anon, authenticated;
revoke all on function public.has_location_access(text) from public, anon, authenticated;
revoke all on function public.has_permission(text, text) from public, anon, authenticated;
revoke all on function public.workstation_mode_allows_permission(text, text) from public, anon, authenticated;
revoke all on function public.get_my_staff_context(text, text, text) from public, anon, authenticated;
revoke all on function public.list_staff_menu_products(text, text, text) from public, anon, authenticated;
revoke all on function public.list_staff_tables(text, text, text) from public, anon, authenticated;
revoke all on function public.list_staff_orders(text, text, text) from public, anon, authenticated;
revoke all on function public.list_staff_service_requests(text, text, text) from public, anon, authenticated;
revoke all on function public.list_staff_payment_transactions(text, text, text) from public, anon, authenticated;
revoke all on function public.prepare_audit_context(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.can_assign_staff_location(text, text, text, text) from public, anon, authenticated;
revoke all on function public.assign_staff_to_location(text, text, text, text) from public, anon, authenticated;
revoke all on function public.can_grant_role_at_location(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.assign_staff_role_at_location(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.register_workstation_device(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.revoke_workstation_device(text, text, text, text) from public, anon, authenticated;

grant execute on function public.current_staff_id() to authenticated;
grant execute on function public.is_active_staff() to authenticated;
grant execute on function public.has_location_access(text) to authenticated;
grant execute on function public.has_permission(text, text) to authenticated;
grant execute on function public.workstation_mode_allows_permission(text, text) to authenticated;
grant execute on function public.get_my_staff_context(text, text, text) to authenticated;
grant execute on function public.list_staff_menu_products(text, text, text) to authenticated;
grant execute on function public.list_staff_tables(text, text, text) to authenticated;
grant execute on function public.list_staff_orders(text, text, text) to authenticated;
grant execute on function public.list_staff_service_requests(text, text, text) to authenticated;
grant execute on function public.list_staff_payment_transactions(text, text, text) to authenticated;
grant execute on function public.prepare_audit_context(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.can_assign_staff_location(text, text, text, text) to authenticated;
grant execute on function public.assign_staff_to_location(text, text, text, text) to authenticated;
grant execute on function public.can_grant_role_at_location(text, text, text, text, text) to authenticated;
grant execute on function public.assign_staff_role_at_location(text, text, text, text, text) to authenticated;
grant execute on function public.register_workstation_device(text, text, text, text, text) to authenticated;
grant execute on function public.revoke_workstation_device(text, text, text, text) to authenticated;
