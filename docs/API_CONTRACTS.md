# DeeDou API Contracts

> Client/backend/RPC compatibility map. Actual handler/function signatures in source/migrations are authoritative.

## Contract principles

1. PostgreSQL/backend handlers enforce business/security authority.
2. Browser modules do not gain authority from route/UI state alone.
3. Public QR contracts stay unauthenticated and exact-token/public-projection scoped.
4. Staff mutations require authenticated staff context plus permission/device/workstation checks.
5. Browser direct CRUD on protected tables is not a supported API.
6. Realtime events are refresh hints; refetched snapshots are authoritative.
7. Do not change request/response/RPC semantics without auditing all callers, tests and hosted acceptance.

## Browser runtime configuration

### `GET /api/runtime-config`

Purpose: expose only approved public backend configuration to hosted browser runtime.

Allowed browser-visible values are limited to backend mode, Supabase URL and publishable/public key. Service-role/database/JWT/private secrets must never be serialized.

Unsafe/missing runtime config fails closed to the supported fallback behavior rather than exposing private credentials.

## DD-011B same-origin security endpoints

### `POST /api/security`

Authenticated security/bootstrap surface. Current actions include status/bootstrap/activation/logout-device lifecycle. The caller supplies a Supabase bearer access token; device trust is represented by backend-managed HttpOnly cookie/session state, not a browser-readable device secret.

Important semantics:

- same-origin enforcement;
- Owner bootstrap requires eligible sole Owner + AAL2;
- staff activation request is short-lived and Owner-authoritative;
- logout/revoke invalidates backend session state;
- failure is not converted to success for UI convenience.

### `POST /api/security-admin`

Owner security administration surface. Protected mutations/snapshots require the accepted Owner security context/AAL2 rules. Used for staff creation, activation approval/rejection, role/location/account changes and device revocation according to DD-011B implementation.

### `POST /api/staff-rpc`

Same-origin staff RPC transport introduced for DD-011B browser secret removal.

Contract:

- caller sends authenticated Supabase bearer token;
- backend resolves trusted device session from HttpOnly cookie;
- browser-provided workstation proof is not trusted;
- when the downstream RPC has workstation/location/device-proof fields, backend substitutes authoritative values from the resolved backend device session;
- invalid/missing device session returns denial;
- protected RPC authorization remains in PostgreSQL as well as transport.

Do not restore `deedou_device_credential` as a production browser secret to bypass this contract.

## Auth / staff authorization

### `authorize_staff_access(...)`

Server authorization contract combines:

- authenticated Auth user;
- active `staff_profiles` identity;
- active location assignment;
- requested permission;
- active registered workstation/device;
- workstation mode permission ceiling;
- Owner AAL2 where DD-011B requires it.

UI route policies are requests for authorization, not the authority itself.

Staff username login is normalized to the internal Auth identity model; the visible username must not require exposing an internal synthetic staff email as the user-facing identifier.

## Public QR contracts

Public customer flow remains unauthenticated.

Supported contract families include:

- exact table-token resolution;
- public menu projection for resolved location;
- configured-order submission using catalog-derived authoritative pricing/options;
- public table/order status projection;
- service request creation.

Public APIs must not expose station routing/internal security/payment/audit tables beyond the explicitly safe projection.

## Operational authoritative command contracts

DD-008C/DD-008D transactional RPCs own authoritative mutations for:

- order submit/accept/reject/void;
- KDS preparation transitions;
- FOH serving;
- course assignment/Hold/Fire;
- table-session open/transfer/close;
- service request transitions;
- payment recording/void/refund;
- table tender allocation;
- authoritative staff/customer snapshots.

Business invariants live in PostgreSQL/domain modules, not in a duplicate test adapter.

### Error normalization

Browser command surfaces normalize expected failures into categories such as:

- `UNAUTHENTICATED`;
- `FORBIDDEN`;
- `CONFLICT`;
- `INVALID_STATE`;
- `BACKEND_UNAVAILABLE`;
- `VALIDATION_ERROR`.

HTTP 401/403 remain valid transport/security outcomes. Do not flatten them to HTTP 200 simply to avoid browser console messages.

## Admin table contracts — DD-010A

Authoritative table/floor/QR management uses authenticated Admin RPCs and optimistic/version guards where defined.

Contracts include table/floor layout reads and audited mutations such as create/update/activate/QR rotation. Open-session constraints protect active visit/table semantics from unsafe layout mutation.

Direct browser CRUD on `physical_tables` is not the supported Admin API.

## Admin catalog contracts — DD-012

### Product core

Authoritative Admin catalog supports product create/update and existing availability mutation using `menu.manage` authority.

Server validation covers accepted product ID/kind/category/bilingual name/price/station/service-period contracts. Mutations use deterministic idempotency, audit and optimistic `updated_at` conflict protection as applicable.

### Variants/modifiers

Authoritative CRUD exists for variants, modifier groups/options and product assignment. Selection bounds and configured-order compatibility are server-validated.

### Combo/components

DD-012C is in progress on PR #46. It must extend existing `product_components`, not introduce a parallel combo API/model.

## Snapshot immutability

Order submission stores configured option/component/price information as historical order-line snapshots. Later catalog changes must not mutate old order contracts.

## Realtime contract

Realtime payloads are notifications to refetch, not authoritative business objects. After reconnect or refresh hint, client converges by requesting the current authoritative snapshot before reporting fully online state.

## Backward compatibility

When changing an API/RPC:

1. identify browser/server/test callers;
2. preserve existing names/shape when feasible;
3. use forward migration/adapter compatibility for staged cutovers;
4. update exact contracts/tests;
5. run DD-008/DD-010/DD-011/DD-012 regressions affected by the change;
6. perform hosted acceptance when the issue requires it.
