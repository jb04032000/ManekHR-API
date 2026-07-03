# ADR-0004: Gate the ERP-linked trust badge off until it can be earned (ownership-verified) and observed; deletion model unchanged

**Status:** Accepted — **Option B** (build the consent-based verification now). The Option-A "gate off" recommendation below is retained for the record but was NOT taken.
**Date:** 2026-06-18
**Deciders:** Owner (decided 2026-06-18: build the proper consent-based verification now; public badge reveal = "ERP-linked" + "active since {year}", no public headcount).
**Build contract:** `crewroster-web/docs/superpowers/specs/2026-06-18-erp-linked-verification-consent-design.md` + plan `crewroster-web/docs/superpowers/plans/2026-06-18-erp-linked-verification-consent.md`.

## Context

Connect renders an **"ERP-linked"** trust badge ("backed by a real business / real
work data — not a self-claim") on ~16 surfaces (profiles, company pages, storefronts,
jobs, feed/posts, search, marketplace, institute placement wall) via the shared
`TrustBadgeRow` (`crewroster-web/components/connect/TrustBadgeRow.tsx`) plus the
context panel `ERPLinkedPanel`. Marketing leans on it hard ("the moat",
`connect.marketing.trust.erpLinked`).

The owner flagged three worries: (1) we show the badge without a "proper setup";
(2) there's no real way for a user to _earn_ it / we shouldn't read ERP data without
permission; (3) if a user deletes their ERP account we never remove the badge. We are
**pre-launch** — there are no real ERP-linked Connect entities yet, so the badge today
appears almost entirely on seeded/demo data.

Read-only investigation across both repos established the actual mechanics, which
differ from the mental model in worry (3):

- **The badge is derived live, never stored.** `ErpLinkService`
  (`crewroster-backend/src/modules/connect/profile/erp-link.service.ts`) computes it
  on every read: ERP-linked = in the last 30 days the workspace logged **≥5 attendance
  OR ≥1 payroll run OR ≥3 invoices/expenses**, with a **60-day silent decay**. The
  `ConnectProfile` schema explicitly carries no badge field (comment at
  `connect-profile.schema.ts:20-22`); `CompanyPage` / `Storefront` carry only an
  optional `erpWorkspaceId` pointer.

- **Worry (3) is largely already handled by design — not a stored-stale badge.**
  Because the badge is derived from _live_ activity, a deleted/soft-deleted workspace
  stops returning activity, so the badge **drops on next read** and is already
  documented as "decays silently" (`docs/connect/IDENTITY-MODEL.md:121`). The residual
  problems are real but narrower:
  - The drop is **silent** — no notification, no audit trail of trust lost.
  - Workspace delete (`workspaces.service.ts` `delete()`) **does not touch** the
    Connect `CompanyPage` / `Storefront` rows, so `erpWorkspaceId` becomes a **dangling
    pointer**, and the editor still shows the "Linked to your ERP" note
    (`CompanyPageForm.tsx`) for a workspace that no longer exists.
  - Profile-side liveness relies on `WorkspaceMember` active rows; if offboarding /
    workspace-delete lags membership status, the badge lingers until the 60-day decay.

- **Worry (1)+(2) are the genuine gap: the badge cannot be _earned_ through a
  verified flow.**
  - For **CompanyPage / Storefront**, `erpWorkspaceId` is accepted in the
    create/update DTO (`company-page.dto.ts`) **with no check that the caller actually
    owns/admins that workspace**, and there is **no user-facing UI** that performs the
    link (the form only shows encouragement copy: "Already running on Zari360 ERP?
    Linking earns the ERP badge…"). So in practice no real user can link via the
    product, yet the API would let a crafted request inherit another workspace's trust.
  - For **Profile**, the badge is fully automatic from the user's own employment — no
    consent issue, but also no explicit verification step.
  - The intended verification experience exists only on paper:
    `crewroster-web/docs/superpowers/specs/2026-06-02-connect-verification-module-design.md`.

- **The badge has no inline explanation.** The i18n key `connect.badge.erpTooltip`
  ("Backed by real operational data… Not a self-claim.") exists but `TrustBadgeRow`
  never renders it; only the larger `ERPLinkedPanel` explains it, and not everywhere
  the pill appears.

This reframes the owner's question. The deletion case is mostly a design feature
(derive-live decay), so it is **not** a reason to panic. The real reason to act is
that we are advertising a trust signal that **cannot yet be earned through an
ownership-verified flow**, on a feature with **no users to verify** — classic
"ship the trust system before there's anything to trust" risk.

## Decision

**Recommended: Option A — gate the ERP-linked badge OFF for the initial phase behind a
reversible kill switch, document the gaps + the re-introduction checklist, and leave
the (already-correct) deletion/decay model unchanged.** Re-introduce when there are
real ERP users _and_ the ownership-verified linking flow + deletion observability ship.

Concretely:

1. **Backend single lever.** A `CONNECT_ERP_BADGE_ENABLED` env flag (read via
   `src/config/env.ts`; default **off** pre-launch). When off, `ErpLinkService`
   short-circuits to `{ linked: false }` so every downstream surface (profiles,
   pages, storefronts, jobs, feed denormalization) inherits "no badge" from one
   place. No schema change, no data change — `erpWorkspaceId` pointers stay intact for
   a clean re-enable.

2. **Web hide.** A `NEXT_PUBLIC_ERP_BADGE_ENABLED` flag (default **off**) that hides
   the ERP pill in `TrustBadgeRow`, the `ERPLinkedPanel`, and the "earn the badge"
   encouragement copy in the company/storefront editors, so the UI never promises a
   badge the backend won't grant. Marketing landing copy is left but flagged (see
   Consequences).

3. **Document, don't delete.** This ADR is the record; `IDENTITY-MODEL.md` gets a note
   that the badge is gated pending the verification flow. The 2026-06-02 verification
   spec becomes the canonical re-introduction plan.

4. **Deletion model unchanged.** Derive-live decay stays. The deletion _observability_
   (audit + dangling-pointer cleanup) is folded into the re-introduction work, not
   built now, because with the badge gated off it has no user-visible effect.

## Options Considered

### Option A: Gate off + document now (chosen / recommended)

| Dimension        | Assessment                                                   |
| ---------------- | ------------------------------------------------------------ |
| Complexity       | Low — two env flags + one short-circuit + conditional render |
| Effort           | Small (hours)                                                |
| Risk             | Very low — reversible, no schema/data change                 |
| Honesty to users | High — stops advertising an unearnable trust signal          |

**Pros:** Reversible (flip flags), matches the house kill-switch pattern
(`BOOST_CHECKOUT_ENABLED`, `NEXT_PUBLIC_PWA_ENABLED`,
`NEXT_PUBLIC_INBOX_UNIFIED_PERSON_VIEW`); removes a claim we can't back; defers the
verification build to when it has users (avoids speculative work).
**Cons:** Loses the "moat" trust marker marketing references; marketing copy needs a
soft "coming soon" framing or a small edit.

### Option B: Build the full verification + ownership-linked badge now

Build the `/connect/verify` hub, ownership-verified linking (only a workspace
owner/admin can link their own workspace, with a confirm step), deletion cleanup +
audit + notification, and render the badge tooltip — then keep the badge on.

| Dimension  | Assessment                                                   |
| ---------- | ------------------------------------------------------------ |
| Complexity | High — new flow, ownership challenge, cascade, audit, notify |
| Effort     | Large (days)                                                 |
| Risk       | Medium — new write paths + cross-product consent surface     |

**Pros:** Ships the feature "best-in-industry, complete." **Cons:** Premature — there
are no ERP users to verify yet; builds a consent/verification system ahead of demand.
Recommended **later**, as the re-introduction step, not now.

### Option C: Hybrid — keep Profile badge, gate only the entity (page/storefront) badge

Keep the auto-derived **Profile** ERP-linked badge (it reads the user's _own_
employment — no consent gap, self-healing) and gate off only the **CompanyPage /
Storefront** badge (the one with the unverified `erpWorkspaceId` link path) until
ownership-verified linking exists.

**Pros:** Preserves the safe, consent-clean signal; removes only the risky one.
**Cons:** Partial; the company badge is exactly the one marketing pushes ("backed by a
real business"); two code paths to reason about; still pre-launch so the Profile badge
also shows mostly on demo data. A reasonable middle ground if the owner wants to keep
_some_ signal live.

## Trade-off Analysis

Pre-launch, the badge's production value is ~0 (no real ERP-linked entities) while its
risk is real (advertises an unearnable, unverified trust signal). The cheapest honest
position is to stop showing it until it can be both **earned** (ownership-verified
link) and **trusted** (observable on deletion) — Option A. Option B is the right _end_
state but wrong _timing_: building a verification system before there's anyone to
verify is speculative. Option C is defensible if the owner values keeping the
consent-clean profile signal live, at the cost of a split feature.

## Consequences

- **Easier:** No surface advertises a trust badge we can't back; re-enable is a flag
  flip once the real flow exists.
- **Harder / watch:** Marketing landing copy (`connect.marketing.trust.erpLinked`,
  "the moat") still describes the badge — soften to "coming" or accept a brief
  mismatch until re-introduction. Demo/seed data that set `erpWorkspaceId` keeps the
  pointer (harmless while gated).
- **Revisit (re-introduction checklist — all must hold before flipping the flags on):**
  1. **Ownership-verified linking** — only a workspace owner/admin can link _their_
     workspace to a CompanyPage/Storefront, with an explicit confirm/consent step;
     reject `erpWorkspaceId` for workspaces the caller doesn't control.
  2. **Deletion observability** — on workspace soft-delete, clear/flag the dangling
     `erpWorkspaceId` on linked Connect entities, audit the trust loss, and (optional)
     notify the entity owner. Keep the derive-live decay as the safety net.
  3. **Badge explanation** — render `connect.badge.erpTooltip` on the pill so the
     signal is self-explaining everywhere it appears.
  4. **Real ERP users exist** to make the badge meaningful.
  5. Build it per the 2026-06-02 verification spec; update `IDENTITY-MODEL.md`.

## Action Items

1. [ ] Owner: choose **A** (gate off + document, recommended), **B** (build full
       verification now), or **C** (hybrid: keep profile badge, gate entity badge).
2. [ ] (If A) Add `CONNECT_ERP_BADGE_ENABLED` (env.ts, default off) + short-circuit in
       `ErpLinkService`; unit test both states.
3. [ ] (If A) Add `NEXT_PUBLIC_ERP_BADGE_ENABLED` (default off) + hide pill / panel /
       editor encouragement copy; keep i18n keys.
4. [ ] (If A) Note the gate in `docs/connect/IDENTITY-MODEL.md`; link this ADR.
5. [ ] Backlog (re-introduction): ownership-verified linking + deletion observability
   - tooltip, per the 2026-06-02 verification spec.
