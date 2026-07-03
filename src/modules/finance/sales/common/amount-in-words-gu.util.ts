/**
 * Convert paise (integer) to Gujarati-script Indian-numbering words string.
 * Per Phase 16 D-40. Indian system: lakh (લાખ) / crore (કરોડ).
 * Suffix: "રૂપિયા ફક્ત" (singular: "રૂપિયો ફક્ત").
 */

// 0..99 — full Gujarati cardinal table (compound forms 21..99 are unique).
// Verified against standard Gujarati number-word references.
const GU_0_99 = [
  '', 'એક', 'બે', 'ત્રણ', 'ચાર', 'પાંચ', 'છ', 'સાત', 'આઠ', 'નવ',
  'દસ', 'અગિયાર', 'બાર', 'તેર', 'ચૌદ', 'પંદર', 'સોળ', 'સત્તર', 'અઢાર', 'ઓગણીસ',
  'વીસ', 'એકવીસ', 'બાવીસ', 'ત્રેવીસ', 'ચોવીસ', 'પચ્ચીસ', 'છવ્વીસ', 'સત્તાવીસ', 'અઠ્ઠાવીસ', 'ઓગણત્રીસ',
  'ત્રીસ', 'એકત્રીસ', 'બત્રીસ', 'તેત્રીસ', 'ચોત્રીસ', 'પાંત્રીસ', 'છત્રીસ', 'સડત્રીસ', 'અડત્રીસ', 'ઓગણચાલીસ',
  'ચાલીસ', 'એકતાલીસ', 'બેતાલીસ', 'તેંતાલીસ', 'ચુંમાલીસ', 'પિસ્તાલીસ', 'છેતાલીસ', 'સુડતાલીસ', 'અડતાલીસ', 'ઓગણપચાસ',
  'પચાસ', 'એકાવન', 'બાવન', 'ત્રેપન', 'ચોપન', 'પંચાવન', 'છપ્પન', 'સત્તાવન', 'અઠ્ઠાવન', 'ઓગણસાઠ',
  'સાઈઠ', 'એકસઠ', 'બાસઠ', 'ત્રેસઠ', 'ચોસઠ', 'પાંસઠ', 'છાસઠ', 'સડસઠ', 'અડસઠ', 'ઓગણસિત્તેર',
  'સિત્તેર', 'એકોતેર', 'બોતેર', 'તોતેર', 'ચુમોતેર', 'પંચોતેર', 'છોતેર', 'સિત્યોતેર', 'ઇઠ્યોતેર', 'ઓગણાએંસી',
  'એંસી', 'એક્યાસી', 'બ્યાસી', 'ત્ર્યાસી', 'ચોર્યાસી', 'પંચાસી', 'છ્યાસી', 'સિત્યાસી', 'ઈઠ્યાસી', 'નેવ્યાસી',
  'નેવું', 'એકાણું', 'બાણું', 'ત્રાણું', 'ચોરાણું', 'પંચાણું', 'છન્નું', 'સત્તાણું', 'અઠ્ઠાણું', 'નવ્વાણું',
];

const HUNDRED = 'સો';
const THOUSAND = 'હજાર';
const LAKH = 'લાખ';
const CRORE = 'કરોડ';
const PAISE_WORD = 'પૈસા';
const RUPEES_PLURAL = 'રૂપિયા';
const RUPEE_SINGULAR = 'રૂપિયો';
const ONLY = 'ફક્ત';
const ZERO = 'શૂન્ય';

function twoDigit(n: number): string {
  if (n <= 0 || n > 99) return '';
  return GU_0_99[n];
}

function threeDigit(n: number): string {
  // 0..999
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${GU_0_99[h]} ${HUNDRED}`);
  if (rest > 0) parts.push(twoDigit(rest));
  return parts.join(' ').trim();
}

function rupeesToWords(rupees: number): string {
  if (rupees === 0) return ZERO;
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const hundredsBlock = rupees % 1000;
  const parts: string[] = [];
  if (crore > 0) parts.push(`${crore <= 99 ? GU_0_99[crore] : rupeesToWords(crore)} ${CRORE}`);
  if (lakh > 0) parts.push(`${GU_0_99[lakh]} ${LAKH}`);
  if (thousand > 0) parts.push(`${GU_0_99[thousand]} ${THOUSAND}`);
  if (hundredsBlock > 0) parts.push(threeDigit(hundredsBlock));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function amountInWordsGu(paise: number): string {
  if (!Number.isFinite(paise) || paise < 0) return '';
  const rupees = Math.floor(paise / 100);
  const paiseRem = paise % 100;
  if (rupees === 0 && paiseRem === 0) return `${ZERO} ${RUPEES_PLURAL} ${ONLY}`;
  const rupeesWord = rupees === 1 ? RUPEE_SINGULAR : RUPEES_PLURAL;
  if (paiseRem === 0) {
    return `${rupeesToWords(rupees)} ${rupeesWord} ${ONLY}`;
  }
  if (rupees === 0) {
    return `${twoDigit(paiseRem)} ${PAISE_WORD} ${ONLY}`;
  }
  return `${rupeesToWords(rupees)} ${rupeesWord} ${twoDigit(paiseRem)} ${PAISE_WORD} ${ONLY}`;
}
