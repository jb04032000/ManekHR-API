/**
 * Connect Referrals -- shareable referral code generator.
 * What: builds a human-friendly code = name/handle stem + random base32 suffix
 *   (6-10 chars, uppercase, NO ambiguous glyphs 0/O/1/I/L so it reads cleanly off
 *   a poster or WhatsApp share).
 * Cross-module links: used by ReferralService.getOrCreateMyCode to seed/regenerate
 *   User.referralCode; the code later resolves back to its owner in
 *   ReferralService.attachReferralAtSignup (findOne by referralCode).
 * Watch: `rng` is injectable so tests are deterministic. Collision handling lives
 *   in the service (regenerate suffix on E11000) -- this util is pure/stateless.
 */

/** Unambiguous alphabet: no 0, O, 1, I, L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Build a shareable code from a seed (the user's name or handle). Returns a
 * 6-10 char uppercase code: up to a 4-letter alpha stem from the seed + a 4-char
 * random suffix from the unambiguous alphabet. Falls back to a 'CR' stem when the
 * seed has no usable letters. `rng` defaults to Math.random; inject for tests.
 */
export function generateReferralCode(seed: string, rng: () => number = Math.random): string {
  const stem =
    (seed || 'CR')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 4) || 'CR';
  let suffix = '';
  // Use the INJECTED rng (not Math.random) so a fixed seed -> a deterministic code.
  for (let i = 0; i < 4; i++) suffix += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return (stem + suffix).slice(0, 10);
}
