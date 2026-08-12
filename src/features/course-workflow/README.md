# course-workflow

Owns DeeDou course sequencing for table-service restaurant pacing.

## Owns

- Course normalization.
- HELD/FIRED scheduling state normalization.
- Service-family selection.
- Course assignment/reassignment guards.
- Hold service family.
- Fire service family.
- Fire whole course.
- FOH course summaries/selectors.

## Does Not Own

- KDS preparation state transitions.
- Serving progress.
- Billing quantity or payment.
- Table-session/floor-plan rules.
- Product option pricing or snapshots.
- Customer course selection UX.
- Admin course templates or automatic timed fire.

## Contract

Course assignment, hold/fire release, preparation, serving, and billing stay separate.

```text
course != holdState != prepStatus != servedQty != billQty
```

`prepStatus` remains `QUEUED -> ACKNOWLEDGED -> PREPARING -> READY` and KDS must never set `SERVED`.

Legacy or missing `holdState` normalizes to `FIRED`. Legacy or missing `course` normalizes to the immediate/unassigned course.

## Public API

Import from `src/features/course-workflow/index.js`.

- `HOLD_STATES`
- `normalizeCourse`
- `validateCourse`
- `normalizeHoldState`
- `normalizeLineCourseScheduling`
- `isLineKdsReleased`
- `courseLabel`
- `courseSortValue`
- `getServiceFamilies`
- `findServiceFamily`
- `canAssignCourse`
- `assignServiceFamilyCourse`
- `canHoldServiceFamily`
- `holdServiceFamily`
- `canFireServiceFamily`
- `fireServiceFamily`
- `fireCourse`
- `getHeldCourseNumbers`
