# station-workflow

Owns DeeDou station/KDS preparation workflow.

## Owns

- Station ticket selection.
- Station-specific preparation action model.
- KDS ticket derivation.
- Ticket age/wait age.
- Thin reusable Kitchen, Bar, and Dessert rendering.

## Does Not Own

- Serving progress. FOH/staff uses ordering service-progress APIs.
- Billing quantity or payment behavior.
- Menu/admin CRUD.
- Table/session/floor-plan behavior.
- Station taxonomy redesign.

## Preparation Contract

Line-level `prepStatus` is the canonical preparation source of truth.

```text
QUEUED -> ACKNOWLEDGED -> PREPARING -> READY
```

KDS actions must never set `SERVED`. `stationStatus` is maintained as a readable compatibility summary derived from line preparation state.

## Public API

- `canTransitionPrepStatus`
- `applyPrepStatusTransition`
- `selectStationTickets`
- `deriveStationTicketState`
- `getStationTicketAge`
- `getStationTicketActions`
- `renderStationPage`
- `renderStationTicket`

## Dependencies

Depends on public ordering APIs and shared formatting/escaping utilities only.
