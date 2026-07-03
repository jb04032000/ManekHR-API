/**
 * GST State / UT Codes for India.
 *
 * Source: GSTN official state code list (37 states/UTs as of 2024).
 * Code 25 (Daman and Diu) was merged into 26 (Dadra and Nagar Haveli and
 * Daman and Diu) by the Constitution (One Hundred and First Amendment) Act
 * read with GSTN advisory effective 2020. Code 28 (pre-bifurcation Andhra
 * Pradesh) is retained for legacy invoice compatibility.
 */
export const GST_STATE_CODE_MAP: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

/**
 * Reverse lookup: lowercase normalised name -> code.
 * Built once at module load; O(1) lookups thereafter.
 */
const NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(GST_STATE_CODE_MAP).reduce<Record<string, string>>((acc, [code, name]) => {
    acc[name.toLowerCase()] = code;
    return acc;
  }, {}),
);

/**
 * Resolve an arbitrary state input to a canonical 2-digit GST state code.
 *
 * Rules (in priority order):
 *   1. Passthrough: if `input` is already a 2-digit numeric string that
 *      exists in the map, return it unchanged. This preserves existing
 *      behaviour where the frontend already sends correct codes.
 *   2. Name lookup: if `input` (trimmed, case-insensitive) matches a known
 *      state name, return its code.
 *   3. Unknown / empty: return '' so callers can detect unresolvable input.
 *
 * @param input - A state code ('24'), state name ('Gujarat'), or nullish.
 * @returns Canonical 2-digit code string, or '' if not resolvable.
 */
export function resolveStateCode(input?: string | null): string {
  if (!input) return '';

  const trimmed = input.trim();
  if (!trimmed) return '';

  // Rule 1: passthrough for a valid 2-digit code
  if (/^\d{2}$/.test(trimmed) && trimmed in GST_STATE_CODE_MAP) {
    return trimmed;
  }

  // Rule 2: name lookup (normalised)
  const byName = NAME_TO_CODE[trimmed.toLowerCase()];
  if (byName) return byName;

  return '';
}

/**
 * Returns true only when both codes are non-empty and equal, indicating an
 * intra-state supply (CGST + SGST applies). Returns false for any inter-state
 * or unresolvable case, so the safe default is IGST.
 */
export function isIntraState(supplierCode: string, placeOfSupplyCode: string): boolean {
  if (!supplierCode || !placeOfSupplyCode) return false;
  return supplierCode === placeOfSupplyCode;
}
