/**
 * Wave 8 — SMS segment / encoding calculator.
 *
 * Mirrors carrier billing math for MSG91. Two encodings:
 *   - GSM-7  (default-Latin Alphabet) → 160 chars / 1 segment, 153/seg if multi
 *   - UCS-2  (Hindi, emoji, any non-GSM char) → 70 chars / 1 segment, 67/seg if multi
 *
 * Extension chars (`{`, `}`, `[`, `]`, `~`, `|`, `^`, `\`, `€`, form-feed)
 * occupy 2 GSM-7 code points each. Any character outside the GSM-7 alphabet
 * forces the entire message to UCS-2.
 *
 * Mirror this util in `zari360-web/lib/sms/segments.ts` (live counter).
 * Keep in lockstep — drift = mis-billing.
 */

const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'.split(
    '',
  ),
);

const GSM7_EXTENSION = new Set('{}[]~|^\\€\f'.split(''));

export type SmsEncoding = 'GSM7' | 'UCS2';

export interface SegmentInfo {
  segments: number;
  encoding: SmsEncoding;
  /**
   * Effective character count used for the segment math. For GSM-7 this counts
   * extension chars as 2; for UCS-2 it's the JS string length (which already
   * counts surrogate pairs as 2 — astral-plane emoji span 2 code units).
   */
  charCount: number;
}

/**
 * Compute segments + encoding for a rendered SMS body.
 * Empty / undefined input → 1 segment GSM7 (matches MSG91 minimum-billable).
 */
export function computeSegments(text: string | undefined | null): SegmentInfo {
  const body = text ?? '';
  if (body.length === 0) {
    return { segments: 1, encoding: 'GSM7', charCount: 0 };
  }

  let isGsm7 = true;
  let gsmCharCount = 0;

  for (const ch of body) {
    if (GSM7_BASIC.has(ch)) {
      gsmCharCount += 1;
    } else if (GSM7_EXTENSION.has(ch)) {
      gsmCharCount += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    if (gsmCharCount <= 160) {
      return { segments: 1, encoding: 'GSM7', charCount: gsmCharCount };
    }
    return {
      segments: Math.ceil(gsmCharCount / 153),
      encoding: 'GSM7',
      charCount: gsmCharCount,
    };
  }

  // UCS-2 path. JS string length already counts surrogate pairs as 2,
  // matching what the SMSC sees on the wire.
  const ucsLen = body.length;
  if (ucsLen <= 70) {
    return { segments: 1, encoding: 'UCS2', charCount: ucsLen };
  }
  return {
    segments: Math.ceil(ucsLen / 67),
    encoding: 'UCS2',
    charCount: ucsLen,
  };
}
