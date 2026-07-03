# Zari360 Connect — Master Build Plan (v2)

> Working file. On execution, copied to `docs/connect/connect-build-plan.md` in both
> `zari360-connect` worktrees. All git / build / edit work happens in the
> `zari360-connect` worktrees only — `crewroster-web/` and `crewroster-backend/` on
> `main` stay untouched.

**v2 revisions** (folded in after review): Phase 0 slimmed (just-in-time component
build); **public SEO route tree added**; Socket.IO moved to Phase 3; feature-flag +
rollout system added to Phase 0; onboarding intents flag-gated; Day-1 suggestions
bootstrap via curated list; mobile-first made the primary design target; per-phase
acceptance criteria + hardening sub-checklists added; Phase 8 shrunk to cross-cutting;
backend-reuse claims become a Phase 0 audit; seed script + error boundaries added.

---

## Context

**What.** Zari360 Connect is the public-facing layer on top of the Zari360 ERP — a
professional network, marketplace, and jobs board for the Surat embroidery industry.
The ERP (attendance / payroll / finance, 41 backend modules) is production-ready.
Connect today is a single "coming soon" placeholder at `/platform`.

**Why now.** Connect is the growth surface. The moat is the _ERP-linked_ signal: a
workshop that actively runs payroll/attendance in the ERP is provably real, surfaced
as a trust badge across every Connect screen. No competitor (IndiaMART, Naukri, Apna)
has operational factory data. Connect turns ERP usage into distribution.

**Inputs absorbed.** `zari360_connect_design_decisions.md` (locked design spec —
tiebreaker), `zari360_connect_features.md` (feature inventory / competitor research),
`Zari360 Connect Wireframes.html` + 14 `connect-*.jsx` sketches (26 screens, ~20
reusable patterns — pixel source of truth), full web + backend worktree audits.

**Shape.** Multi-month, 9 phases (0–8), built as **full-stack vertical slices** —
each phase ships one module complete: backend + frontend desktop + mobile + empty
states, nothing mocked. Each phase ships **behind a feature flag** so it can go to a
closed beta before GA. Each phase gets a detailed sub-plan + owner review checkpoint.

---

## Decisions locked

| #   | Decision       | Choice                                                                                                                                                                                                                   |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Build strategy | Full-stack vertical slices — no mocks, no stubs, no "future implementation"                                                                                                                                              |
| 2   | Mobile         | Responsive web + PWA only, **mobile-first** (380px is the _primary_ design target). Native app out of scope                                                                                                              |
| 3   | Real-time      | **Socket.IO** NestJS gateway — introduced **Phase 3** (rides the Redis that BullMQ brings). Phases 1–2 poll via TanStack Query                                                                                           |
| 4   | First module   | Profile (Phase 1)                                                                                                                                                                                                        |
| 5   | Identity       | Single `User` login; layered Connect entities — `ConnectProfile` (1 per user), `CompanyPage` (0..N), `Storefront` (0..N). Connected to ERP, never merged                                                                 |
| 6   | Rollout        | Every phase ships behind a feature flag; closed beta → GA                                                                                                                                                                |
| 7   | Routes         | Public SEO route tree for shareable entities + authenticated `/connect/*` app                                                                                                                                            |
| 8   | Connect ↔ ERP  | Connect is a **standalone product**; "Workspace" is an ERP word, absent from Connect. ERP integration is an opt-in **per-entity** link (`CompanyPage` / `Storefront` → `Workspace`). The moat is a link, not a hierarchy |

---

## Identity architecture — ERP ↔ Connect (locked)

> Full detail + edge cases: `docs/connect/IDENTITY-MODEL.md` (canonical).

**Connect is a standalone product. ERP is a separate product. The moat is a link
between them, not a parent-child hierarchy.** "Workspace" is an ERP word — Connect has
no Workspace concept.

**Connect's four primitives:**

| Primitive        | Cardinality   | What it is                                                               |
| ---------------- | ------------- | ------------------------------------------------------------------------ |
| `User`           | 1 per person  | Identity + login. Shared by ERP and Connect.                             |
| `ConnectProfile` | 1 per `User`  | The person's LinkedIn-style page. Person-scoped, always you.             |
| `CompanyPage`    | 0..N per User | Standalone public **business identity** (hires, posts). Own admin + URL. |
| `Storefront`     | 0..N per User | Standalone public **sales catalog** (sells, leads). Own admin + URL.     |

`CompanyPage` and `Storefront` are **parallel sibling entities** — same shape (owner,
slug, public page, admin dashboard, optional ERP link), different purpose. A `User`
owns any number of each, none, or a mix.

- One `User`, one login; ERP↔Connect are modes of the _same_ session. No separate
  "Connect account". Shared identity (name, avatar, mobile) is canonical on `User`,
  _read_ by Connect; never copied onto Connect collections.
- **ERP integration is an opt-in per-entity link.** A `CompanyPage` / `Storefront`
  may set `erpWorkspaceId` to earn the **ERP-linked badge**, derived from that
  workspace's activity. A `ConnectProfile` shows ERP-linked context from the User's
  _employment_ (`WorkspaceMember` active rows) — never a field on the profile.
- Connect is **not gated on ERP** — a karigar with no ERP gets a full `ConnectProfile`
  and can even create a `Storefront`.
- The **ERP-linked badge is derived, never stored** — `ErpLinkService` computes it
  from workspace activity (≥5 attendance OR 1 payroll run OR 3 invoices in 30 days;
  60-day silent decay — design doc §9.1), invoked per linked entity.
- **Privacy wall:** ERP operational data (salary, attendance rows) **never** auto-leaks
  to any public Connect surface — only what the user explicitly puts there + the
  derived ERP-linked _boolean_.

**Key edge cases** (full table in `IDENTITY-MODEL.md`):

| Case                                         | Handling                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `User` with no ERP                           | Full `ConnectProfile`; may own Company Pages / Storefronts; no ERP-linked badge. Works fully.  |
| `User` active in ERP workspace(s)            | Profile shows ERP-linked context from employment; multiple employments OR'd, **no "primary"**. |
| Entity not linked to ERP                     | Valid entity, no badge. The link is opt-in, set in the entity's admin settings.                |
| One `Workspace` linked from several entities | Allowed — a workshop's Company Page + Storefront may both link the same workspace.             |
| `TeamMember` with no `linkedUserId`          | Workshop-curated _claimable_ listing; "Invite to Connect" sets `linkedUserId`.                 |
| `Workspace` / account deletion               | ERP-linked badge decays silently; Connect entities cascade on `User` delete.                   |

---

## Tech stack — evaluated

**Adopt (new, free, open-source):**
| Tech | Use | Introduced |
|------|-----|-----------|
| TanStack Query | Client cache / optimistic / **polling** (badge counts P1–2). Hybrid — Server Components + server actions still own initial loads | P0 |
| Zod | DTO + form schema validation | P0 |
| Framer Motion | Composer sheets, voice UI, transitions | P0 |
| `lucide-react` | Connect icon set — matches wireframe `CIco`. ERP keeps `@ant-design/icons` | P0 |
| **Socket.IO** (NestJS gateway) | Live feed updates + notification push (P3); typing/presence/live threads (P7) | **P3** |
| Redis 7+ | BullMQ store + Socket.IO adapter + presence | P3 |
| BullMQ | Feed fan-out, notification batching, digest emails | P3 |
| Meilisearch (self-hosted) | Search — **provisioned P2** (people search); each later module registers its index as it ships | P2 |
| TanStack Virtual | Feed + long-list virtualization | P3 |

**Reject / diverge:** date-fns → use existing `dayjs`. Biome → keep ESLint 9 +
Prettier. Tiptap → deferred (textarea v1; only if the long-form Article composer is
built). Storybook → deferred; in-app `/design-system` route instead. AntD → use
installed **v6.3.2** (not v5). Next.js → installed **16.1.6**. recharts → already
installed.

> ### ⚠️ PAID — flagged at development time, owner decides
>
> Not needed for wireframe-critical paths. Surfaced prominently when the phase begins.
>
> 1. **WhatsApp Business API / BSP (Gupshup/Interakt)** — only for _outbound WhatsApp
>    notifications_. The wireframe **WhatsApp handoff** (`wa.me` deep link) is **free,
>    ships v1**. Flag P7.
> 2. **GST / Udyam verification API (Surepass/Karza)** — for verified badges. Behind a
>    provider interface; badge UI ships, live call pending. Flag P1 / P6.
> 3. **Voice transcription (Whisper/Sarvam/Google STT)** — record+playback+upload free,
>    ship P3. Transcription provider flag P3.
> 4. **Cloud telephony (Exotel/Knowlarity)** — Caller-ID-with-intent. Rest of
>    Candidates tab works without it. Flag P5.
> 5. **AWS SES** — optional cheaper email; existing SMTP `mail` module works. Minor.
> 6. **MSG91 SMS** — already in production. Ongoing.

**Infra (ops track, not code):** DO/Hetzner, Docker Compose, Caddy/Nginx, PM2, GitHub
Actions, Grafana/Prometheus, self-hosted PostHog. Sentry + PostHog SDKs already wired.

---

## Design system & tokens

`zari360_connect_design_decisions.md` is the locked spec — every screen inherits it.

**Token audit — verified:** the wireframe `tokens.css` `:root` palette is
byte-identical to the repo's `app/globals.css --cr-*` vars + `tailwind.config.js`
(indigo-600 `#1A2A6C`, indigo-700 `#142158`, gold-500 `#C9A227`, cream `#FAF8F3`,
full neutral + semantic scales). So:

- **Reuse** the existing system as-is — `--cr-*` CSS vars, `lib/theme.ts` AntD
  `ConfigProvider`, `tailwind.config.js`, the `@theme` map. **Redefine nothing.**
- **Add** only Connect tokens, namespaced `--cn-*`, layered on `--cr-*`:
  `--cn-whatsapp` `#25D366`, `--cn-whatsapp-hover` `#128C7E`, `--cn-badge-erp-bg`
  (indigo-800), `--cn-badge-erp-fg` (gold-400). GST/Udyam badge colors already exist.
- Prototype `connect.css` is **not** ported — recreate the _visual output_ with AntD +
  Tailwind + tokens (per handoff README).

---

## Route map (v2 — public SEO tree + authenticated app)

### Public route group — `app/(connect-public)/`

SSR / ISR, **indexable** (sitemap + robots), light public chrome + "Join Connect" CTA.
Works logged-out (SEO + conversion). Logged-in users get the full interactive Connect
shell on the same canonical URL. These are the shareable / WhatsApp-link / SEO pages.

| Route                   | Screen                          | Phase |
| ----------------------- | ------------------------------- | ----- |
| `/u/[userId]`           | Person profile (public view)    | P1    |
| `/company/[slug]`       | Company page                    | P6    |
| `/store/[slug]`         | Seller storefront               | P4    |
| `/products/[productId]` | Product detail                  | P4    |
| `/jobs/[jobId]`         | Job detail                      | P5    |
| `sitemap.ts` · `robots` | Indexing infra (group scaffold) | P0    |

### Authenticated app — `app/connect/*` (Connect shell, `mode="connect"`)

Personal / interactive surfaces. Module tabs are one route with URL-synced `?tab=`;
the server-component shell does not remount on tab change. (`/connect` itself is the
public marketing landing — the app index is `/connect/home`.)

| Route                          | Screen                                                                             | Phase |
| ------------------------------ | ---------------------------------------------------------------------------------- | ----- |
| `/connect/home`                | Smart entry — coming-soon / onboarding / Day-1 home (flag-gated)                   | P0/P1 |
| `/connect/onboarding`          | Intent flow                                                                        | P1    |
| `/connect/profile`             | Own profile (view / edit) — Person-scoped                                          | P1    |
| `/connect/feed`                | Connect Home — Feed                                                                | P3    |
| `/connect/network?tab=`        | Network — Invitations / Connections / Following / Suggestions                      | P2    |
| `/connect/marketplace?tab=`    | Marketplace — Browse / RFQ Board (personal browsing)                               | P4    |
| `/connect/jobs?tab=`           | Jobs — Find Jobs / My Applications (personal job-seeking)                          | P5    |
| `/connect/store/[slug]/manage` | **Storefront admin** — Dashboard / Products / Leads / Quotes / Settings (`?tab=`)  | P4    |
| `/connect/page/[slug]/manage`  | **Company Page admin** — Dashboard / Posts / Jobs / Followers / Settings (`?tab=`) | P6    |
| `/connect/inbox?thread=`       | Unified inbox (Person-scoped — all roles)                                          | P7    |
| `/connect/notifications`       | Notifications center + preferences (Person-scoped)                                 | P7    |
| `/connect/search?q=&type=`     | Unified search results                                                             | P2    |
| `/connect/settings`            | Connect settings (notification prefs, privacy, saved searches)                     | P1+   |
| `/design-system`               | Component gallery (dev-only / admin-gated)                                         | P0    |

**Entity-scoped vs Person-scoped.** `Lead Manager`, `Posted Jobs`, `Candidates` are
**not** top-level routes — they are sub-tabs **inside an entity's admin context**
(Leads / Quotes inside a Storefront; Posted-Jobs / Candidates inside a Company Page).
Each owned `CompanyPage` / `Storefront` is reached by its name in the sidebar (no
workspace switcher, no active context). Composers (post / product / job / RFQ / voice
/ WhatsApp handoff) are **modal sheets, not routes**, and carry an explicit "Post as"
identity selector (Self / an owned Company Page / an owned Storefront).

---

## Shared component inventory

`components/connect/*` — compose existing `components/ui/Ds*` primitives (`DsButton`,
`DsCard`, `DsModal`, `DsDrawer`, `DsAvatar`, `DsTag`, `DsTable`, `DsInput`,
`DsEmptyState`), never duplicate. **Built just-in-time** — only the Phase-0 set is
pre-built; the rest are built in the phase that first needs them, then added to
`/design-system`. (Avoids rebuilding e.g. `PipelineColumn` if wireframes evolve.)

**Phase 0 — pre-built (shell + cross-cutting primitives only):**
`ConnectModuleNav` · `ConnectMobileTabBar` · `ConnectTopBar` · `ConnectSearchBar` ·
`TrustBadgeRow` · `ConnectEmptyState` · `WhatsAppCTA` · `ConnectErrorBoundary`
(+ route-level `error.tsx`).

**Just-in-time — built in the noted phase:**
`PersonCard`, `ProfileStrengthCard`, `ERPLinkedPanel`, `ERPCallout`, `RateRow`,
`ContactPreferenceSelector` (P1) · `ModuleTabs` (P2) · `PostCard`, `Composer` (with
the "Post as" identity selector), `VoiceNoteRecorder`, `MediaUploadGrid`,
`RightRailPanel`/`RailMiniList` (P3) · **business-entity foundation** —
`EntityAdminShell` + `EntityScopeBar`, `CreateEntityWizard`, `ErpLinkSetting`,
`OwnedEntitySidebarGroup` — plus `ProductCard`, `RFQCard`, `LeadCard`,
`QuotationCard`, `StickyActionBar` (P4) · `JobCard`, `PipelineColumn`,
`CallerIDBanner` (P5) · `CompanyCard` (P6) · `ContextBar`, `WhatsAppHandoffModal`
(P7). Maps design-doc §15 + wireframe patterns.

> **`ConnectModuleNav` reframe** — the Phase-0 shell sidebar is updated to render the
> owned-entity directory: a `YOUR PRESENCE` group (My Profile) plus conditional
> `COMPANY PAGES` and `STOREFRONTS` groups, each listing owned entities by name with
> a `+ Create` CTA (or a single "Create your business presence" CTA when both are
> empty). No workspace switcher; no active context. `EntityAdminShell` /
> `EntityScopeBar` and the create wizards are the **parallel foundation shared by
> Company Page and Storefront** — built once in Phase 4, reused by Phase 6.

---

## Backend modules

New Connect domain under `src/modules/connect/` (sub-modules, each a registered
`NestModule`).

| New module            | Schemas                                                                                                                                                     | Phase |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `connect/profile`     | `ConnectProfile`; `ErpLinkService` (per-entity ERP-linked badge derivation)                                                                                 | P0–P1 |
| `connect/network`     | `Connection`, `ConnectionRequest`, `Follow` (Mongo adjacency — no graph DB)                                                                                 | P2    |
| `connect/search`      | Meilisearch indexer + query service                                                                                                                         | P2+   |
| `connect/feed`        | `Post`, `Reaction`, `Comment`, `FeedEntry`; Socket.IO gateway                                                                                               | P3    |
| `connect/entities`    | `CompanyPage`, `Storefront` — **parallel sibling entities** (owner, slug, optional `erpWorkspaceId` per-entity ERP link). Shared foundation reused by P4/P6 | P4    |
| `connect/marketplace` | `Product`, `Inquiry`, `Rfq`, `Quote`, `Lead` — scoped to a `Storefront`                                                                                     | P4    |
| `connect/jobs`        | `Job`, `JobApplication`, `PipelineStage` — jobs are posted by a `CompanyPage`                                                                               | P5    |
| `connect/company`     | `CompanyFollower` + Company-Page surfaces (industry panel, pinned case study) on the P4 `CompanyPage` entity                                                | P6    |
| `connect/messaging`   | `Conversation`, `Message` (uses the P3 Socket.IO gateway)                                                                                                   | P7    |

**Reuse — verify, don't assert.** Phase 0 deliverable: audit `notifications`,
`uploads`, `audit`, `subscriptions` modules and **confirm the reuse plan or surface
deltas**. Expected: `uploads` (R2 — add `audio` category), `notifications` (new event
types), `mail`/`sms`, `auth`/`users`, `audit`, `subscriptions` reused; `users`
extended (`connectEnabled` flag). **`workspaces` is NOT extended** — `CompanyPage` /
`Storefront` are standalone Connect entities (own collections, own slug) that merely
hold an optional `erpWorkspaceId` reference; `ErpLinkService` reads workspace activity
read-only. The Connect public slug/metadata lives on the Connect entity, never on the
ERP `Workspace`.

Conventions every new module follows: `JwtAuthGuard` + guards, class-validator + Zod
DTOs, throttler tiers, `AuditService` logging, PostHog events, OpenTelemetry spans,
Sentry capture, `*.vitest.ts` tests, env via config loader.

---

## Feature flags & rollout (new — Phase 0)

Three layers, no new paid dependency:

1. **Module enablement** — a `connectModules` config (env / small JSON): which Connect
   modules are live. Drives onboarding intent availability and `/connect` nav.
2. **Per-user access** — `User.connectEnabled`. **Rollout policy:** admin-controlled
   during closed beta (admin panel toggle) → self-serve opt-in at onboarding once GA
   → default-on at GA. The `/connect/home` "coming soon" branch _is_ the not-enabled
   state — no redirect needed; flag-on users get the smart entry.
3. **Cohort / % rollout** — PostHog feature flags (PostHog already wired, free) for
   closed-beta cohorts and gradual percentage rollout.
4. **Entitlements (reserved for monetization)** — beyond module on/off, the registry
   enumerates _capability_ entries for the would-be paid surface: owning a
   `CompanyPage` (**business** identity), owning a `Storefront` (**selling**), and
   **marketing** tools (boosted posts / promoted listings). Each is a gateable
   entitlement with room for a per-tier _limit_ (e.g. free = 1 Company Page + 1
   Storefront; paid tiers raise the cap and unlock marketing). **No billing is built
   now** — the registry structure is reserved so a future subscription tier can charge
   for business / selling / marketing capacity without rework. Entitlement entries are
   wired with the entity foundation (Phase 4) and reuse the existing `subscriptions`
   module; until then every capability is unlimited / free.

Each phase ships behind its module flag → closed beta (10–50 workshop owners) →
feedback → GA.

---

## Phased build order

Each phase = backend + frontend desktop + **mobile-first** + empty states + 4-locale
i18n, full-stack, behind a feature flag. One screen end-to-end before the next. Each
phase gets a detailed sub-plan (acceptance criteria + task breakdown) and an owner
review checkpoint.

**Every phase carries a hardening sub-checklist** (done _within_ the phase, not
deferred): analytics events emitted (design-doc §16) · WCAG-AA self-audit · i18n
complete in all 4 locales · perf budget checked · seed data updated · demo / handoff
note for internal team.

| Phase                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                 | Key backend                                                                                                          | Key frontend                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **0 · Foundation**       | `--cn-*` tokens; Connect shell (nav, mobile tab bar, top bar, search); 8 Phase-0 components; `/design-system` route; `components/connect/` + `features/connect/` scaffolding; TanStack Query provider; **feature-flag system**; **public route group scaffold** (`(connect-public)`, layout, sitemap/robots, ISR); **`seed:connect` script**; docs/connect/ + memory                                                  | `connect/profile` scaffold (`ConnectProfile`, `ErpLinkService`); **audit notifications/uploads/audit/subscriptions** | Shell, design-system gallery                                                        |
| **1 · Identity**         | Profile own (`/platform/profile`) + public (`/u/[id]` SSR); Onboarding intent flow (intents flag-gated — unbuilt destinations show "coming soon"/waitlist); Day-1 home with **curated "Featured workshops to follow"** bootstrap list                                                                                                                                                                                 | Profile endpoints, ERP-linked derivation, people lookup                                                              | Profile, Onboarding, PersonCard, ProfileStrengthCard, TrustBadgeRow, ERPLinkedPanel |
| **2 · Network**          | Network (4 tabs), connections graph, follows, **algorithmic suggestions** (replaces curated list); **Meilisearch online** + people index                                                                                                                                                                                                                                                                              | `connect/network`, `connect/search`                                                                                  | Network, ModuleTabs                                                                 |
| **3 · Feed**             | Feed, post cards, composer (text/photo/video/voice), reactions, comments, "From your ERP". Composer **"Post as"** = Self-only until owned entities exist (gains Company Page / Storefront identities from P4). **Redis + BullMQ + Socket.IO online** (live feed + notification push)                                                                                                                                  | `connect/feed`, fan-out, gateway, voice upload                                                                       | Feed, PostCard, Composer, VoiceNoteRecorder, virtualization                         |
| **4 · Marketplace**      | **Business-entity foundation** (`CompanyPage` + `Storefront` primitives, create wizards, `EntityAdminShell` + `EntityScopeBar`, per-entity ERP-link, sidebar owned-entity groups — built once, reused by P6). **Storefront**: admin (Dashboard / Products / Leads / Quotes / Settings), public storefront (`/store/[slug]`) + product detail (`/products/[id]`), product composer, RFQ board, inquiries, bulk pricing | `connect/marketplace`                                                                                                | ProductCard, RFQCard, LeadCard, QuotationCard                                       |
| **5 · Jobs**             | Jobs home, public job detail (`/jobs/[id]`), job + requirement composers, Posted-Jobs ATS pipeline, Candidates tab                                                                                                                                                                                                                                                                                                    | `connect/jobs`                                                                                                       | JobCard, PipelineColumn, CallerIDBanner                                             |
| **6 · Company Pages**    | **Company Page** on the P4 entity foundation — public company page (`/company/[slug]`) + admin (Dashboard / Posts / Followers / Settings), industry panel, pinned case study, followers (Posted-Jobs / Candidates tabs wire in the P5 Jobs module)                                                                                                                                                                    | `connect/company`                                                                                                    | CompanyCard                                                                         |
| **7 · Cross-cutting**    | Unified inbox + messaging (typing/presence/live threads on the P3 gateway), notifications center + prefs, unified search results, WhatsApp handoff modal                                                                                                                                                                                                                                                              | `connect/messaging`                                                                                                  | Inbox, ContextBar, WhatsAppHandoffModal                                             |
| **8 · Launch hardening** | **Cross-cutting only** (per-phase hardening already done): full-surface security review, end-to-end E2E suite, load testing, final accessibility audit, SEO/sitemap verification, beta→GA rollout                                                                                                                                                                                                                     | —                                                                                                                    | —                                                                                   |

---

## Per-phase acceptance criteria

Each phase sub-plan defines **3–5 acceptance criteria as user-observable outcomes** —
what the owner checks against at the review checkpoint (not vibes).

**Template:** `A [persona] can [action] and [observe result], in [locale], at [380px /
desktop].`

**Phase 1 example:**

1. A new user opens Connect, picks an intent, and lands on the right next screen
   (built intents proceed; unbuilt ones show honest "coming soon").
2. A user completes a profile — headline, photo, ≥3 skills, ≥1 portfolio item — and
   sees it rendered, in their chosen locale, at 380px and desktop.
3. The profile is reachable at its public `/u/[id]` URL, server-rendered and
   indexable, working logged-out with a "Join Connect" CTA.
4. A profile shows the **ERP-linked** badge when its `User` is an active member of an
   ERP workspace (derived from employment); a user with no ERP does not.
5. The Day-1 home shows a curated discovery list to follow (Company Pages once they
   exist — Phase 6; a bootstrap stand-in until then).

---

## Standing engineering standards (the reusable contract)

Saved to memory + `docs/connect/ENGINEERING-STANDARDS.md`. Binding on every Connect
change — the owner should not need to repeat these.

1. **TypeScript strict — zero `any`.** No `@ts-ignore`. `tsc` clean before a phase closes.
2. **ESLint clean** — incl. `eslint-plugin-i18next`. No warnings.
3. **i18n every user-facing string** via `next-intl`. All four locales (`en`, `gu`,
   `gu-en`, `hi-en`) populated with real translations each phase — no English stubs.
   `scripts/check-i18n.js` (prebuild gate) must pass.
4. **Mobile-first — the primary design target.** Build the mobile layout first from
   the mobile wireframes (380px), then scale up to desktop as the responsive
   expansion. Never "build desktop, check mobile." Verified at 380 / 768 / 1280px.
5. **Reuse before build.** Compose `components/ui/Ds*` + `components/connect/`. Never
   duplicate. Lift reusable ERP code to a shared location rather than copying.
6. **AntD-first**, themed via `lib/theme.ts` `ConfigProvider`. Tailwind for layout
   utilities on custom elements only. Recreate wireframe visuals — don't port CSS.
7. **Next.js the right way** — Server Components for initial data, server actions for
   mutations, route handlers for webhooks. TanStack Query for interactive client
   surfaces. Public entity pages are SSR/ISR + indexable.
8. **No needless re-renders** — URL-synced tabs swap content without remounting the
   shell; stable callbacks / `React.memo` on list rows; `useDeferredValue` + debounce
   on search; virtualize long lists.
9. **Every screen has empty / loading / error states** + an **error boundary**
   (`ConnectErrorBoundary` / route `error.tsx`). Indian numbering for currency
   (`₹4,49,500`).
10. **No shortcuts, no stubs, no TODOs, no "future implementation."** A feature ships
    complete or it is not in the phase.
11. **Every new shared component** is rendered on `/design-system` in isolation.
12. **No git operations by the assistant** — the owner stages and commits.
13. **Logical changes** (new schema / module / permission model) surfaced for explicit
    approval; their _content_ is the assistant's call after research.
14. **Paid dependencies** flagged prominently at development time — owner decides.
15. **Per-phase hardening** — analytics events, WCAG self-audit, i18n completeness,
    perf budget, seed data, demo note done _within_ the phase, never stockpiled.
16. **Every phase ships behind a feature flag.** Verification before "done" — evidence,
    not assertion.

---

## Artifacts to create (Phase 0)

- `docs/connect/connect-build-plan.md` — this plan, both worktrees.
- `docs/connect/ENGINEERING-STANDARDS.md` — the 16-point contract.
- `docs/connect/IDENTITY-MODEL.md` — identity decision + edge cases.
- `/design-system` route — component gallery (populated as components are built).
- `seed:connect` script — realistic demo fixtures (profiles, workshops, posts) for
  stakeholder demos.
- PostHog **Connect funnel dashboard** definition — events from §16 feed it per phase.
- **Memory entries:** `project_connect_epic`, `feedback_connect_engineering_standards`,
  `project_connect_identity_model`.
- **Execution harness:** drive each phase with `/gsd-plan-phase` → `/gsd-execute-phase`.

---

## Verification (every phase)

- **Backend:** `tsc` clean · `vitest` green · `eslint` clean.
- **Web:** `tsc` strict clean (no `any`) · `eslint` clean (incl. i18next) ·
  `check:i18n` passes · `next build` passes.
- **Manual:** every screen at **380 / 768 / 1280px**; empty + loading + error states;
  keyboard nav; wireframe matched for layout & copy.
- **Acceptance criteria** (3–5 per phase) demonstrably met.
- **`/design-system`** renders every new component without error.
- **Playwright E2E** for the phase's critical flow.
- Public pages: server-rendered, indexable, work logged-out.
- **Owner review checkpoint** after each route/phase; flag any decision the design
  docs did not cover. The owner runs all `git` commits.

---

## Critical files

**Web** (`.worktrees/crewroster-web/zari360-connect/`):

- `app/connect/*` — authenticated Connect app; `app/connect/home/page.tsx` —
  flag-gated smart entry; `app/connect/{store,page}/[slug]/manage/` — entity admin
- `app/(connect-public)/*` — **new** public SEO route group (company, store, profile,
  product, job + `sitemap.ts`)
- `components/layout/ConnectSidebar.tsx` → replace with `ConnectModuleNav`
- `components/layout/DashboardLayout.tsx` — responsive, mobile-first `connect` mode
- `components/connect/*` — **new** shared component library (just-in-time)
- `features/connect/*` — **new** feature logic / server actions
- `lib/connect/flags.ts` — **new** feature-flag system
- `app/globals.css`, `tailwind.config.js`, `lib/theme.ts` — `--cn-*` token additions
- `app/messages/{en,gu,gu-en,hi-en}.json` — `connect.*` i18n namespace
- `app/design-system/page.tsx` — **new** gallery
- `scripts/seed-connect.*` — **new** seed script

**Backend** (`.worktrees/crewroster-backend/zari360-connect/`):

- `src/modules/connect/*` — **new** domain (profile, network, search, feed,
  marketplace, jobs, company, messaging)
- `src/app.module.ts` — register Connect modules
- `src/modules/uploads/*` — add `audio` category (after Phase 0 audit confirms)
- `src/modules/notifications/*` — Connect event types
- `src/common/enums/modules.enum.ts` — Connect `AppModule` entries

**Design source of truth:** `zari360_connect_design_decisions.md` (locked spec),
`Zari360 Connect Wireframes.html` + `connect-*.jsx`. Extracted to
`%TEMP%\zari360-handoff\zari360\project\` — copied into `docs/connect/` on execution.
