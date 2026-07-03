/**
 * Convert paise (integer) to Indian-numbering words string.
 * Per F-02 D-21. Used as snapshot on invoice.amountInWords at Post time.
 */
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigit(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`;
}

function threeDigit(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (rest > 0) parts.push(twoDigit(rest));
  return parts.join(' ').trim();
}

function rupeesToWords(rupees: number): string {
  if (rupees === 0) return 'Zero';
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const hundredsBlock = rupees % 1000;
  const parts: string[] = [];
  if (crore > 0) parts.push(`${twoDigit(crore) || ONES[crore]} Crore`);
  if (lakh > 0) parts.push(`${twoDigit(lakh) || ONES[lakh]} Lakh`);
  if (thousand > 0) parts.push(`${twoDigit(thousand) || ONES[thousand]} Thousand`);
  if (hundredsBlock > 0) parts.push(threeDigit(hundredsBlock));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function amountInWords(paise: number): string {
  if (!Number.isFinite(paise) || paise < 0) return '';
  const rupees = Math.floor(paise / 100);
  const paiseRem = paise % 100;
  if (rupees === 0 && paiseRem === 0) return 'Rupees Zero Only';
  if (rupees === 0) return `${twoDigit(paiseRem)} Paise Only`;
  const rupeesPart = `Rupees ${rupeesToWords(rupees)}`;
  if (paiseRem === 0) return `${rupeesPart} Only`;
  return `${rupeesPart} and ${twoDigit(paiseRem)} Paise Only`;
}
