# DeeDou Auth/RBAC

DD-008B introduces staff authentication and role-based access control while keeping the existing LOCAL_DEMO app unchanged.

## Browser Scope

`src/shared/auth` provides a thin presentation/auth boundary:

- Staff route policies for `#/cashier`, `#/staff`, `#/bar`, `#/kitchen`, `#/dessert`, and `#/admin`.
- Minimal Supabase email/password login through public publishable configuration.
- Current location, workstation mode, and device credential submission.
- Login/denied/logout UI helpers.

The public customer route `#/t/<token>` remains unauthenticated.

## Authority

The browser gate is not authoritative. It asks Supabase/Postgres RPCs such as `authorize_staff_access(...)` and `get_my_staff_context(...)` to decide whether the current authenticated user is an active staff member with the required location, permission, and workstation/device access.

The app must not trust:

- Route names.
- Query strings.
- Local storage.
- Client-submitted actor IDs.
- JWT custom claims for staff role or permissions.

## Role Permission Matrix

| Role | Permissions |
| --- | --- |
| OWNER | all DD-008B permissions |
| MANAGER | `menu.read`, `orders.read`, `orders.accept`, `orders.create_staff`, `service.serve`, `service_requests.read`, `service_requests.complete`, `course.manage`, `tables.read`, `tables.manage_session`, `payments.read`, `payments.record`, `payments.void`, `payments.refund`, `audit.read`, `staff.read`, `staff.manage`, `devices.manage` |
| CASHIER | `menu.read`, `orders.read`, `orders.create_staff`, `service_requests.read`, `tables.read`, `tables.manage_session`, `payments.read`, `payments.record`, `payments.void` |
| FLOOR_STAFF | `menu.read`, `orders.read`, `orders.accept`, `service.serve`, `service_requests.read`, `service_requests.complete`, `course.manage`, `tables.read` |
| KITCHEN | `orders.read`, `kds.kitchen` |
| BAR | `orders.read`, `kds.bar` |
| DESSERT | `orders.read`, `kds.dessert` |
| ADMIN_MENU | `menu.read`, `menu.manage` |

Role assignments are location-specific. Device/workstation mode can restrict access but never grants a permission the staff member does not already hold.

## Known Limitations

- Business writes remain denied until DD-008C introduces authoritative command RPCs.
- Device credentials are bearer-style soft trust, not hardware attestation.
- Staff invitation and full MFA/AAL2 UX are deferred to later backend work.
