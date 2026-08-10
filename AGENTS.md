# DeeDou Repository Instructions

Before non-trivial edits, identify the target module, expected files, dependencies, protected modules, database migration need, and public API impact.

Do not call architectural units "sessions". Use "feature modules" or "modules". Use `table-session` only for the business concept of one active dining visit at a table.

Prefer the smallest reasonable change surface. Do not perform opportunistic unrelated refactors.

Feature modules live under `src/features/`. Shared infrastructure lives under `src/shared/`. Code in `shared/` must be reusable across independent modules and must not become a dumping ground for business rules.

External code should import from a module's public `index.js` API. Do not reach into private implementation files once a module has internal folders.

Current app is static JavaScript. Preserve hash routes and existing local-first behavior unless a requested task explicitly changes them.

Validation for now:

- Parse `app.js` as JavaScript.
- Verify critical flows in the browser when UI or runtime wiring changes.

