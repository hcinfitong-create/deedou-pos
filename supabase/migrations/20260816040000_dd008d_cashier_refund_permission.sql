-- DD-008D targeted refund RBAC alignment.
-- CASHIER workstations already allow payments.refund; grant the matching role permission.

insert into public.role_permissions (role_id, permission_id)
select 'CASHIER', public.permissions.id
from public.permissions
where public.permissions.permission_key = 'payments.refund'
on conflict do nothing;
