# station-workflow

Owns DeeDou station/KDS preparation workflow.

## Owns

- Station ticket selection.
- Station-specific preparation action model.
- KDS ticket derivation.
- Ticket age/wait age.
- Thin reusable Kitchen, Bar, and Dessert rendering.
- Variant/modifier summary display for configured lines.
- Course-aware ticket grouping for fired lines.

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

KDS eligibility requires:

- the order is operational;
- the line belongs to the station;
- the line is required station work;
- the line is `FIRED`;
- the line is not already `READY`.

Held lines are FOH scheduling work, not active KDS workload. Firing a course does not change `prepStatus`; it only makes queued lines visible to KDS.

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

Depends on public ordering APIs, public course-workflow release helpers, public product-options summary helpers, and shared formatting/escaping utilities only.
