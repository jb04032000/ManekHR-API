/**
 * Converts paise (integer) to a Tally-compatible amount string.
 *
 * Tally `<AMOUNT>` expects rupees with two decimal places, dot-separator,
 * no currency symbol, no thousands separator. Sign is leading `-` for
 * negatives.
 *
 * @example
 *   paiseToTallyAmount(12345678) === '123456.78'
 *   paiseToTallyAmount(-100)     === '-1.00'
 *   paiseToTallyAmount(0)        === '0.00'
 *   paiseToTallyAmount(50)       === '0.50'
 */
export function paiseToTallyAmount(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return sign + rupees + '.' + (p < 10 ? '0' : '') + p;
}
