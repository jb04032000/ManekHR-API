/**
 * Convert paise (integer) to Hindi (Devanagari) Indian-numbering words string.
 * Per Phase 16 D-40. Indian system: लाख / करोड़.
 * Suffix: "रुपये केवल" (singular: "रुपया केवल").
 */

// 0..99 — full Hindi cardinal table (compound forms 21..99 are unique).
const HI_0_99 = [
  '', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ',
  'दस', 'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस',
  'बीस', 'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस',
  'तीस', 'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस',
  'चालीस', 'इकतालीस', 'बयालीस', 'तैंतालीस', 'चौवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास',
  'पचास', 'इक्यावन', 'बावन', 'तिरेपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ',
  'साठ', 'इकसठ', 'बासठ', 'तिरेसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर',
  'सत्तर', 'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उन्यासी',
  'अस्सी', 'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी',
  'नब्बे', 'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे',
];

const HUNDRED = 'सौ';
const THOUSAND = 'हज़ार';
const LAKH = 'लाख';
const CRORE = 'करोड़';
const PAISE_WORD = 'पैसे';
const RUPEES_PLURAL = 'रुपये';
const RUPEE_SINGULAR = 'रुपया';
const ONLY = 'केवल';
const ZERO = 'शून्य';
const FOUR = HI_0_99[4]; // 'चार'

function twoDigit(n: number): string {
  if (n <= 0 || n > 99) return '';
  return HI_0_99[n];
}

function threeDigit(n: number): string {
  // 0..999 — Hindi convention: hundreds use "चार सौ" (four hundred) with space.
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${HI_0_99[h]} ${HUNDRED}`);
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
  if (crore > 0) parts.push(`${crore <= 99 ? HI_0_99[crore] : rupeesToWords(crore)} ${CRORE}`);
  if (lakh > 0) parts.push(`${HI_0_99[lakh]} ${LAKH}`);
  if (thousand > 0) parts.push(`${HI_0_99[thousand]} ${THOUSAND}`);
  if (hundredsBlock > 0) parts.push(threeDigit(hundredsBlock));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Unused-var guard — FOUR retained for documentary parity with reference table.
void FOUR;

export function amountInWordsHi(paise: number): string {
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
