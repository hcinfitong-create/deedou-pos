# course-workflow

Responsibility: pure course sequencing and hold/fire rules for table-service pacing.

Does not own KDS preparation transitions, serving progress, billing/payment, table-session rules, product option pricing, persistence, or DOM binding.

Allowed dependencies: shared utilities only if genuinely generic. Avoid importing station-workflow, staff UI, app shell, or table-session internals.

Public interface: export through `index.js`; keep hold/fire operations deterministic and return `{ ok, reason }` failures without mutation when guards fail.

Tests: prioritize legacy FIRED defaults, malformed course rejection, hold/fire guards, service-family targeting, combo inheritance, KDS release eligibility, and price/service non-regression.
