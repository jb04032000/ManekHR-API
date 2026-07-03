/**
 * Salary advance recovery (EMI): split a total advance into monthly installment
 * amounts. Pure + deterministic so it is unit-testable and shared in spirit with
 * the web client. Exactly one of installmentCount / installmentAmount must be set.
 * The LAST installment absorbs any rounding remainder so the parts always sum to
 * the total (to the paisa).
 *
 * Rounding: matches the convention in component-calculator.ts
 * (Math.round to 2 decimals with Number.EPSILON guard). Kept local here so
 * this util remains a zero-dependency pure module with no import of service
 * layer code.
 */
export interface InstallmentConfig {
  installmentCount?: number;
  installmentAmount?: number;
}

/** Round to 2 decimal places (nearest paisa). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build a monthly installment schedule for an advance recovery.
 *
 * @param total   - Total advance amount (must be > 0).
 * @param config  - Exactly one of:
 *   - `installmentCount`: split into this many equal installments.
 *   - `installmentAmount`: derive the count from ceil(total / amount).
 * @returns       An array of installment amounts (in the same currency unit as
 *                `total`) whose sum equals `total`. The last element absorbs any
 *                rounding remainder.
 *
 * Throws if:
 *   - `total` is not a positive number.
 *   - Neither or both of `installmentCount` / `installmentAmount` are supplied.
 *   - `installmentCount` is less than 1.
 *   - `installmentAmount` is not positive.
 */
export function buildInstallmentSchedule(total: number, config: InstallmentConfig): number[] {
  if (!(total > 0)) {
    throw new Error('Advance total must be positive.');
  }

  const hasCount = config.installmentCount != null;
  const hasAmount = config.installmentAmount != null;

  if (hasCount === hasAmount) {
    // Both provided (both true) or neither provided (both false)
    throw new Error('Provide exactly one of installmentCount or installmentAmount.');
  }

  let count: number;
  let base: number;

  if (hasCount) {
    count = Math.floor(config.installmentCount);
    if (count < 1) throw new Error('installmentCount must be at least 1.');
    if (count === 1) return [round2(total)];
    base = round2(total / count);
  } else {
    const amount = config.installmentAmount;
    if (!(amount > 0)) throw new Error('installmentAmount must be positive.');
    if (amount >= total) return [round2(total)];
    count = Math.ceil(total / amount);
    base = round2(amount);
  }

  const parts: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    parts.push(base);
  }

  // Last installment absorbs any rounding remainder so sum === total exactly.
  const last = round2(total - base * (count - 1));
  parts.push(last);

  // Defensive: if base * (count - 1) somehow >= total (e.g. rounding edge where
  // base was rounded up), the last part becomes zero or negative. Drop those so
  // the returned array is clean. The remaining parts still sum to the advance
  // that was already "collected" in full, which is the correct behaviour for a
  // fully-recovered advance. This edge is only reachable with exotic inputs.
  return parts.filter((p) => p > 0);
}
