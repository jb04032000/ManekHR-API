# Zari360 Connect — Documentation

**Start here.** Connect = the public-facing network / marketplace / jobs layer built on
top of the Zari360 ERP. Multi-month epic, built across many sessions as 9 full-stack
phases (0–8).

## Read in this order

1. **`connect-build-plan.md`** — master plan (v2): scope, 9 phases, identity model,
   route map, backend modules, evaluated tech stack, feature-flag rollout.
2. **`ENGINEERING-STANDARDS.md`** — the 16-point binding contract for all Connect code.
3. **`WORKFLOW.md`** — per-phase workflow, skill map, agent-dispatch pattern, gates.
4. **`IDENTITY-MODEL.md`** — ERP↔Connect identity architecture + edge cases.
5. **`TESTING-STRATEGY.md`** — FE + BE test approach, coverage targets, gates.
6. **`PROGRESS.md`** — **living** status tracker: current phase, next task, decision log.

## Resuming a session — do this first

1. Read **`PROGRESS.md`** — it names the current phase and the next task.
2. Read `WORKFLOW.md` + `ENGINEERING-STANDARDS.md`.
3. Read the current phase's sub-plan.
4. Continue. Never assume state — `PROGRESS.md` is the source of truth.

## `source/`

The design source of truth, copied from the Claude-Design handoff bundle:

- `zari360_connect_design_decisions.md` — **locked** design spec. Verb taxonomy, badge
  hierarchy, layouts, empty-state recipe, mobile rules, §15 components, §16 analytics.
- `zari360_connect_features.md` — feature inventory + competitor research.
- `wireframes.html` + `connect-*.jsx` — the 26-screen wireframes. Match for layout + copy.
- `tokens.css`, `connect.css`, `shared.jsx`, `icons.jsx` — prototype styles/helpers
  (reference only — recreated with AntD + Tailwind, not ported verbatim).

**Conflict rule:** a wireframe vs the design-decisions doc → **the design-decisions doc
wins** on system rules. Flag the conflict in the phase summary.

## Where work happens

`zari360-connect` worktrees **only**:

- web: `.worktrees/crewroster-web/zari360-connect/`
- backend: `.worktrees/crewroster-backend/zari360-connect/`

Never touch `crewroster-web/` or `crewroster-backend/` on `main`.

> This doc set is mirrored in the backend worktree's `docs/connect/`. `PROGRESS.md` is
> canonical in the **web** worktree — update that copy.
