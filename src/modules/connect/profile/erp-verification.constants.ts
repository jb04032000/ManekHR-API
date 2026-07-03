/**
 * Consent-first ERP-linked verification — shared constants (ADR-0004 /
 * 2026-06-18 spec).
 *
 * Single source of truth for the consent version stamped on both the person
 * consent (`ConnectProfile.erpVerificationConsent.consentVersion`) and the
 * entity link (`CompanyPage`/`Storefront`.erpLink.consentVersion). Bumping this
 * re-prompts users (the suggestion banner re-arms; a granted consent on an old
 * version reads as needing re-consent on the web). Keep in sync with the web
 * `connect.erpConsent.*` copy version.
 */
export const ERP_VERIFY_CONSENT_VERSION = 'erp-verify-v1';

/** Person consent status values for `ConnectProfile.erpVerificationConsent.status`. */
export type ErpConsentStatus = 'granted' | 'revoked';

/** Entity link status values for `CompanyPage`/`Storefront`.erpLink.status`. */
export type ErpLinkStatusValue = 'verified' | 'revoked';
