# Connect — Backend Reuse Audit (Phase 0)

Phase 0 deliverable per `connect-build-plan.md` ("Reuse — verify, don't assert").
For each ERP module the build plan expects Connect to reuse, this audit reads the
real source and records one of three verdicts:

- **REUSE AS-IS** — usable unchanged from a Connect module.
- **EXTEND** — reusable, but a specific additive change is needed.
- **NEW** — Connect must build its own; the ERP module does not cover the need.

No code is changed by this audit. Extensions are deferred to the phase that first
needs them (the build plan's just-in-time rule). Phase 0 only consumes
`audit`, `users`, `workspaces`, and the ERP read-collections (for `ErpLinkService`).

Audited at: `src/modules/{notifications,uploads,audit,subscriptions,users,workspaces}`
plus the ERP read sources `attendance`, `salary`, `finance/{sales,expenses}`.

---

## 1. `notifications` — verdict: **EXTEND** (deferred to Phase 2/3)

**Source:** `src/modules/notifications/` — `notification.schema.ts`,
`notifications.service.ts`, `notifications.controller.ts`,
`me-notifications.controller.ts`, `types/notification.types.ts`.

**What exists.** A `Notification` collection (`workspaceId`, `recipientId`,
`title`, `message`, `type` ∈ `info|warning|success|error`, `isRead`, free-form
`metadata`). `NotificationsService` has both a workspace-scoped surface
(`findAll`/`markAsRead`/`createNotification`) and a **cross-workspace
user-scoped surface** added 2026-05-14 (`listForUser`, `countUnreadForUser`,
`markReadForUser`, `markAllReadForUser`) that scopes purely by `recipientId`.
`metadata.category` is an open string keyed off the `NotificationCategory`
enum (`INVITE_RECEIVED`, `ATTENDANCE_DEFAULTER`).

**Connect fit.** The user-scoped surface is exactly what Connect needs — Connect
notifications (connection request, post reaction, RFQ reply, job application)
are person-addressed and frequently cross-workspace, so `recipientId`-only
scoping is correct. The free-form `metadata` object absorbs Connect entity
links without a schema change.

**Delta — additive only:**

1. **`workspaceId` is `required: true` on the `Notification` schema.** Many
   Connect notifications have no workspace context (a buyer with no workspace
   reacts to a post). Phase 7 must relax this to nullable — mirror exactly the
   precedent already set on `AuditEvent.workspaceId` (`default: null`, existing
   tenant queries filter on a concrete ObjectId so null rows never leak).
2. **New `NotificationCategory` enum members** for Connect event types
   (e.g. `CONNECT_CONNECTION_REQUEST`, `CONNECT_POST_REACTION`,
   `CONNECT_RFQ_REPLY`, `CONNECT_JOB_APPLICATION`). Pure enum additions.
3. Real-time push (Socket.IO) is a Phase 3 concern; `createNotification`
   already has a `// In real app, also emit via WebSocket here` seam.

**Phase 0 impact:** none. `ConnectProfileModule` does not import notifications.
The two deltas are logical changes — surface them for owner approval in the
Phase 7 (messaging/notifications) sub-plan, not now.

---

## 2. `uploads` — verdict: **EXTEND** (deferred to Phase 1/3)

**Source:** `src/modules/uploads/` — `uploads.service.ts`, `uploads.module.ts`,
`services/{local,r2,s3}-storage.service.ts`, `schemas/upload-event.schema.ts`.

**What exists.** Provider-abstracted storage (`local` / `r2` / `s3` via
`IStorageService`), per-workspace quota enforcement against the owner
subscription's `appliedEntitlements.storage`, an `UploadEvent` audit log, and
storage-usage recompute. `uploadSingle(file, category, workspaceId?)` validates
both a **category allow-list** and a **MIME-type allow-list**.

**Connect fit.** The R2 path, quota engine, and `UploadEvent` log are reusable
as-is for Connect profile banners, portfolio images, post media, and product
photos.

**Delta — additive, two parts:**

1. **Category allow-list** (`validateCategory`, `uploads.service.ts` ~L427) is
   currently `['avatars','proofs','passbooks','qrcodes','profiles','branding','documents']`.
   Connect needs new categories: `connect-banners`, `connect-portfolio`,
   `connect-posts`, `connect-products`, and — per the build plan's explicit
   call-out — **`connect-audio`** for Phase 3 voice notes.
2. **MIME allow-list** is env-driven (`UPLOAD_ALLOWED_TYPES`, default
   `image/jpeg,image/png,image/webp,application/pdf`). Phase 3 voice notes need
   audio MIME types (`audio/webm`, `audio/mpeg`, `audio/mp4`, `audio/ogg`)
   and Phase 3 video needs `video/mp4` / `video/webm`. This is an env-value
   change plus possibly a per-category override so an image category can't
   accept audio. Per-file-size caps also differ for audio/video.

**Phase 0 impact:** none. The build plan already flags "uploads (R2 — add
`audio` category)" — confirmed accurate. The image-category additions land in
Phase 1; the `connect-audio` category + audio MIME types land in Phase 3.

---

## 3. `audit` — verdict: **REUSE AS-IS**

**Source:** `src/modules/audit/` — `audit.service.ts`, `audit.module.ts`,
`schemas/audit-event.schema.ts`.

**What exists.** `AuditService.logEvent(input)` writes an `AuditEvent` keyed by
an `AppModule` enum value, with tier-aware TTL retention. `AuditEvent.module`
is `enum: Object.values(AppModule)` — **so every Connect module needs its own
`AppModule` enum entry** (this audit's only Phase 0 action; see §7).
`AuditEvent.workspaceId` is already nullable (`default: null`) for
identity-layer events, and `CreateAuditEventInput.workspaceId` is
`string | Types.ObjectId | null | undefined` — Connect's workspace-less writes
(a buyer editing a profile) are already supported with no schema change.

**Connect fit.** Reuse unchanged. Every Connect write (`profile.update`,
`connection.accept`, `product.publish`, `job.post`) calls
`AuditService.logEvent` with `module: AppModule.CONNECT` (or a finer-grained
entry if Connect later splits — Phase 0 ships one `CONNECT` entry).

**Delta:** only the `AppModule.CONNECT` enum addition (§7) — which is _required_
for the audit module's `enum` validator to accept Connect rows. No change to
`audit` module source itself.

**Phase 0 impact:** `ConnectProfileModule` does **not** import `AuditModule` —
Phase 0 ships schema + `ErpLinkService` + wiring only, no writes/endpoints, so
nothing to audit yet. `AuditModule` gets imported in Phase 1 when profile CRUD
endpoints land. The `CONNECT` enum entry is added now so it is ready.

---

## 4. `subscriptions` — verdict: **REUSE AS-IS**

**Source:** `src/modules/subscriptions/` — `subscriptions.module.ts`
(`@Global()`), `subscriptions.service.ts`, `SubscriptionGuard`,
`schemas/{plan,subscription,tier,app-settings}.schema.ts`.

**What exists.** A `@Global()` module exporting `SubscriptionsService` +
`SubscriptionGuard`. `SubscriptionGuard` + `@RequireSubscription()`-style
decorators gate ERP endpoints by plan tier; `appliedEntitlements` carries
per-module entitlements (e.g. `storage`).

**Connect fit.** Reuse as-is. Connect is **feature-flagged, not subscription-
gated** in Phases 0–2 (the build plan's three-layer flag system:
`connectModules` config + `User.connectEnabled` + PostHog cohorts). Connect
controllers therefore do **not** apply `SubscriptionGuard` for the network
graph / profile reads. Where Connect _does_ touch subscriptions:

- `ErpLinkService` does not need it (it queries ERP activity collections, not
  the subscription).
- `uploads` quota (Phase 1+) already resolves `appliedEntitlements.storage`
  internally — Connect calls `UploadsService`, never `SubscriptionsService`
  directly for storage.
- A future "Connect Pro" paid tier (marketplace boosts, etc.) would add a new
  entitlement key — but that is a pricing decision, explicitly out of scope
  here and not assumed.

**Delta:** none for Phase 0–2. Being `@Global()`, no import needed even when a
later phase injects `SubscriptionsService`.

**Phase 0 impact:** none.

---

## 5. `users` — verdict: **EXTEND** (deferred to Phase 1)

**Source:** `src/modules/users/` — `user.schema.ts`, `users.service.ts`,
`users.module.ts`.

**What exists.** The canonical identity: `name`, `email`, `mobile`,
`profilePicture`, `isEmailVerified`, `isMobileVerified`, `hasWorkspace`,
billing profile. `UsersModule` exports `UsersService` **and** `MongooseModule`
(so the `User` model is injectable by any importer — used below by
`ConnectProfileModule`).

**Connect fit.** `ConnectProfile` is keyed 1:1 on `User._id` (the
`IDENTITY-MODEL.md` "one identity, layered data" rule). Shared identity fields
(name / avatar / mobile) stay canonical on `User` and are _read_ by Connect —
the `ConnectProfile` schema deliberately does **not** duplicate them. The
`User` schema must stay lean (read by all 41 ERP modules), so Connect-specific
profile data lives in the separate `ConnectProfile` collection — confirmed
correct, no large additions to `User`.

**Delta — additive, one field:**

1. **`User.connectEnabled: boolean` (default `false`)** — the per-user feature
   flag (build plan's rollout layer 2: admin-set in closed beta → self-serve
   opt-in at GA). One small boolean `@Prop`; does not bloat the schema and is
   the documented Phase-0 expectation ("`users` extended (`connectEnabled`
   flag)"). It lands in Phase 1 alongside the onboarding flow that reads it
   (the `/platform` "coming soon" page _is_ the flag-off state). It is a
   logical change — surface it in the Phase 1 sub-plan for owner approval.

**Phase 0 impact:** `ConnectProfileModule` registers the `User` model via its
own `MongooseModule.forFeature` (for the `ConnectProfile.userId` ref). It does
**not** import `UsersModule` — Mongoose keys models by name on the shared
connection, so a local `forFeature` is the standard NestJS cross-module
read-access pattern and avoids pulling in `UsersModule`'s provider graph. The
`connectEnabled` field is **not** added in Phase 0 (no flag-reading code exists
yet) — deferred to Phase 1 per the just-in-time rule.

---

## 6. `workspaces` — verdict: **REUSE read-only** (no schema change)

> Corrected 2026-05-18 for the entity reframe — see `IDENTITY-MODEL.md`.

**Source:** `src/modules/workspaces/` — `schemas/{workspace,workspace-member,
workspace-counter}.schema.ts`, `workspaces.module.ts`.

**What exists.** `Workspace` (name, `ownerId`, branding, many feature-config
sub-docs) and `WorkspaceMember` (the bridge row: workspace ↔ user ↔ role, with
`status`). `WorkspacesModule` exports `MongooseModule` so both models are
injectable by importers.

**Connect fit (post entity-reframe).** "Workspace" is an **ERP word** — Connect
has no Workspace concept and **does not extend the `Workspace` schema**.
`ErpLinkService` derives the ERP-linked signal _read-only_ from a workspace's
activity. `WorkspaceMember` is load-bearing: a `ConnectProfile`'s ERP-linked
context resolves from the User's **active employment** (`WorkspaceMember` rows
with `status: 'active'`) — there is **no `primaryWorkspace` field** on the
profile. `CompanyPage` / `Storefront` (Phases 4/6) each hold an _optional_
`erpWorkspaceId` reference; their public slug + business metadata live on those
**standalone Connect entities**, never on the ERP `Workspace`.

**Delta — none.** The `workspaces` schema is **not** extended for Connect:

1. **Company Page is a standalone entity, not workspace metadata.** The earlier
   plan ("`workspaces` extended with public slug/metadata") is superseded by the
   reframe — `CompanyPage` is its own collection (`connect/entities`, Phase 4)
   with its own `slug` + public fields, optionally linking a `workspaceId`.
2. The `Workspace` schema has no "ERP-linked since" field — and must not get
   one: ERP-linked is **derived, never stored**. `ErpLinkService` computes it
   live. Confirmed: no `workspace` schema change for the moat signal.

**Module impact:** `ConnectProfileModule` registers the `Workspace` +
`WorkspaceMember` models via its own `MongooseModule.forFeature` —
`WorkspaceMember` for the employment-based ERP-link resolution,`Workspace` for
`ErpLinkService`'s activity reads. It does **not** import `WorkspacesModule`.

---

## 7. `AppModule` enum — verdict: **EXTEND NOW** (Phase 0 action)

**Source:** `src/common/enums/modules.enum.ts`.

The only ERP-side change Phase 0 makes. `AuditEvent.module` validates against
`Object.values(AppModule)`, so a `CONNECT` member must exist before any Connect
audit row can be written (Phase 1+). A single entry is added now:

```ts
/** Zari360 Connect — network / marketplace / jobs platform layered on the ERP. */
CONNECT = 'connect',
```

Connect sub-modules (network, feed, marketplace, jobs, …) audit under this one
`CONNECT` value in v1; if a later phase needs finer audit granularity it can add
`connect:marketplace` etc. — but Phase 0 ships exactly one entry. No
`ModuleAction` additions are needed (Connect writes reuse `CREATE`/`EDIT`/
`DELETE`/`VIEW`).

---

## ERP read-sources for `ErpLinkService` (the moat derivation)

`ErpLinkService` computes the design-doc §9.1 "ERP-linked" signal from real ERP
activity. There is **no dedicated `PayrollRun` collection** — payroll in this
ERP is a batch of `Salary` documents per `(workspaceId, month, year)`. The three
signals map to:

| Signal (design-doc §9.1) | Collection                         | Class / token                                                                                                                         | Window field             |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ≥5 attendance entries    | `attendances`                      | `Attendance` (`attendance/schemas/attendance.schema.ts`)                                                                              | `createdAt` (timestamps) |
| ≥1 payroll run           | `salaries`                         | `Salary` (`salary/schemas/salary.schema.ts`) — a "run" = a distinct `(month, year)` group with `Salary` rows created in-window        | `createdAt` (timestamps) |
| ≥3 invoices/expenses     | `saleinvoices` + `expensevouchers` | `SaleInvoice` (`finance/sales/sale-invoice/sale-invoice.schema.ts`) + `ExpenseVoucher` (`finance/expenses/expense-voucher.schema.ts`) | `createdAt` (timestamps) |

All four schemas carry `workspaceId` and `@Schema({ timestamps: true })` (so a
`createdAt` field exists for the window queries). `SaleInvoice` /
`ExpenseVoucher` additionally have a `state` field — only `posted` (committed)
vouchers count as real operational activity (a draft or pending-approval
invoice is not proof of a running factory). These models are made injectable to
`ConnectProfileModule` by registering their schemas directly in the module's
own `MongooseModule.forFeature` — read-only — rather than importing the heavy
`AttendanceModule` / `SalaryModule` / `FinanceModule` provider graphs (and
`SaleInvoiceModule` does not even re-export its model). Mongoose keys models by
name on the shared connection, so this is the standard NestJS pattern for
cross-module read access with no coupling to those modules' internals.

> **Decision (not covered by the docs):** "payroll run" is interpreted as
> _a distinct `(month, year)` for which `Salary` rows were generated inside the
> 30-day window_, counted via an aggregation `$group`. The alternative —
> counting `Payment` rows — was rejected: a `Payment` is a disbursement against
> an already-generated `Salary`, so it double-counts and a workshop that
> _runs_ payroll but pays later would be missed. Generating the `Salary` batch
> is the act that proves the ERP is operational.

> **Decision (not covered by the docs):** invoices/expenses are counted only
> when `state: 'posted'` (and, for sale invoices, `isDeleted: false`). §9.1
> defines ERP-linked as "real operational data … not a self-claim", so the
> filter is a positive allow-list of the one _committed_ voucher state — not
> a `$nin` blocklist. This excludes `draft` **and** `pending_approval` (a
> sale invoice entered but not yet approved is not finalized activity —
> `SaleInvoiceService` itself only treats `posted` invoices as real revenue)
> as well as `cancelled` / `void`. An allow-list is also forward-safe: a
> future pre-posting state added to the `state` enum stays excluded
> automatically, whereas a blocklist would silently leak it into the moat
> signal. `ExpenseVoucher.state` (`draft|posted|cancelled`) is filtered the
> same `posted`-only way, so both collections apply one consistent rule.

> **Decision (not covered by the docs):** the `SaleInvoice` count is pinned to
> `voucherType: 'sale_invoice'`. The `saleinvoices` collection's `voucherType`
> enum also permits `quotation` / `sale_order` / `proforma` /
> `delivery_challan` (those each have a dedicated collection, but the shared
> `VoucherBase`-derived schema keeps the field open). §9.1 counts _invoices_,
> so a stray non-invoice voucher in that collection must not inflate the
> signal. The pin mirrors `SaleInvoiceService`, which scopes every query on
> this collection by `voucherType: 'sale_invoice'`. `ExpenseVoucher` needs no
> equivalent pin — its collection holds only expense vouchers.
