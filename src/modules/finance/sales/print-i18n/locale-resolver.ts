import type { PrintLocale } from './print-i18n.service';

const VALID: PrintLocale[] = ['en', 'gu', 'hi'];
const isValid = (l: any): l is PrintLocale => typeof l === 'string' && (VALID as string[]).includes(l);

/**
 * Resolve voucher print locale per D-37:
 * explicit > party.preferredLocale > firm.defaultPrintLocale > 'en'.
 * Invalid values at any level fall through to the next.
 */
export function resolveLocale(opts: {
  explicit?: string | null;
  party?: { preferredLocale?: string | null } | null;
  firm?: { defaultPrintLocale?: string | null } | null;
}): PrintLocale {
  if (isValid(opts.explicit)) return opts.explicit;
  const partyLoc = opts.party?.preferredLocale;
  if (isValid(partyLoc)) return partyLoc;
  const firmLoc = opts.firm?.defaultPrintLocale;
  if (isValid(firmLoc)) return firmLoc;
  return 'en';
}
