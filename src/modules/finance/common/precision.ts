/**
 * Money and Precision Policy (spec Section 6.5). The single source of truth for
 * how finance rounds money and splits GST. Mirrored byte-for-byte in the web at
 * crewroster-web/lib/finance/precision.ts - keep the two in sync.
 *
 * Money is stored as integer paise (1 rupee = 100 paise). No float stores money.
 */

/** Paise per rupee. */
export const PAISE_PER_RUPEE = 100;

/**
 * Round to the nearest integer paise, half away from zero.
 * Math.round rounds half toward +Infinity (asymmetric for negatives), which is
 * wrong for credit notes / reversals. This is symmetric: 2.5 -> 3, -2.5 -> -3.
 */
export function roundPaise(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * CGST and SGST for an intrastate line: each is half the GST rate on the taxable
 * value, rounded independently. Equal by construction (the IRP convention for an
 * intrastate supply reports CGST = SGST).
 */
export function gstHalves(
  taxablePaise: number,
  ratePercent: number,
): { cgstPaise: number; sgstPaise: number } {
  const half = roundPaise((taxablePaise * (ratePercent / 2)) / 100);
  return { cgstPaise: half, sgstPaise: half };
}

/** IGST for an interstate line: full rate on the taxable value. */
export function igstPaise(taxablePaise: number, ratePercent: number): number {
  return roundPaise((taxablePaise * ratePercent) / 100);
}

/**
 * Rate is stored at up to 4 decimal places of a rupee, as an integer count of
 * 1/10000-rupee units (centi-paise = 1/100 paise). A legacy 2-dp ratePaise
 * upscales as ratePaise * 100. See spec Section 6.5 item 2.
 */
export const CENTIPAISE_PER_PAISE = 100;

/** Effective rate in centi-paise: prefer the 4-dp rateCentiPaise, else upscale ratePaise. */
export function effectiveRateCentiPaise(line: {
  rateCentiPaise?: number | null;
  ratePaise: number;
}): number {
  return line.rateCentiPaise != null ? line.rateCentiPaise : line.ratePaise * CENTIPAISE_PER_PAISE;
}

/** Line amount in paise = qty x rate, rate given in centi-paise. Rounds once. */
export function lineAmountPaise(qty: number, rateCentiPaise: number): number {
  return roundPaise((qty * rateCentiPaise) / CENTIPAISE_PER_PAISE);
}

/** Convert a rupee rate (up to 4 dp) to integer centi-paise. */
export function rateCentiPaiseFromRupees(rupees: number): number {
  return roundPaise(rupees * 10000);
}

/** Rounded 2-dp display paise from centi-paise (the ratePaise display mirror). */
export function ratePaiseFromCentiPaise(rateCentiPaise: number): number {
  return roundPaise(rateCentiPaise / CENTIPAISE_PER_PAISE);
}
