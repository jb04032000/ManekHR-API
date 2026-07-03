/**
 * Disposable / throwaway email domain blocklist.
 *
 * WHAT: a single source of truth for rejecting signups made with temporary
 * inbox providers (yopmail, mailinator, temp-mail, 10minutemail, etc.). These
 * are used to dodge verification, abuse free trials, and spam.
 *
 * WHY HERE (not an npm package): bundling the list as plain data keeps the
 * check fully offline, zero-runtime-dependency, and free — no external API
 * call, no new package in the build. Refresh the list by pasting new domains
 * into DISPOSABLE_DOMAINS below.
 *
 * GOTCHA: matching is on the registrable domain string only, lowercased. We do
 * NOT do MX lookups here — this is the cheap, instant first line. The OTP /
 * email-verification step is the second line for any clever domain not yet on
 * the list. See [[auth.service.sendEmailRegistrationOtp]] (primary gate) and
 * AuthService.register (backstop).
 *
 * Cross-link: gated by env.signup.blockDisposableEmail (src/config/env.ts) so
 * it can be turned off instantly via SIGNUP_BLOCK_DISPOSABLE_EMAIL=false with
 * no code change.
 */

// Curated set of the most prevalent disposable providers and their aliases.
// Covers the high-volume abuse domains; extend freely as new ones appear.
const DISPOSABLE_DOMAINS: readonly string[] = [
  // yopmail (single provider, many alias domains)
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'cool.fr.nf',
  'jetable.fr.nf',
  'nospam.ze.tc',
  'nomail.xl.cx',
  'mega.zik.dj',
  'speed.1s.fr',
  'courriel.fr.nf',
  'moncourrier.fr.nf',
  'monemail.fr.nf',
  'monmail.fr.nf',
  // mailinator + aliases
  'mailinator.com',
  'mailinator.net',
  'mailinator2.com',
  'mailinator.org',
  'reallymymail.com',
  'sogetthis.com',
  'spamherelots.com',
  'thisisnotmyrealemail.com',
  'binkmail.com',
  'bobmail.info',
  'devnullmail.com',
  // guerrillamail family
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.biz',
  'guerrillamail.de',
  'guerrillamailblock.com',
  'grr.la',
  'sharklasers.com',
  'spam4.me',
  'pokemail.net',
  // 10minutemail family
  '10minutemail.com',
  '10minutemail.net',
  '10minemail.com',
  '20minutemail.com',
  '10minutemail.de',
  // temp-mail family
  'temp-mail.org',
  'temp-mail.io',
  'tempmail.com',
  'tempmailo.com',
  'tempr.email',
  'tempmail.net',
  'tempinbox.com',
  'tempemail.com',
  'tmpmail.org',
  'tmpmail.net',
  'tmpeml.com',
  'minuteinbox.com',
  // throwaway / trash families
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'trashmail.de',
  'wegwerfmail.de',
  'wegwerfmail.net',
  'trbvm.com',
  'mailnesia.com',
  'maildrop.cc',
  'mailcatch.com',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'fakeinbox.com',
  'fake-mail.net',
  'fakemailgenerator.com',
  'mohmal.com',
  'emailondeck.com',
  'mailsac.com',
  'inboxkitten.com',
  'mailpoof.com',
  'harakirimail.com',
  'mailbox52.ga',
  'spambog.com',
  'spambox.us',
  'spamgourmet.com',
  'mytemp.email',
  'tempmailaddress.com',
  'burnermail.io',
  'mail-temp.com',
  'luxusmail.org',
  'discard.email',
  'discardmail.com',
  'maileater.com',
  'instant-mail.de',
  'einrot.com',
  'cuvox.de',
  'dayrep.com',
  'fleckens.hu',
  'gustr.com',
  'jourrapide.com',
  'rhyta.com',
  'superrito.com',
  'teleworm.us',
  'armyspy.com',
];

// Lowercased Set for O(1) lookups. Built once at module load.
const DISPOSABLE_SET = new Set(DISPOSABLE_DOMAINS.map((d) => d.toLowerCase()));

/**
 * True when the email's domain is a known disposable / throwaway provider.
 * Safe on malformed input (missing/multiple @) — returns false rather than
 * throwing so a bad address falls through to the normal @IsEmail validator.
 */
export function isDisposableEmailDomain(email: string | undefined | null): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_SET.has(domain);
}
