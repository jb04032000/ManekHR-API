# Connect Build Workflow

How every Connect phase is executed — consistent across all sessions, so a fresh
session produces the same production-grade output as the last.

## State files

- **`PROGRESS.md`** — canonical state. Current phase, current task, decision log.
  **Read it first, update it last.**
- **Per-phase sub-plan** — a detailed task breakdown + 3–5 acceptance criteria, written
  at the start of each phase and reviewed by the owner before building.

## The per-phase loop

```
1. START       Read PROGRESS.md → current phase. Read connect-build-plan.md +
               ENGINEERING-STANDARDS.md + this file.
2. PLAN        Write the phase sub-plan: scope, 3–5 acceptance criteria (user-observable),
               task breakdown, screens involved. Re-read the phase's connect-*.jsx
               wireframes + the relevant design-decisions doc sections.
               → Owner reviews the sub-plan before any code.
3. BUILD       Execute. Mobile-first. Dispatch parallel agents for independent
               workstreams. TDD for services / business logic. Reuse
               components/ui/Ds* + components/connect/*.
4. SELF-REVIEW Code-review the diff. Critique each built screen vs its wireframe + the
               design doc. Run the per-phase hardening sub-checklist.
5. TEST        Write + run FE + BE tests (see TESTING-STRATEGY.md). Agent-browser
               verification at 380 / 768 / 1280px.
6. VERIFY      tsc + eslint + check:i18n + build green, both repos. Acceptance criteria
               demonstrably met. /design-system renders new components.
7. GATE        Owner review checkpoint. Flag any decision the design docs did not
               cover. Owner stages + commits.
8. RECORD      Update PROGRESS.md — phase/task done, decisions logged, next task named.
```

## Per-phase hardening sub-checklist (step 4 — done within the phase)

- [ ] Analytics events emitted (design-decisions doc §16)
- [ ] WCAG-AA self-audit (`design:accessibility-review`)
- [ ] i18n keys complete + real in all 4 locales; `check:i18n` passes
- [ ] Perf budget checked (bundle, re-renders, virtualization)
- [ ] `seed:connect` updated with the phase's demo data
- [ ] Internal demo / handoff note written (esp. Lead Manager P4, ATS P5)

## Skill map — which skill, when

| Skill                                                                                              | When to use it                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `superpowers:brainstorming`                                                                        | Phase start, only if design/UX is not fully spec'd by the wireframes (rare — the design doc is locked) |
| `engineering:architecture` (`/architecture`)                                                       | New schema, module boundary, or non-obvious backend decision → write an ADR under `docs/connect/adr/`  |
| `ui-ux-pro-max`                                                                                    | Building or refining any screen / component — layout, interaction states, accessibility                |
| `design:design-critique`                                                                           | After a screen is built — critique it vs its wireframe + the design doc                                |
| `superpowers:dispatching-parallel-agents`                                                          | A phase has 2+ independent workstreams                                                                 |
| `superpowers:test-driven-development`                                                              | Implementing services / business logic                                                                 |
| `superpowers:systematic-debugging`                                                                 | Any bug or test failure                                                                                |
| `superpowers:requesting-code-review`                                                               | Before a phase closes                                                                                  |
| `superpowers:verification-before-completion`                                                       | Before claiming a phase done                                                                           |
| `design:accessibility-review`                                                                      | The per-phase WCAG-AA self-audit                                                                       |
| GSD — `/gsd-plan-phase` `/gsd-execute-phase` `/gsd-progress` `/gsd-verify-work` `/gsd-resume-work` | Optional structured harness for the loop above                                                         |

## Agent dispatch pattern

- Per phase, identify **independent** workstreams (e.g. the backend module ∥ a frontend
  screen ∥ a batch of shared components). **Max 3 parallel agents.**
- One agent per workstream. **No shared mutable state** between parallel agents.
- Dependency-ordered where coupled — **schema → endpoints → frontend integration** is
  sequential. Independent components / screens run in parallel.
- Each agent gets: the phase sub-plan, the relevant wireframe + design-doc sections, the
  engineering standards. Agents return diffs + a summary; the main session integrates
  and verifies.

## Decision rule — no blind changes, no assumptions

- Covered by the design-decisions doc or a wireframe → follow it.
- **Not covered → research** (competitor + best practice) → decide → **log the decision
  in `PROGRESS.md`** → proceed.
- Logical change (schema / permission / new module) → surface to the owner first.
- A wireframe conflicts the design-decisions doc → the design doc wins; flag it.

## GSD harness (optional)

GSD gives structured per-phase planning / execution / tracking. `PROGRESS.md` stays the
canonical state regardless. To use GSD: initialize once (`/gsd-ingest-docs` pointed at
`docs/connect/`), then `/gsd-plan-phase` → `/gsd-execute-phase` per phase.
