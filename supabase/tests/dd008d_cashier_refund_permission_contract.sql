-- DD-008D cashier targeted refund RBAC contract.
-- Runs against local Supabase/Postgres only.

begin;

do $$
declare
  v_cashier_has_refund boolean;
begin
  select exists (
    select 1
    from public.role_permissions
    join public.permissions
      on public.permissions.id = public.role_permissions.permission_id
    where public.role_permissions.role_id = 'CASHIER'
      and public.permissions.permission_key = 'payments.refund'
  )
  into v_cashier_has_refund;

  if v_cashier_has_refund <> true then
    raise exception 'expected CASHIER role to have payments.refund';
  end if;

  if public.workstation_mode_allows_permission('CASHIER', 'payments.refund') <> true then
    raise exception 'expected CASHIER workstation to allow payments.refund';
  end if;

  if public.workstation_mode_allows_permission('KDS_KITCHEN', 'payments.refund') <> false then
    raise exception 'expected kitchen KDS workstation to deny payments.refund';
  end if;
end $$;

rollback;
