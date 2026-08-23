# DeeDou Coding Rules

> Mandatory rules for every code/database/API change in this repository.

These rules consolidate the DeeDou Project Instructions with the repository's `CLAUDE.md` engineering guidance. If a local module has stricter rules, follow the stricter rule.

## 1. Repository is the source of truth

Never guess current state.

Priority when information conflicts:

1. source code;
2. database schema/migrations;
3. GitHub branch/commit/PR/CI;
4. repository docs;
5. accepted decisions;
6. conversation history;
7. memory;
8. inference.

Before changing code, inspect the implementation that exists now.

## 2. Think before coding

For non-trivial work, identify:

- target module;
- symptom / requested outcome;
- expected files to change;
- dependencies used;
- protected/unrelated modules;
- database/API impact;
- validation required.

Surface uncertainty. Do not silently choose an architecture or business rule when multiple interpretations exist.

## 3. Simplicity first

Implement the minimum change that satisfies the verified requirement.

Do not:

- add speculative features;
- add single-use abstractions without need;
- create parallel models for an existing domain;
- add configurability that was not requested;
- rewrite a large module when an isolated fix is sufficient.

Prefer **reuse → extend → small refactor → new module** in that order.

## 4. Surgical changes

Every changed line should trace to the task.

Do not:

- reformat unrelated code;
- rename unrelated symbols;
- clean unrelated dead code;
- upgrade dependencies unless required and approved;
- change framework/ORM/database;
- change folder architecture;
- refactor neighboring features just because they can be improved.

If your own change creates unused code/imports, remove those specific orphans.

## 5. Respect module ownership

Read `docs/ARCHITECTURE.md` and `docs/MODULE_MAP.md`.

Key boundaries:

- order state/line/service contracts → `ordering`;
- option/configured pricing → `product-options`;
- course Hold/Fire → `course-workflow`;
- KDS preparation → `station-workflow`;
- FOH staff presentation/actions → `staff-orders`;
- table visit lifecycle → `table-session`;
- payment/refund/void ledger rules → `payments`;
- Supabase transport/infrastructure → `shared/backend`;
- browser Auth/session gates → `shared/auth`;
- PostgreSQL authority/RBAC/RPC → Supabase migrations/functions.

Feature modules must not import Supabase directly when the shared backend boundary exists.

## 6. Debug by evidence

Required sequence:

**Inspect failure → collect evidence → trace execution → form hypothesis → prove root cause → minimal fix → validate.**

Keep these distinct:

- **Symptom:** what failed.
- **Hypothesis:** possible cause.
- **Evidence:** log/source/data supporting or rejecting it.
- **Root cause:** cause confirmed by evidence.
- **Fix:** minimal correction.

Never present a hypothesis as confirmed fact.

## 7. Tests are contracts, not obstacles

Never make CI green by:

- removing/skipping a valid test;
- deleting assertions;
- suppressing TypeScript/lint/runtime errors;
- weakening authorization/validation;
- changing a correct 401/403 into success just to silence a browser test;
- hiding unexpected console/network errors.

When architecture legitimately changes, update an obsolete test harness while preserving the business/security assertion it was intended to prove.

## 8. Database safety

Before a DB change, inspect existing migrations, tests and consumers.

Do not:

- edit a migration already applied to hosted/production as the normal fix path;
- drop/reset production data;
- drop table/column without explicit impact review;
- hard-delete historical financial/security actor data when disable/revoke is the accepted model;
- create a parallel schema for an existing domain.

Use forward-only migrations. Preserve backward compatibility unless an explicit migration plan says otherwise.

PostgreSQL is the authoritative business state in hosted Supabase mode.

## 9. API / security safety

Do not change request/response/RPC contracts without checking all callers and tests.

Security rules:

- no service-role/database/private secrets in browser code;
- browser direct writes to protected business/security/catalog tables stay denied;
- public QR remains unauthenticated and exact-token scoped;
- staff authorization remains server-enforced by identity + active staff + location + role/permission + registered device + workstation mode;
- OWNER privileged security paths require AAL2 where accepted;
- DD-011B device trust uses backend-managed session proof; do not reintroduce browser-readable workstation secrets.

## 10. Business decisions are not invented in code

Read `docs/DECISIONS.md` before implementing business logic.

If a required rule is absent or ambiguous:

- inspect existing behavior/contracts;
- identify the gap;
- propose choices;
- obtain/record a decision before introducing a new business rule.

Do not silently change POS, QR, payments, VAT/invoice, accounting, inventory, menu, UX or workflow semantics.

## 11. PR / CI workflow

For a PR task, inspect:

- PR state and head SHA;
- changed files;
- latest commits;
- review threads/comments;
- all relevant CI checks;
- failing job logs;
- hosted/staging acceptance when required.

A previous green commit does not prove the current head is green.

Parallel PRs must stay scope-isolated. Resolve integration conflicts via rebase/merge-conflict work, not by copying unrelated feature logic between branches.

## 12. Validation

Choose validation proportional to scope:

- `npm run check` / syntax;
- unit tests;
- DB contracts;
- Auth/integration tests;
- browser smoke;
- build/deployment checks where relevant;
- hosted staging/production acceptance when the issue explicitly requires it.

Use precise completion language:

- **implementation completed** — code exists, not necessarily validated;
- **locally verified** — specified local checks passed;
- **CI passed** — exact head checks passed;
- **hosted/staging verified** — deployed acceptance passed;
- **production verified** — production acceptance passed;
- **pending** — evidence not yet available.

Never say “fixed/done” without matching evidence.

## 13. Documentation maintenance

When a phase changes architecture, schema, API or accepted business behavior, update the corresponding file:

- current state → `PROJECT_STATE.md`;
- session continuation → `HANDOFF.md`;
- coding rule → `CODING_RULES.md`;
- accepted decision → `DECISIONS.md`;
- database contract → `DATABASE.md`;
- API/RPC contract → `API_CONTRACTS.md`;
- milestone/order → `ROADMAP.md`.

Documentation must distinguish **implemented**, **accepted but not implemented**, and **proposed** states.
