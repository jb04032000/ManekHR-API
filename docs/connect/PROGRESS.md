# Connect — Progress Tracker

**Living file. Update at the end of every work session.** A resuming session reads this
first to know exactly where things stand. Canonical copy: the **web** worktree.

---

## Status

- **Epic:** Zari360 Connect — 9 phases (0–8). See `connect-build-plan.md`.
- **Phase 0 — Foundation: COMPLETE + verified** (2026-05-18).
- **Phase 1 — Identity: CODE COMPLETE + verified — pending owner review.**
  Sub-plan: `phases/phase-1-identity.md`. Waves 1–6 ✅ (+ Wave 4.5 auth alignment).
- **Next:** entity-reframe surgical code fixes (docs done) → Phase 1 owner-review
  checkpoint → Phase 2 — Network.

## Entity reframe (2026-05-18)

Owner reframe: Connect is a **standalone product** whose primitives are `User`,
`ConnectProfile` (1/user), `CompanyPage` (0..N/user), `Storefront` (0..N/user). No
"Workspace" concept in Connect — ERP integration is an opt-in **per-entity** link.
Company Page + Storefront are **parallel sibling entities** sharing one admin
foundation (built once in Phase 4, reused by Phase 6). Audited (3 agents) — impact is
small and concentrated.

- **Docs updated:** `IDENTITY-MODEL.md` (rewritten), `connect-build-plan.md` (identity
  architecture, decisions table, route map → `/connect/*`, component inventory,
  backend modules, phase scope), this file.
- **Shipped-code surgical fixes — PENDING:**
  - _Backend_ — remove `ConnectProfile.primaryWorkspace` (dead field, never written) +
    its sparse index; the two `erp-link` endpoints derive ERP-linked context from the
    User's employment (`WorkspaceMember` active rows) instead. `getFeaturedWorkshops` /
    `featured-workshops` retired or stubbed until Phase 6 (`CompanyPage`).
  - _Web_ — `ConnectModuleNav`: drop the flat `storefront` + `leadManager` entries;
    add conditional `COMPANY PAGES` / `STOREFRONTS` owned-entity groups. Remove
    `primaryWorkspace` from `profile.types.ts`.
  - `BACKEND-REUSE-AUDIT.md` §6 — correct "Company Page = workspace metadata" to
    "Company Page = standalone entity with an optional workspace link".
- **Unchanged + reframe-clean** (audited): identity model (User + Profile 1:1,
  layered), `ErpLinkService` derivation, auth / middleware / mode-switch, the 9-phase
  order, the rest of shipped Phase 0 / 1.

## Phase 1 progress

- [x] **Wave 1 — backend identity** — `User.connectEnabled` flag · `ConnectProfileService`
      (lazy get-or-create, public read, update, `computeStrength`) · `UpdateConnectProfileDto` ·
      `ConnectProfileController` (`GET`/`PATCH /me/connect/profile`, `GET .../erp-link`) +
      `ConnectProfilePublicController` (`GET /connect/profiles/:userId`, `@Public`) · module
      wired (AuditModule, service, controllers). **33 backend tests green; connect code
      tsc-clean** (12 scoped-tsc errors are all pre-existing `add-ons`/`mail` debt).
- [x] Wave 2 — uploads `connect-banners` + `connect-portfolio` categories added.
      featured-workshops endpoint → folded into Wave 5; `seed:connect` → folded into
      Wave 4 (just-in-time — built with their consumers).
- Standing rule added (#17): inline-help info icons + plain explanations on every
  non-obvious feature — audience is affluent but low-literacy textile owners.
- [x] Wave 3 — 6 components (PersonCard, ProfileStrengthCard, ERPLinkedPanel,
      ERPCallout, RateRow, ContactPreferenceSelector) + `lib/connect/format.ts`;
      each with `InfoTooltip` help (#17); i18n 4 locales; `/design-system` entries;
      6 test files. **47 web unit tests green; tsc + eslint clean.**
- [x] **Wave 4 — Profile: COMPLETE + verified.**
  - _Backend:_ `ConnectProfile.contactPreference` (`whatsapp`/`phone`/`dm`, default
    `whatsapp`) added to schema + `UpdateConnectProfileDto` + service
    `UPDATABLE_FIELDS`; new `@Public GET /connect/profiles/:userId/erp-link`
    (privacy-trimmed — `linked` + `since` only, no raw signals). **36 backend tests
    green** (schema + service additions).
  - _Web data layer:_ `profile.types.ts` (+`ConnectContactPreference`,
    `PublicErpLinkStatus`, `ConnectProfileBody`) · `profile.actions.ts`
    (+`getPublicErpLink`) · `upload.service.ts` (+`connect-banners`/`-portfolio`).
  - _Web UI:_ `ProfileView` (read-only — banner/identity header, `TrustBadgeRow`,
    open-to pills, `ContactPreferenceSelector`, About/Skills/`RateRow`/Portfolio/
    Experience/Recommendations; owner rail = `ProfileStrengthCard` + `ERPLinkedPanel`)
    · `ProfileEditForm` (AntD Form + zod payload schema, `FileUpload` banner+portfolio,
    `Form.List` portfolio+experience, rupee↔paise) · `ProfileSkeleton` ·
    `/platform/profile` (server load + `OwnProfileClient` view/edit toggle) ·
    `/u/[userId]` (SSR, indexable metadata, `notFound()`, Join-Connect CTA) + route
    `loading.tsx` ×2 + `(connect-public)/not-found.tsx`.
  - _Rest:_ `connect.profile.*` i18n 4 locales (parity-clean) · `/design-system`
    ProfileView entry · `seed:connect` (`scripts/seed-connect.ts` + `pnpm
seed:connect`; 3 personas — master karigar, day-1 karigar, workshop owner who
    gets a workspace + 6 attendance rows so the ERP-linked badge derives live) ·
    3 web test files. **69 web tests green; web `tsc` + Wave-4 `eslint` + `next
build` clean; backend Connect code scoped-`tsc` clean** (`tsconfig.connect-check.json`).
- [x] **Wave 4.5 — Auth alignment + `/platform`→`/connect` rename: COMPLETE + verified.**
      Brainstormed audit of the ERP-shaped auth; owner-approved design at
      `phases/phase-1-wave-5-design.md`. `proxy.ts`: `/u` → `PUBLIC_PATHS` (public
      profiles work logged-out + crawlable — fixes a shipped-Wave-4 bug); `/connect` + `/u` exempt from the `mobile_only` device-tier redirect (Connect is
      feature-flagged, never subscription-gated); `PLATFORM_RESTRICTED_PATHS` →
      `DEVICE_TIER_EXEMPT_PATHS` + a disambiguating comment. Connect app route
      `/platform/*` → `/connect/*` (~20 files; `app/platform-restricted/` —
      device-tier — untouched).
- [x] **Wave 5 — Smart entry + onboarding + Day-1 home: COMPLETE + verified.**
  - _Backend:_ `ConnectProfile.onboardedAt` · `getEntryState` /
    `completeOnboarding` / `getFeaturedWorkshops` service methods ·
    `GET /me/connect/profile/entry` · `POST /me/connect/profile/onboarding` ·
    `ConnectFeaturedController` → `@Public GET /connect/featured-workshops` ·
    `CompleteOnboardingDto`. **44 backend tests green; scoped `tsc` clean.**
  - _Web:_ `/connect/home` smart-entry (server component — coming-soon /
    onboarding-redirect / Day-1 home) · `/connect/onboarding` (4 intent cards,
    `OnboardingClient`) · `Day1Home` (checklist hero + featured workshops + feed
    placeholder) · `ConnectComingSoon` · `profile.types`/`actions` extended.
  - _Route collision:_ `next build` caught `/connect` already being the public
    marketing landing (`app/(marketing)/connect/`). Owner-decided resolution:
    `/connect` stays marketing; the app is `/connect/home` (+ `/onboarding`,
    `/profile`); the marketing page redirects a signed-in member to `/connect/home`.
  - `connect.home` + `connect.onboarding` i18n × 4 locales (parity-clean) ·
    `OnboardingClient` test. **72 web tests green; web `tsc` + eslint + `next build`
    clean.**
- [x] **Wave 6 — Hardening + verify: COMPLETE.** Empty/loading/error states + i18n
      (4 locales) + component tests were folded into Waves 3–5 (per the sub-plan
      execution order). This wave: `/connect/home` `loading.tsx`; PostHog analytics
      — `connect.profile_updated` + `connect.onboarding_completed` on the backend
      write endpoints; WCAG self-audit (semantic landmarks, heading hierarchy, aria
      on interactive + decorative elements — clean). **Final verification: backend
      44 vitest + scoped `tsc`; web 72 vitest + `tsc` + eslint + `next build` — all
      green.** Playwright E2E + native-speaker i18n review → owner-review checkpoint
      (need a live stack + fixtures).

## Phase checklist

- [x] **Phase 0 — Foundation** ✅
- [~] Phase 1 — Identity (Profile + Onboarding) — code complete + verified, pending owner review
- [ ] Phase 2 — Network
- [ ] Phase 3 — Feed
- [ ] Phase 4 — Marketplace
- [ ] Phase 5 — Jobs
- [ ] Phase 6 — Company Pages
- [ ] Phase 7 — Cross-cutting (Inbox / Notifications / Search)
- [ ] Phase 8 — Launch hardening

## Phase 0 — delivered

**Frontend** (`crewroster-web/zari360-connect`):

- [x] `--cn-*` design tokens (`globals.css` `:root` + `@theme`)
- [x] `lib/connect/flags.ts` — 3-layer feature flags; `QueryProvider`; `env.connectPhase`
- [x] `connect.*` i18n namespace — 4 locales, parity-clean
- [x] 4 primitives — `TrustBadgeRow`, `WhatsAppCTA`, `ConnectEmptyState`, `ConnectErrorBoundary`
- [x] Connect shell — `ConnectModuleNav`, `ConnectMobileTabBar`, `ConnectSearchBar`;
      wired into `ModeSidebar` / `TopHeader` / `DashboardLayout`; placeholder `ConnectSidebar` removed
- [x] `/design-system` gallery route (dev-only)
- [x] Public route group `app/(connect-public)/layout.tsx`
- [x] Vitest config + jsdom polyfills + `test-utils/render` + 8 test files — **29 tests green**
- [x] Verified: `tsc` clean · eslint clean · `next build` exit 0

**Backend** (`crewroster-backend/zari360-connect`):

- [x] `BACKEND-REUSE-AUDIT.md` — notifications/uploads/users/workspaces = EXTEND
      (deferred to their phases); audit/subscriptions = REUSE AS-IS
- [x] `src/modules/connect/profile/` — `ConnectProfile` schema, `ErpLinkService`
      (ERP-linked moat derivation — §9.1 thresholds, payroll-run aggregation,
      posted-only invoices, OTel + Sentry + graceful degradation)
- [x] `ConnectProfileModule` registered in `app.module.ts`; `AppModule.CONNECT` enum
- [x] **24 backend tests green**; connect module **scoped `tsc` clean**

## Next task

Entity-reframe surgical code fixes (see "Entity reframe" above) → Phase 1
owner-review checkpoint → Phase 2 — Network (sub-plan `phases/phase-2-network.md`,
revised: a follow targets a `CompanyPage`, not a workspace).
The Status block is the canonical resume pointer; per-wave detail is above.

## Decision log

| Decision                       | Choice                                                                               | Rationale                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Build strategy                 | Full-stack vertical slices                                                           | No mocks/stubs                                                                                                                            |
| Mobile                         | Responsive web + PWA, mobile-first                                                   | Native app out of scope                                                                                                                   |
| Real-time                      | Socket.IO at Phase 3                                                                 | Redis arrives then for BullMQ                                                                                                             |
| Identity                       | One `User` + layered `ConnectProfile`, derived ERP-linked                            | `IDENTITY-MODEL.md`                                                                                                                       |
| Rollout                        | Feature-flagged: module config + `connectEnabled` + PostHog cohorts                  | Closed beta → GA                                                                                                                          |
| Routes                         | Public SEO tree + authenticated `/platform/*`                                        | SEO for company/store/detail                                                                                                              |
| `ConnectTopBar`                | Not built — reuse shared `TopHeader`, inject `ConnectSearchBar`                      | Avoid duplicating notifications/user-menu/locale                                                                                          |
| Shell nav icons                | `@ant-design/icons`                                                                  | ERP-shell consistency; lucide used for in-content components                                                                              |
| Sitemap / robots               | Repo already has `/robots.txt` + `/sitemap.xml`; Connect entity URLs added per-phase | Don't scaffold empty                                                                                                                      |
| `seed:connect`                 | **Deferred to Phase 1**                                                              | Phase 0 has no Connect UI that renders a `ConnectProfile` — seeding into a void. Lands with Profile screens                               |
| "Payroll run" (ErpLinkService) | Distinct `(month, year)` of `Salary` rows created in-window                          | No `PayrollRun` collection; `Payment` rows would double-count                                                                             |
| Invoice signal                 | `state: 'posted'` only, `voucherType: 'sale_invoice'`                                | §9.1 "real operational data, not a self-claim"; allow-list is forward-safe                                                                |
| `contactPreference`            | New `ConnectProfile` field (W4)                                                      | Backs the already-scoped Phase-1 `ContactPreferenceSelector` (F5); display-only, never exposes mobile. Logical change — flagged for owner |
| Public ERP-link                | Separate `GET /connect/profiles/:userId/erp-link`                                    | Mirrors the `/me` endpoint split; returns `linked`+`since` only — raw activity signals stay private (§9.1)                                |
| Profile edit form              | AntD `Form` (not react-hook-form)                                                    | ENGINEERING-STANDARDS #5/#6 — reuse the ERP-wide form system; zod still validates the outgoing payload                                    |

## Open items / flagged for owner

- **Connect logical change (Wave 4) — flag for owner review:** `ConnectProfile`
  gained a `contactPreference` field (`whatsapp`/`phone`/`dm`, default `whatsapp`).
  Added autonomously — it backs `ContactPreferenceSelector`, an already-scoped
  Phase-1 F5 component; display-only, never exposes the mobile number. Touches the
  schema, `UpdateConnectProfileDto`, service `UPDATABLE_FIELDS` + the web types. No
  data migration needed (defaulted). Phase-1 sub-plan's only prior flagged change
  was `connectEnabled`.
- **`tsconfig.connect-check.json`** (backend) — scoped type-check config added so
  Connect code is `tsc`-verifiable without the full-`tsc` OOM. Run
  `pnpm exec tsc -p tsconfig.connect-check.json`.
- **Connect logical changes (Wave 4.5 / 5) — flag for owner review:** (1) `proxy.ts`
  middleware behaviour — `/u` is now public, and `/connect/*` + `/u/*` are exempt
  from the `mobile_only` device-tier redirect. (2) New `ConnectProfile.onboardedAt`
  field (defaulted `null`; no migration). (3) The Connect app route moved
  `/platform/*` → `/connect/*`, app index at `/connect/home` (owner-approved;
  `/connect` itself is the marketing landing).
- **Marketing site not logged-out-accessible (pre-existing, NOT Connect):** the
  `(marketing)` routes (`/connect`, `/erp`, `/about`, `/pricing`, `/contact`) are
  absent from `proxy.ts` `PUBLIC_PATHS`, so a logged-out visitor is bounced to
  `/auth`. The Wave-5 design treats `/connect` as a public marketing landing — for
  it to render logged-out, the marketing routes need whitelisting. Marketing-site
  middleware scope, not Connect — flagged for the owner.
- **Pre-existing repo issues (NOT Connect, not absorbed):**
  - Full backend `tsc` **OOMs** even at 8 GB heap — known infra issue. Connect code
    verified via a **scoped** `tsc` (clean). Flag for an owner infra fix (project
    references / `tsc --build`, or split tsconfig).
  - `check:i18n` fails on pre-existing `auth.*` / `profile.*` missing keys → `pnpm build`
    (prebuild gate) red repo-wide. Connect's own `connect.*` keys are parity-clean;
    frontend verified via `next build` directly.
  - `package-lock.json` stale beside `pnpm-lock.yaml` — recommend deleting it.
  - `TopHeader.tsx:117` unused `currentWorkspaceId`; `app/layout.tsx:88` `console.trace`
    — pre-existing eslint warnings.
- **Non-English Connect translations** (`gu`, `gu-en`, `hi-en`) assistant-authored —
  flag for a native-speaker review pass before GA.
- **Paid (decide when the phase arrives):** WhatsApp BSP (P7), GST/Udyam API (P1/P6),
  voice transcription (P3), cloud telephony (P5).
- **Ops track:** provision Redis + Meilisearch before Phase 2–3.

## Owner review checkpoint — Phase 0

Phase 0 is on disk, uncommitted, verified. Review surfaces:

- `/design-system` route — every shared component in isolation.
- `docs/connect/` — plan, standards, workflow, identity model, this tracker.
- `BACKEND-REUSE-AUDIT.md` — backend reuse verdicts.
  The owner stages + commits (assistant runs zero git ops). Approve → Phase 1 planning.

## Owner review checkpoint — Phase 1

Phase 1 (Identity) is code-complete + verified, on disk. Waves 0–4 are committed +
pushed (`origin/zari360-connect`); Waves 4.5–6 are uncommitted. Review surfaces:

- **Acceptance criteria — all 5 met:** a `connectEnabled` user hits `/connect/home`
  and smart-entry routes them (coming-soon / onboarding / Day-1 home) · a completed
  profile renders (own + public, 4 locales, 380/desktop) · `/u/[userId]` is SSR +
  indexable + works logged-out with a Join CTA · workshop-owner profiles show the
  derived ERP-linked badge, no-workspace users don't · the Day-1 home shows the
  setup checklist + featured workshops.
- **Walkthrough:** run `pnpm seed:connect` (backend) — 3 demo personas (master
  karigar, day-1 karigar, workshop owner); sign in with the mobile + dev mock OTP.
- `docs/connect/phases/phase-1-wave-5-design.md` — the auth-alignment design.
- **Logical changes** (see "Open items"): `proxy.ts` behaviour; `ConnectProfile`
  `contactPreference` + `onboardedAt`; the `/platform`→`/connect` route move.

Remaining for the owner / CI (need a live stack):

- **Playwright E2E** for onboarding→profile→public-view — the unit + integration
  layer is done (116 tests green); E2E needs the running stack + a `connectEnabled`
  fixture user.
- **Native-speaker review** of the `gu` / `gu-en` / `hi-en` Connect translations.
- Manual 380/768/1280px pass; `next build` SEO/sitemap spot-check.
- The marketing-routes-not-public middleware gap (see "Open items").

The owner stages + commits (assistant runs zero git ops). Approve → Phase 2 (Network).
