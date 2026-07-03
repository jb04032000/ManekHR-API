/**
 * Connect Referrals -- static disposable / throwaway email domain blocklist.
 * What: a short, well-known list of temporary-inbox providers. A referee signing
 *   up with one of these is skipped for referral attribution (a cheap, no-network
 *   anti-fraud guard against farming referral credits with burner emails).
 * Cross-module links: read by ReferralService.isDisposableEmail ->
 *   attachReferralAtSignup. Intentionally NOT exhaustive (no MX/DNS call here);
 *   it catches the high-volume offenders. Mobile is still OTP-verified at signup,
 *   so this is defence-in-depth, not the only gate.
 * Watch: keep entries lowercased + bare host (no leading @). Extend as new
 *   throwaway providers surface; matching is exact-host on the email domain.
 */

/** Lowercased bare hosts of common disposable email providers. */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'sharklasers.com',
  'dispostable.com',
  'fakeinbox.com',
  'maildrop.cc',
  'throwawaymail.com',
  'mailnesia.com',
  'mohmal.com',
  'tempinbox.com',
]);
