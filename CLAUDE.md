# CrewRoster Backend (NestJS API)

## Zari360 Connect — active build

This branch (`zari360-connect`) also builds the **Zari360 Connect** backend modules
(`src/modules/connect/*`) — the network / marketplace / jobs platform on top of the ERP.

**Before any Connect backend work, read `docs/connect/`** — start with
`docs/connect/README.md`, then `docs/connect/PROGRESS.md` for the current phase. That
folder holds the master plan, engineering standards, per-phase workflow, identity model,
and testing strategy. Connect modules follow the same repo conventions below (env
loader, guards, audit, Sentry, OTel, PostHog, `*.vitest.ts`).

## Polish Initiative — read these FIRST

This repo is part of an active multi-phase polish initiative. Before any
non-trivial change in this repo, read the workspace-root files:

- [`../POLISH-INITIATIVE.md`](../POLISH-INITIATIVE.md) — master meta-plan,
  phase rollout, status tracker, audit findings.
- [`../POLISH-RULES.md`](../POLISH-RULES.md) — binding rules + per-module
  checklist. Includes the `Working Agreement`, `Code Quality`, `Visual / UX`,
  `Security`, `Observability`, `Runtime Verification`, `CI Gates`, and
  `Process Discipline` sections.
- [`../POLISH-CHECKLIST.md`](../POLISH-CHECKLIST.md) — standalone executable
  per-module checklist (15 steps + pre-flight) consumed by every Phase 5
  sweep module.
- [`../REQUIREMENTS.md`](../REQUIREMENTS.md) — credentials owner must supply.
- [`../MODULE-PLAYBOOK.md`](../MODULE-PLAYBOOK.md) - reusable per-module
  architecture standard distilled from the Team rebuild (path RBAC, caller
  scope, field-group read/write gating, workspace-policy AND-gate, actor-
  correct audit, friendly errors). Read before bringing a new module up to
  the platform bar (e.g. Attendance).

Memory entries written for cross-session continuity reference these same
files; if you are resuming a polish phase, follow the resume prompt and re-read
these before any code change.

## Repo conventions (binding)

- **Zero git ops by assistant.** Owner stages + commits all changes. See
  `POLISH-RULES.md > Working Agreement #1`.
- **Polish-only.** No behavioral / schema / endpoint-signature / permission
  changes without explicit owner approval. See
  `POLISH-RULES.md > Working Agreement #2` and the listed exceptions.
- **Env vars** must read through `src/config/env.ts`. No `process.env.*`
  outside that loader (lint enforced).
- **Upload policies are single-source.** `src/modules/uploads/upload-policies.ts`
  is the ONLY hand-edited copy. After changing any policy, run
  `npm run export:upload-policies` to regenerate the committed
  `upload-policies.generated.json`, then in `web` run
  `npm run sync:upload-policies` to regenerate its mirror. Commit all three
  together. A test (`uploads/__tests__/upload-policies.generated.vitest.ts`)
  fails if the JSON is stale. Never hand-edit the web mirror.
- **All BE endpoints** require `JwtAuthGuard` (or `@Public()` decorator) +
  tenant scope + class-validator DTO + throttler tier.
- **Audit log** every admin write via `AuditService.logEvent` with the right
  `AppModule` enum entry.
- **Sentry** wired via `src/instrument.ts` (initialised before any application
  code via `main.ts`'s first import). Empty DSN = safe no-op. Wrap critical
  catches with `Sentry.captureException` + `tags: { module, op }` for
  observability. Use `Logger` (not `console.*`) for structured runtime logs.
- **OpenTelemetry** wired via `src/observability/tracing.ts` (init as the
  first import in `main.ts`, mirrors Sentry pattern). Empty
  `OTEL_EXPORTER_OTLP_ENDPOINT` = safe no-op (SDK starts with no exporter
  registered). Wrap meaningful service-layer ops with
  `tracer.startActiveSpan('<module>.<verbNoun>', span => { ... })` (or use
  `withAuthSpan`-style helpers per module). Span attribute conventions:
  `userId`, `workspaceId`, `mode`, `result` — never raw PII (last4 / domain
  only). On error: `span.recordException` + `span.setStatus({ code: ERROR })`.
  Auto-instrumentation (HTTP, Mongo, Redis) is on by default; child spans
  attach automatically when callbacks run inside `startActiveSpan`.
- **PostHog** server-side via `PostHogService`
  (`src/common/posthog/posthog.service.ts`, registered as `@Global()` so
  any module can inject it). Empty `POSTHOG_KEY` = safe no-op. Emit events
  on meaningful **writes** only — convention `<module>.<verb>_<noun>`
  snake_case (e.g. `auth.signup_completed`, `salary.payroll_finalized`).
  Properties: distinct-id = Mongo `userId`; include `workspaceId` plus
  domain-specific fields. Call `identify()` on auth signup / login so
  server-side events tie to FE pageview funnels. Read-only endpoints emit
  OTel spans only — no PostHog noise. Pilot references: see
  `src/modules/auth/auth.service.ts` (Phase 3.5 W4 — `withAuthSpan` helper +
  10 events), `src/modules/workspaces/workspaces.service.ts` (Phase 5 W6 —
  `withWorkspaceSpan` helper + 12 events + `identify()` on
  `workspace.workspace_created` so workspaceId binds to FE funnels), and
  `src/modules/team/team.service.ts` + `src/modules/team/team-member-documents.service.ts`
  (Phase 5 W6 — `withTeamSpan` helper + 11 events covering member lifecycle,
  kiosk PIN, karigar profile, document upload).
- **Tests** colocated as `*.vitest.ts` under `src/**/__tests__/`. Use the
  `@nestjs/mongoose` decorator-mock pattern when transitive schema decorations
  trip vitest's reflect-metadata pipeline (see
  `src/modules/auth/__tests__/auth.service.audit.vitest.ts` for a worked
  example).

## Phase 3 (auth) pilot artifacts

- `docs/features/auth/` (workspace-root) — canonical feature folder. Entry
  point `index.md` (overview + sub-doc TOC). Sub-docs cover signup, login,
  forgot, app-lock, sessions, security, api-reference, subscription-tiers,
  marketing, user-guide, dev-only-flags. Restructured from a flat
  `docs/features/auth.md` during Phase 3.5 W1 (2026-05-09).
- `src/modules/auth/__tests__/auth.service.audit.vitest.ts` — 8/8 unit spec
  covering the 6 W4 audit events + skip-on-missing-user + audit-failure
  swallow.
- `AppModule.AUTH = 'auth'` enum entry; `AuditEvent.workspaceId` loosened to
  nullable for identity-layer events. Existing tenant-scoped queries are
  unaffected (they filter on a specific ObjectId; null rows are excluded
  naturally).
