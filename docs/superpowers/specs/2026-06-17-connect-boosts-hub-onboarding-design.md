---

## Status (2026-06-17) — BUILT, gates green, UNCOMMITTED

Backend (crewroster-backend):

- New `GET /connect/ads/boosts/boostable` (BoostController) -> `BoostService.boostable()`:
  caller's eligible listings + jobs (status gate mirrors create gates, in-flight
  excluded in one campaign query) + `openTo` intents; profile model injected
  (trailing optional). Posts excluded.
- SWC build clean; eslint 0 (service+controller); 4 new vitest + full ads suite
  470/470 green.

Web (crewroster-web):

1. Tabs scrollbar hidden (BoostsManagerScreen tablist).
2. Wallet preset bug: shared `WalletTopUpForm` binds preset/custom to one amount +
   live "You'll add Rs X" summary; WalletPanel refactored onto it.
3. Inline `HubWalletStrip` (balance + reserved + Add-credits slide-over Drawer
   reusing purchaseWalletTopup) + low-balance nudge (< boostMinBudget). Full
   wallet page still works.
4. `BoostsHowItWorks` 3-step dismissible explainer (localStorage + auto-collapse
   on activity).
5. `BoostQuickStart` from the new endpoint: listings + jobs rails (cap 3 + "See
   all (N)" -> /connect/stores + /connect/jobs?tab=mine), intent nudges
   (hiring/deals), create-prompt fallback.
6. Empty state: "Start a boost" -> #boost-quick-start.

- Shared `checkout-gate.ts` (BOOST_CHECKOUT_ENABLED) now also gates the wallet
  top-up everywhere (BoostComposer refactored to import it). Honest GST: false
  "18% GST + tax invoice" copy replaced with a forward-looking note; no fake split,
  no invoices link (deferred to payment-gateway phase).
- loading.tsx mirrors the new sections. i18n: +keys x4 locales, check:i18n 13913
  parity. tsc 0, eslint 0, 72 ads vitest green.

Owner owes: stage + commit (both repos), gu/gu-en/hi-en native review of new
strings, visual smoke. No migration. Payment gateway + real GST/invoicing are a
later phase. Post-boost path left untouched (flagged: owner said general posts
not boostable - revisit whether to retire the existing post-boost composer).
