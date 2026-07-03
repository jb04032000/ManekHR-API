# Connect Testing Strategy

Tests are written **per phase, alongside the feature** — never stockpiled. A phase does
not close until its tests are green. Comprehensive coverage across 8 Connect modules
adds up to many hundreds of cases, accumulated incrementally.

## Backend — NestJS · Vitest (already in the repo)

| Layer           | What it covers                                                                                                          | Pattern reference                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Unit**        | Every service method — happy path, edge cases, error paths. Dependencies mocked.                                        | `*.vitest.ts` in `__tests__/`; see `src/modules/auth/__tests__/auth.service.audit.vitest.ts` |
| **Integration** | Every controller endpoint — `JwtAuthGuard`, DTO validation, RBAC, subscription gate, throttler. Real in-memory MongoDB. | see `src/modules/anomalies/__tests__/anomaly-integration.vitest.ts`                          |
| **Schema**      | Index assertions, validation rules, derived-field correctness (e.g. `ErpLinkService`).                                  | colocated `*.vitest.ts`                                                                      |

**Target:** ≥90% line coverage on every `connect/*` module; every endpoint has an
integration test; every guard/edge case from `IDENTITY-MODEL.md` has a test.

## Frontend — Next 16 / React 19

| Layer                      | What it covers                                                                                                           | Tool                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Component**              | Every shared component — all variants, empty/loading/error states, i18n rendering, RBAC gating, mobile + desktop layout. | **Vitest + `@testing-library/react`** — added in Phase 0 (the web repo has no unit runner yet) |
| **E2E**                    | Each phase's critical user flows — one per acceptance criterion. Run at 380px **and** desktop viewports.                 | Playwright (already in the repo)                                                               |
| **Visual / agent-browser** | Dev-time QA — screenshot every screen at 380 / 768 / 1280px, verify empty states and wireframe match.                    | Playwright / chrome-devtools MCP, driven by the agent                                          |
| **Public routes**          | SSR output, indexability (meta, sitemap), logged-out rendering + signup CTA.                                             | Playwright                                                                                     |
| **Accessibility**          | axe checks — WCAG-AA — on every screen.                                                                                  | `axe-core` in Playwright                                                                       |

**Target:** every shared `components/connect/*` component has a component test; every
phase acceptance criterion has an E2E test.

## Gates

- **Per phase:** backend unit + integration tests, frontend component tests, and the
  phase's E2E flows — all green before the phase closes.
- **TDD** for backend services + business logic — write the failing test first
  (`superpowers:test-driven-development`). Pure-visual components may be test-after, but
  **every** component still gets a test.
- **CI** (GitHub Actions — ops track) runs the full suite on every push; `tsc`, `eslint`,
  `check:i18n`, `next build`, `vitest`, `playwright` all gate the merge.

## Agent-browser verification

During the BUILD and TEST steps the agent uses the Playwright / chrome-devtools MCP to
drive a real browser — load each new screen, resize to 380 / 768 / 1280px, screenshot,
confirm empty/loading/error states render, and compare against the `connect-*.jsx`
wireframe. This is dev-time QA that complements (does not replace) the automated
Playwright E2E suite.

## "Hundreds of test cases"

Yes — coverage is comprehensive. But the suite is built **incrementally**, one phase's
worth at a time, written with the feature. There is never a separate stockpiled
test-writing phase — that would violate the per-phase hardening rule.
