# Connect Identity Model

**One identity, layered data — ERP and Connect are connected, never merged.**

## The two products

Zari360 is two products on one login:

- **ERP** — attendance / payroll / finance. Organized around a **`Workspace`**.
- **Connect** — the professional network / marketplace / jobs layer. Organized around
  a person's **`User`** and the **entities they own**.

"Workspace" is an **ERP word**. Connect has **no Workspace concept**. The two products
are joined by an opt-in **link**, not by a parent-child hierarchy.

## Connect's primitives

| Primitive        | Cardinality   | What it is                                                                                            |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `User`           | 1 per person  | Identity + login. Always you. Shared by ERP and Connect.                                              |
| `ConnectProfile` | 1 per `User`  | The person's Connect presence — a LinkedIn-style page. Person-scoped, always you.                     |
| `CompanyPage`    | 0..N per User | A standalone public **business identity**. Hires, posts. Own Connect entity + admin + public URL.     |
| `Storefront`     | 0..N per User | A standalone public **sales catalog**. Sells, manages leads. Own Connect entity + admin + public URL. |

`CompanyPage` and `Storefront` are **parallel sibling entities** — the same shape
(owner, slug, public page, admin dashboard, optional ERP link), different purpose.
A `User` can own any number of each, none, or a mix.

Connect is **not gated on ERP.** A karigar who never touches the ERP still gets a full
`ConnectProfile` and can even create a `Storefront` to sell their own work.

## Principle — connected, never merged

- A person is **one `User`** (global identity: `name`, `mobile`, `email`,
  `profilePicture`). One login. ERP↔Connect are modes of the _same_ session — no
  separate "Connect account".
- Connect data lives in **new Connect collections** (`ConnectProfile`, `CompanyPage`,
  `Storefront`, …) — **never** on the `User` schema (read by all 41 ERP modules; keep
  it lean).
- Shared identity fields (name, avatar, mobile) stay **canonical on `User`** and are
  _read_ by Connect. Connect adds its own banner + headline. Edit name/photo once →
  both products update.
- **Privacy wall:** ERP operational data (salary, attendance rows) **never** auto-leaks
  to a public Connect surface. Connect shows only what the user explicitly puts there +
  the derived ERP-linked _boolean_ signal.

## The ERP link — the moat

The moat is a **link between two products**, not an architecture. ERP integration is an
**optional, opt-in, per-entity** link:

- A **`CompanyPage`** can be linked to an ERP `Workspace` → earns the **ERP-linked
  badge**, derived from that workspace's activity.
- A **`Storefront`** can be linked to an ERP `Workspace` → same badge.
- A **`ConnectProfile`** shows ERP-linked context when the **`User` is an active member
  (employee / owner)** of one or more ERP workspaces — derived from employment
  (`WorkspaceMember` active rows), **not** from a field stored on the profile.

One `Workspace` can be linked from several Connect entities (a workshop's Company Page
and Storefront both linking the same ERP workspace). A user with no ERP simply has no
badge anywhere — Connect still works fully.

The **ERP-linked badge is derived, never stored** — `ErpLinkService` computes it from a
workspace's activity (≥5 attendance entries OR 1 payroll run OR 3 invoices in the last
30 days; 60-day silent decay — design-decisions doc §9.1). It is invoked **per linked
entity** (a Company Page's / Storefront's `erpWorkspaceId`) or **per the User's
employment** (for a Profile).

## Schema sketches (finalized in each entity's phase)

```
ConnectProfile {                 // 1 per User — Phase 1 (built)
  userId            ObjectId     // 1:1 with User — unique index
  headline, bio, banner
  skills            string[]
  portfolio[], experience[], recommendations[]
  rateCard          { dailyWage?, pieceRate?, monthly? }
  openTo            { work, hiring, deals, customOrders }
  contactPreference 'whatsapp' | 'phone' | 'dm'
  visibility        'public' | 'connections' | 'hidden'
  onboardedAt       Date?
  strength          number       // computed profile-completeness %
}
// NO workspace field. ERP-linked context derives from the User's employment.

CompanyPage {                    // 0..N per User — Phase 6
  ownerUserId       ObjectId     // the User who admins it
  slug              string       // unique — public URL /company/[slug]
  name, logo, banner, about
  industryPanel     { specialization, machineCapacity, production, languages }
  erpWorkspaceId    ObjectId?     // OPTIONAL ERP link → ERP-linked badge
  visibility, createdAt, updatedAt
}

Storefront {                     // 0..N per User — Phase 4
  ownerUserId       ObjectId
  slug              string       // unique — public URL /store/[slug]
  name, logo, banner, description
  categories        string[]
  erpWorkspaceId    ObjectId?     // OPTIONAL ERP link → ERP-linked badge
  companyPageId     ObjectId?     // OPTIONAL association to an owned Company Page
  visibility, createdAt, updatedAt
}
```

`ConnectProfile` is created **lazily** on first Connect onboarding. `CompanyPage` /
`Storefront` are created **explicitly** through their create wizard — never
auto-created. All three are owned by exactly one `User`.

## Edge cases (binding)

| Case                                             | Handling                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User` with no ERP at all                        | Full `ConnectProfile`; may own Company Pages / Storefronts; no ERP-linked badge anywhere. Connect works fully.                                                                    |
| `User` is an active member of ERP workspace(s)   | `ConnectProfile` shows ERP-linked context derived from employment (`WorkspaceMember` active rows). Multiple employments → OR of statuses; **no "primary workspace"** designation. |
| `CompanyPage` / `Storefront` not linked to ERP   | Valid entity, simply no ERP-linked badge. The link is opt-in, set in the entity's admin settings.                                                                                 |
| One `Workspace` linked from several entities     | Allowed — a workshop's Company Page + Storefront may both link the same ERP workspace.                                                                                            |
| `TeamMember` (karigar) with no `linkedUserId`    | No identity → not a real profile. Workshop-curated _claimable_ listing; "Invite to Connect" sets `linkedUserId`.                                                                  |
| Different display name / photo wanted on Connect | Avatar shared from `User`; Connect adds its own banner + headline. No separate legal name.                                                                                        |
| ERP user who wants no Connect presence           | `ConnectProfile` created lazily on first onboarding; `visibility` controls exposure. Never auto-exposed.                                                                          |
| `Workspace` / account deletion                   | ERP-linked badge decays silently; Connect entities cascade on `User` delete.                                                                                                      |

## Public exposure

| Entity           | Public URL        | Admin context                  |
| ---------------- | ----------------- | ------------------------------ |
| `ConnectProfile` | `/u/[userId]`     | `/connect/profile`             |
| `CompanyPage`    | `/company/[slug]` | `/connect/page/[slug]/manage`  |
| `Storefront`     | `/store/[slug]`   | `/connect/store/[slug]/manage` |

Public pages are SSR / ISR, indexable, and work logged-out (SEO + signup conversion).
`visibility` is enforced on every read; `connections` / `hidden` return a restricted
view or 404 to non-authorized viewers. Editing is always authenticated, inside the
entity's own admin context.
