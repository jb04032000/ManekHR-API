# Connect Engineering Standards

Binding contract for **every** Connect code change — web and backend. The owner should
never need to repeat these. A change that violates a standard is not done.

| #   | Standard                          | How / why                                                                                                                                                                                                                    |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **TypeScript strict, zero `any`** | No `any`, no `@ts-ignore`. `tsc --noEmit` clean before a phase closes. Strict mode is already on.                                                                                                                            |
| 2   | **ESLint clean**                  | `eslint` — 0 errors, 0 warnings, including `eslint-plugin-i18next`.                                                                                                                                                          |
| 3   | **i18n every user-facing string** | `next-intl`. All 4 locales (`en`, `gu`, `gu-en`, `hi-en`) get **real** translations each phase — no English stubs. `npm run check:i18n` (prebuild gate) must pass. New keys under the `connect.*` namespace.                 |
| 4   | **Mobile-first**                  | Build the **mobile** layout first from the mobile wireframes (`source/connect-mobile.jsx`, 380px), then expand up to desktop. Never "build desktop then check mobile". Verify at 380 / 768 / 1280px.                         |
| 5   | **Reuse before build**            | Compose `components/ui/Ds*` + `components/connect/*`. Never duplicate. Lift reusable ERP code to a shared location instead of copying.                                                                                       |
| 6   | **AntD-first**                    | AntD v6.3.2 components, themed via `lib/theme.ts` `ConfigProvider`. Tailwind only for layout utilities on your own elements — never on AntD components. Recreate wireframe visuals; do not port the prototype `connect.css`. |
| 7   | **Next.js correctly**             | Server Components for initial data; server actions for mutations; route handlers for webhooks. TanStack Query for interactive client surfaces. Public entity pages are SSR/ISR + indexable.                                  |
| 8   | **No needless re-renders**        | URL-synced `?tab=` swaps content without remounting the shell; `React.memo` + stable callbacks on list rows; `useDeferredValue` + debounce on search; virtualize long lists.                                                 |
| 9   | **Full state coverage**           | Every screen ships empty + loading + error states + an error boundary (`ConnectErrorBoundary` / route `error.tsx`). Currency in Indian numbering (`₹4,49,500`).                                                              |
| 10  | **No shortcuts**                  | No stubs, no TODOs, no "future implementation". A feature ships complete or it is not in the phase.                                                                                                                          |
| 11  | **`/design-system`**              | Every new shared component is rendered there in isolation.                                                                                                                                                                   |
| 12  | **Zero git ops by the assistant** | The owner stages + commits all changes. The assistant never runs `git` mutations.                                                                                                                                            |
| 13  | **Surface logical changes**       | New schema / module / permission model → surface for owner approval. The _content_ of the change is the assistant's call after research.                                                                                     |
| 14  | **Flag paid dependencies**        | Any paid dependency or external paid API flagged prominently at development time — the owner decides.                                                                                                                        |
| 15  | **Per-phase hardening**           | Analytics events (design-doc §16), WCAG-AA self-audit, i18n completeness, perf budget, seed data, internal demo note — done _within_ the phase. Never stockpiled to Phase 8.                                                 |
| 16  | **Verify before "done"**          | Run the checks, show evidence — never assert. Every phase ships behind a feature flag.                                                                                                                                       |

## Backend conventions (from the backend repo `CLAUDE.md` — also binding)

- Env vars only via `src/config/env.ts`. No `process.env.*` elsewhere (lint-enforced).
- Every endpoint: `JwtAuthGuard` (or `@Public()`) + tenant scope + class-validator DTO
  - throttler tier.
- Audit every write via `AuditService.logEvent` with the correct `AppModule` enum entry.
- **Sentry** — wrap critical catches with `Sentry.captureException` + `tags: { module, op }`.
  Use `Logger`, never `console.*`.
- **OpenTelemetry** — wrap meaningful service ops with
  `tracer.startActiveSpan('<module>.<verbNoun>', span => …)`. Span attributes `userId`,
  `workspaceId`, `result` — never raw PII. `span.recordException` + error status on catch.
- **PostHog** — emit `<module>.<verb>_<noun>` snake_case events on meaningful **writes**
  only. Read-only endpoints emit OTel spans only.
- Tests colocated as `*.vitest.ts` under `src/**/__tests__/`.
- New `AppModule` enum entries for each Connect module.

## Frontend conventions (from the web repo)

- Design tokens: `--cr-*` CSS vars + `lib/theme.ts` + `tailwind.config.js`. Connect adds
  only `--cn-*` tokens — never redefine `--cr-*`.
- `@/` path alias resolves to repo root.
- Server actions live in `features/connect/*`; the API client is `axios` + the
  `serverHttp` server client.
- State: Zustand for cross-cutting Connect state; TanStack Query for server-state on
  interactive surfaces.
