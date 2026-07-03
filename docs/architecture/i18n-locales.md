# Localization — Locale Strategy

**Status:** locked 2026-05-07 by Polish Initiative Phase 1A.

This doc explains why the `crewroster-backend` carries **two non-overlapping locale sets**, where each surface speaks which set, and what is intentionally out of scope for the polish initiative.

---

## Locale Matrix

| Surface                                               | Storage                                            | Locale Set                                           |
| ----------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Admin localization UI (`/admin/localization`)         | DB (`Language` + `Translation` collections)        | `en`, `gu`, `gu-en`, `hi-en`                         |
| Web app i18n (`crewroster-web`)                       | Static JSON in `app/messages/*.json`               | `en`, `gu`, `gu-en`, `hi-en`                         |
| Backend API (REST responses, error envelopes)         | Pulled from DB Translation collection              | `en`, `gu`, `gu-en`, `hi-en`                         |
| **Print pipeline** (PDF invoices, vouchers, receipts) | **File-based:** `src/i18n/{locale}/print.json`     | **`en`, `gu`, `hi`**                                 |
| Greeting templates (party-intelligence)               | Seed file `greeting-templates.seed.ts`             | `en`, `gu`, `hi`                                     |
| Reminder templates                                    | Service signature (`reminder-template.service.ts`) | `en`, `gu`, `hi`                                     |
| Number-to-words (`amount-in-words.dispatcher.ts`)     | Code dispatch                                      | `en`, `gu`, `hi`                                     |
| INR number formatting (`format-inr.util.ts`)          | `Intl.NumberFormat` locale tag                     | `en-IN`, `gu-IN`, `hi-IN`                            |
| Print fonts (`font-family-by-locale.ts`)              | Embedded font selection                            | `NotoSans`, `NotoSansGujarati`, `NotoSansDevanagari` |

---

## Why the print pipeline keeps `hi`

The print pipeline emits **PDFs** that render Hindi (Devanagari) using the `NotoSansDevanagari` font. It also drives the Hindi greeting/reminder templates and Hindi number-to-words conversion. Removing `hi` from the print pipeline would require:

1. Migrating `Firm.defaultPrintLocale` enum from `['en', 'gu', 'hi']`.
2. Migrating `Party.preferredLocale` enum from `['en', 'gu', 'hi']`.
3. Backfilling all existing Firm + Party documents with non-`hi` values.
4. Deleting the 2 Hindi greeting template seed entries.
5. Removing `NotoSansDevanagari` from `font-family-by-locale.ts`.
6. Removing the Hindi branch from `amount-in-words.dispatcher.ts` and `format-inr.util.ts`.
7. Removing `hi` from `print-i18n.service.PrintLocale` type alias.

Each of those is a **logical change to existing module behavior** and is forbidden by Polish Rule #2 (`POLISH-RULES.md`). They are NOT polish.

The polish initiative therefore preserves the file-based `hi` print pipeline as-is and only realigns the **DB-backed admin/web locale set** to the master plan's `en`/`gu`/`gu-en`/`hi-en` quartet.

---

## Why `hi-en` (Hinglish) instead of `hi`

`hi-en` is Hindi rendered in **English script** (Latin alphabet). It needs no Devanagari font, no special number formatter, and no separate amount-in-words dispatcher. It exists alongside `gu-en` (Gujarati in English script) which the platform already supports. Both serve users who prefer their language but read Latin script comfortably — the typical SMB owner persona on which CrewRoster is positioned.

Existing `hi` (Devanagari) usage in admin/web was minimal (no live admin DB content under `languageCode: 'hi'` was found at the time of this migration; only a static `crewroster-web/app/messages/hi.json` bundle existed). Dropping it costs nothing in user value while letting us remove an unused branch from the admin/web pipeline.

---

## Future migration path

If business requires sunsetting `hi` from the **print pipeline** in the future, that work belongs to its **own GSD plan** with explicit owner sign-off — most likely as part of a future Phase 5 finance polish module. It is not absorbed into the polish initiative.

The path would include:

- Data migration: Firm.defaultPrintLocale + Party.preferredLocale → `en` (or per-tenant choice).
- Hindi greeting/reminder template archival (sweep before deletion).
- PrintLocale type alias narrowing.
- Devanagari font removal from PDF bundle (lighter PDF).
- Tests for new locale set.

---

## Cleanup operations performed in Phase 1A

- Backend `ensureLanguagesExist()` seed list updated to `['en', 'gu', 'gu-en', 'hi-en']` (drops `es`, drops `hi`).
- Backend `seed-translations.ts` LANGUAGES updated likewise.
- Web `app/i18n.ts` SUPPORTED_LOCALES updated likewise; `hi.json` import removed; `hi-en.json` added as initial copy of `en.json` with `_metadata.translationStatus: "pending"` marker.
- One-shot migration `scripts/migrations/drop-legacy-locales.ts` deletes any DB rows under `languageCode IN ['hi', 'es']` (idempotent, safe to re-run).
- Print module **untouched.** All print-related code still references `'en' | 'gu' | 'hi'`.

---

## Operational reference

- Web check gate: `pnpm --filter crewroster-web check:i18n` validates `gu` / `gu-en` / `hi-en` against `en` for completeness.
- Backend check gate: `pnpm --filter crewroster-backend validate:i18n` extends the same completeness check to backend-loaded JSON sources.
- Hardcoded-string discovery: `pnpm --filter crewroster-web detect:hardcoded-i18n` (Phase 1A discovery only; Phase 1C flips ESLint rule to error and adds `--ci` flag to this script in `prebuild`).
