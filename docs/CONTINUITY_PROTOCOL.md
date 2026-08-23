# DeeDou Continuity Protocol

> Repository-backed protocol for continuing DeeDou work across ChatGPT, Codex, and other coding conversations.

## Purpose

Conversation memory is not the source of truth for DeeDou code work. The repository is.

This protocol exists so a new conversation can reconstruct the current task, verified state, constraints, and exact next action without asking the user to repeat prior work.

## Source-of-truth order

When information conflicts, use this order:

1. Current source code.
2. Database schema and forward migrations.
3. GitHub branch / commit / PR / CI.
4. Repository documentation.
5. Accepted decisions in `docs/DECISIONS.md`.
6. Conversation history.
7. Memory.
8. Inference.

Never infer current implementation state from documentation alone. Re-check the repository before coding.

## Mandatory startup check

At the start of every non-trivial DeeDou coding/debugging conversation:

1. Read `AGENTS.md`.
2. Read `docs/HANDOFF.md` first to identify the last known working task.
3. Read `docs/PROJECT_STATE.md`.
4. Read `docs/CODING_RULES.md`.
5. Read `docs/DECISIONS.md`.
6. Read module-specific documents when relevant:
   - `docs/ARCHITECTURE.md`
   - `docs/MODULE_MAP.md`
   - `docs/DATABASE.md`
   - `docs/API_CONTRACTS.md`
   - `docs/ROADMAP.md`
   - relevant runbooks.
7. Re-fetch the current branch / PR / head SHA / CI before making implementation claims.
8. Compare repository reality with `HANDOFF.md` and `PROJECT_STATE.md`.
9. If documentation is stale, treat current source/GitHub as authoritative and refresh the docs before ending the session.

Do not ask the user to repeat context that can be reconstructed from these files and GitHub.

## Document responsibilities

### `docs/CODING_RULES.md`

Stable engineering rules. Update only when an engineering rule or repository convention changes.

### `docs/PROJECT_STATE.md`

Long-lived current state of the project. It should answer:

- What is already complete?
- What is currently open?
- Which PRs/issues/branches are active?
- What architecture/security/business authority is currently accepted?
- What important technical debt or integration risk exists?
- What is the current milestone order?

Update after a major PR/phase/state transition, not after every minor investigation step.

### `docs/HANDOFF.md`

Short-lived session checkpoint. This file MUST be refreshed at the end of every substantial coding/debugging session.

It answers:

- What exact task was being worked on?
- What exact branch / PR / head SHA was last verified?
- What was completed in this session?
- Which files were changed?
- What facts/evidence were confirmed?
- What hypotheses were rejected?
- What tests/CI were run and on which exact SHA?
- What remains broken or unknown?
- What is the next exact action?

Do not use vague entries such as "continue debugging" when a more concrete next action is known.

### `docs/DECISIONS.md`

Accepted product/business/architecture decisions. Do not record an unapproved proposal as an accepted decision.

### `docs/DATABASE.md`

Current database authority, schema contracts, migration rules, RLS/RPC responsibilities and compatibility constraints.

### `docs/API_CONTRACTS.md`

Current browser/backend/RPC contract boundaries and compatibility requirements.

### `docs/ROADMAP.md`

Milestones, ordering, dependencies and current phase status.

## Mandatory end-of-session check

Before ending a substantial implementation/debugging session, update repository continuity documentation.

At minimum, refresh `docs/HANDOFF.md`.

Also update:

- `PROJECT_STATE.md` if project/PR/milestone state changed materially;
- `DECISIONS.md` if the user accepted a new decision;
- `DATABASE.md` if database contracts/schema changed;
- `API_CONTRACTS.md` if API/RPC contracts changed;
- `ROADMAP.md` if milestone order/status changed;
- `CODING_RULES.md` only if repository engineering rules changed.

### Required HANDOFF fields

Every handoff must contain all of the following:

1. **Updated at** — timestamp with timezone.
2. **Current task** — issue/task being worked on.
3. **Repository / branch / PR / exact head**.
4. **Current state** — concise status, including whether the problem is fixed, still failing, or awaiting CI/deployment.
5. **Completed work this session**.
6. **Files changed this session** — or explicitly `None`.
7. **Confirmed evidence** — logs/source/DB/CI facts that were actually verified.
8. **Rejected hypotheses / exclusions** — only evidence-backed exclusions.
9. **Validation performed** — commands/checks/jobs and result, tied to exact SHA where applicable.
10. **Known issues / unknowns**.
11. **Pending work**.
12. **Next exact action** — concrete enough that another agent can execute it immediately.
13. **Do-not-regress constraints** relevant to the task.

## Handoff freshness rules

- Never claim a CI result for a newer SHA than the run actually tested.
- Always record the exact head SHA used for the last verified evidence.
- If the branch moves after the handoff is written, the next agent must re-check head before relying on it.
- If multiple agents are working concurrently, do not overwrite another agent's code based on stale handoff data. Re-fetch branch state first.
- Documentation is a continuity aid, not a replacement for inspecting source/CI.

## Session close template

Use this structure in `docs/HANDOFF.md`:

```md
# DeeDou Handoff

Updated at: YYYY-MM-DD HH:MM TZ

## Current task
...

## Repository state
- Repository:
- Branch:
- PR:
- Exact head last verified:
- Base:

## Current state
...

## Completed work this session
- ...

## Files changed this session
- ...

## Confirmed evidence
- ...

## Rejected hypotheses / exclusions
- ...

## Validation performed
- ...

## Known issues / unknowns
- ...

## Pending work
- ...

## Next exact action
1. ...

## Do-not-regress constraints
- ...
```

## Definition of a resumable session

A session is resumable when a new agent can read `HANDOFF.md`, verify its recorded head against GitHub, inspect the referenced source/tests/logs, and execute the listed next action without requiring the user to reconstruct previous debugging history.
