# DeeDou Repository Instructions

## Continuity protocol — mandatory

For every non-trivial DeeDou coding/debugging task, treat the repository as the continuity source between conversations and agents.

At the start of a session:

1. Read `docs/CONTINUITY_PROTOCOL.md`.
2. Read `docs/HANDOFF.md`.
3. Read `docs/PROJECT_STATE.md`.
4. Read `docs/CODING_RULES.md` and `docs/DECISIONS.md`.
5. Read architecture/database/API/roadmap documents relevant to the task.
6. Re-check current source, branch, PR, head SHA, and CI before coding.
7. If repository reality differs from the handoff, repository reality wins.

At the end of every substantial implementation/debugging session:

1. Refresh `docs/HANDOFF.md` with the exact current task, branch, PR, verified head SHA, completed work, changed files, confirmed evidence, rejected hypotheses, validation results, known issues, pending work, and next exact action.
2. Update `docs/PROJECT_STATE.md` when project/PR/milestone state changed materially.
3. Update `docs/DECISIONS.md`, `docs/DATABASE.md`, `docs/API_CONTRACTS.md`, or `docs/ROADMAP.md` when their respective contracts or accepted state changed.
4. Never leave a substantial session with only conversational context if the next agent would need that context to continue safely.

Follow `docs/CONTINUITY_PROTOCOL.md` for the required handoff schema and freshness rules.

## Engineering rules

Before non-trivial edits, identify the target module, expected files, dependencies, protected modules, database migration need, and public API impact.

Do not call architectural units "sessions". Use "feature modules" or "modules". Use `table-session` only for the business concept of one active dining visit at a table.

Prefer the smallest reasonable change surface. Do not perform opportunistic unrelated refactors.

Feature modules live under `src/features/`. Shared infrastructure lives under `src/shared/`. Code in `shared/` must be reusable across independent modules and must not become a dumping ground for business rules.

External code should import from a module's public `index.js` API. Do not reach into private implementation files once a module has internal folders.

Current app is static JavaScript. Preserve hash routes and existing architecture unless a requested task explicitly changes them and an accepted architecture decision supports the change.

Use the repository source-of-truth priority defined in `docs/CODING_RULES.md`. Debug by evidence: inspect failure → collect evidence → trace execution → prove root cause → minimal fix → validate.

Do not make CI green by weakening authorization, skipping valid tests, deleting assertions, suppressing errors, or changing unrelated behavior.

Validation must be proportional to the change. For UI/runtime wiring changes, verify the relevant browser flow. For database/API/security changes, run the relevant contracts/integration checks as defined by repository docs and workflows.
