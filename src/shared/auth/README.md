# DeeDou Auth/RBAC

DD-008B introduces staff authentication and role-based access control while keeping the existing LOCAL_DEMO app unchanged.

## Browser Scope

`src/shared/auth` provides a thin presentation/auth boundary:

- Staff route policies for `#/cashier`, `#/staff`, `#/bar`, `#/kitchen`, `#/dessert`, and `#/admin`.
- Supabase-managed email/password lifecycle through `@supabase/supabase-js`: sign-in, restore, auto-refresh, auth state changes, and local/current-session logout.
- Current location and intended workstation mode presentation.
- Opaque workstation identity storage after an authorized server-issued registration.
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

The app must not copy Supabase `access_token` or `refresh_token` into DeeDou state or authorization cache keys. Browser storage for the Supabase session is owned by `supabase-js`.

Workstation credentials are generated server-side, returned once at registration, and stored server-side only as SHA-256 hashes. The normal login form does not show or accept a visible device token.

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
- In `SUPABASE` mode, successful Auth/RBAC currently opens only a read-only/fail-closed staff surface until DD-008C. LOCAL_DEMO behavior remains unchanged.
- Device credentials are bearer-style soft trust, not hardware attestation.
- Staff invitation and full MFA/AAL2 UX are deferred to later backend work.
