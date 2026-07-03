/**
 * Workspace designation presets + helpers.
 *
 * Two preset families:
 *  - TEXTILE preset (29 roles) — embroidery/garment SMBs (Karigar terminology, hand+machine
 *    embroidery line, finishing, pressing, packing, Munim, etc.).
 *  - GENERIC preset (4 roles)  — non-textile workspaces (legacy Manager/Supervisor/Staff/Cashier).
 *
 * Per-locale labels: `en` is the canonical key written to member.designation
 * (mobile-app read path). `gu-en` / `hi-en` use Indian-English textile vocabulary
 * (e.g. "Karigar"). `gu` is native Gujarati script. UI falls back to `en` when a
 * locale label is missing.
 *
 * Industry detection: `isTextileBusinessType` matches a substring of common
 * textile/garment/embroidery vocabulary on `workspace.businessType` (free-form
 * string). Owner can always edit the seeded list afterwards in workspace settings.
 */

export type DesignationLocale = 'en' | 'gu-en' | 'hi-en' | 'gu';

export interface DesignationLabels {
  en: string;
  'gu-en'?: string;
  'hi-en'?: string;
  gu?: string;
}

export interface DesignationRecord {
  /**
   * Canonical key. Equals `labels.en`. Stored on `team_member.designation`
   * (mobile-app read path stays plain string). Unique-per-workspace,
   * case-insensitive.
   */
  canonical: string;
  /** True if seeded from a preset, false if user-added. */
  isPreset: boolean;
  labels: DesignationLabels;
}

const r = (en: string, guEn: string, hiEn: string, gu: string): DesignationRecord => ({
  canonical: en,
  isPreset: true,
  labels: { en, 'gu-en': guEn, 'hi-en': hiEn, gu },
});

export const TEXTILE_DESIGNATION_PRESET: DesignationRecord[] = [
  r('Owner', 'Owner', 'Owner', 'માલિક'),
  r('Partner', 'Partner', 'Partner', 'ભાગીદાર'),
  r('CEO', 'CEO', 'CEO', 'સીઈઓ'),

  r('Floor Manager', 'Floor Manager', 'Floor Manager', 'ફ્લોર મેનેજર'),
  r('Production Manager', 'Production Manager', 'Production Manager', 'પ્રોડક્શન મેનેજર'),
  r('Production Planner', 'Production Planner', 'Production Planner', 'પ્રોડક્શન પ્લાનર'),
  r('HR Manager', 'HR Manager', 'HR Manager', 'એચઆર મેનેજર'),

  r('Designer', 'Designer', 'Designer', 'ડિઝાઈનર'),
  r('Pattern Master', 'Pattern Master', 'Pattern Master', 'પેટર્ન માસ્ટર'),
  r('Sampling Master', 'Sampling Master', 'Sampling Master', 'સેમ્પલિંગ માસ્ટર'),

  r('Worker', 'Karigar', 'Karigar', 'કારીગર'),
  r('Senior Worker', 'Master Karigar', 'Master Karigar', 'મુખ્ય કારીગર'),
  r('Aari Worker', 'Aari Karigar', 'Aari Karigar', 'આરી કારીગર'),
  r('Zari Worker', 'Zari Karigar', 'Zari Karigar', 'ઝરી કારીગર'),
  r('Hand Embroiderer', 'Hand Embroiderer', 'Hand Embroiderer', 'હાથ ભરતકામ કરનાર'),
  r('Machine Embroiderer', 'Machine Embroiderer', 'Machine Embroiderer', 'મશીન ભરતકામ કરનાર'),

  r('Cutting Master', 'Cutting Master', 'Cutting Master', 'કટિંગ માસ્ટર'),
  r('Tailor', 'Tailor', 'Tailor', 'દરજી'),
  r(
    'Sewing Machine Operator',
    'Sewing Machine Operator',
    'Sewing Machine Operator',
    'સિલાઈ મશીન ઓપરેટર',
  ),
  r('Hand Finisher', 'Hand Finisher', 'Hand Finisher', 'હાથ ફિનિશિંગ કરનાર'),
  r('Iron Operator', 'Press Karigar', 'Press Karigar', 'ઇસ્ત્રી ઓપરેટર'),

  r('QC Inspector', 'Quality Control Inspector', 'QC Inspector', 'ગુણવત્તા નિરીક્ષક'),

  r('Helper', 'Helper', 'Helper', 'હેલ્પર'),
  r('Packer', 'Packer', 'Packer', 'પેકર'),
  r('Storekeeper', 'Storekeeper', 'Storekeeper', 'સ્ટોરકીપર'),

  r('Accountant', 'Accountant', 'Accountant', 'એકાઉન્ટન્ટ'),
  r('Munim', 'Munim', 'Munim', 'મુનીમ'),

  r('Sales Representative', 'Sales Representative', 'Sales Representative', 'સેલ્સ પ્રતિનિધિ'),
  r(
    'Marketing Specialist',
    'Marketing Specialist',
    'Marketing Specialist',
    'માર્કેટિંગ સ્પેશિયાલિસ્ટ',
  ),
];

export const GENERIC_DESIGNATION_PRESET: DesignationRecord[] = [
  r('Manager', 'Manager', 'Manager', 'મેનેજર'),
  r('Supervisor', 'Supervisor', 'Supervisor', 'સુપરવાઈઝર'),
  r('Staff', 'Staff', 'Staff', 'સ્ટાફ'),
  r('Cashier', 'Cashier', 'Cashier', 'કેશિયર'),
];

const TEXTILE_BUSINESS_TYPE_KEYWORDS = [
  'textile',
  'garment',
  'embroidery',
  'apparel',
  'tailor',
  'tailoring',
  'fabric',
  'clothing',
  'fashion',
  'weaving',
  'dyeing',
  'printing',
  'saree',
  'zari',
  'silk',
];

/**
 * Substring-match against a free-form `businessType` string. Returns true for any
 * textile-family workspace; owner can still pick the generic preset by editing
 * the seed after creation.
 */
export function isTextileBusinessType(businessType?: string | null): boolean {
  if (!businessType) return false;
  const v = businessType.toLowerCase();
  return TEXTILE_BUSINESS_TYPE_KEYWORDS.some((kw) => v.includes(kw));
}

/**
 * Returns the preset list appropriate for a workspace's businessType.
 * Defensive deep-clone so callers can mutate the returned array safely.
 */
export function getDesignationPresetForBusinessType(
  businessType?: string | null,
): DesignationRecord[] {
  const preset = isTextileBusinessType(businessType)
    ? TEXTILE_DESIGNATION_PRESET
    : GENERIC_DESIGNATION_PRESET;
  return preset.map((rec) => ({
    canonical: rec.canonical,
    isPreset: rec.isPreset,
    labels: { ...rec.labels },
  }));
}

/**
 * Backward-compat read shim. Legacy workspaces store `designations: string[]`;
 * new workspaces store `DesignationRecord[]`. Always returns the record shape.
 * Strings convert to records with `isPreset=false` (so they aren't accidentally
 * counted as factory preset) and only the `en` label filled.
 */
export function normalizeDesignationsForRead(raw: unknown): DesignationRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => coerceToRecord(entry))
    .filter((rec): rec is DesignationRecord => rec !== null);
}

/**
 * Look up a designation against the known preset families (textile + generic)
 * by case-folded canonical match. Returns the matching preset record (with full
 * locale labels) or null. Used by `coerceToRecord` to auto-flag legacy data and
 * backfill missing locale labels from the preset on read.
 */
function findPresetMatch(canonical: string): DesignationRecord | null {
  const needle = canonical.toLowerCase().trim();
  if (!needle) return null;
  return (
    TEXTILE_DESIGNATION_PRESET.find((r) => r.canonical.toLowerCase() === needle) ??
    GENERIC_DESIGNATION_PRESET.find((r) => r.canonical.toLowerCase() === needle) ??
    null
  );
}

/**
 * Coerce a single legacy string or record-shaped object to a DesignationRecord.
 * Returns null for unrecognised entries (caller filters them out).
 *
 * F4 (2026-05-14): also looks up the canonical against the preset families. On
 * match: forces `isPreset: true` and merges missing locale labels from the
 * preset (owner-edited labels always win — we only fill empty slots). This
 * upgrades pre-F1 docs at read time without any DB write. False-positive
 * preset flag on a custom entry whose canonical happens to match a preset name
 * is accepted — `isPreset` carries no permission weight and the locale fill is
 * net-positive for UX.
 */
function coerceToRecord(entry: unknown): DesignationRecord | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const preset = findPresetMatch(trimmed);
    if (preset) {
      return {
        canonical: trimmed,
        isPreset: true,
        labels: { ...preset.labels, en: trimmed },
      };
    }
    return {
      canonical: trimmed,
      isPreset: false,
      labels: { en: trimmed },
    };
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const labelsRaw = (obj.labels ?? {}) as Record<string, unknown>;
    const en =
      typeof labelsRaw.en === 'string' && labelsRaw.en.trim()
        ? labelsRaw.en.trim()
        : typeof obj.canonical === 'string'
          ? obj.canonical.trim()
          : '';
    if (!en) return null;
    const labels: DesignationLabels = { en };
    if (typeof labelsRaw['gu-en'] === 'string' && labelsRaw['gu-en'].trim()) {
      labels['gu-en'] = labelsRaw['gu-en'].trim();
    }
    if (typeof labelsRaw['hi-en'] === 'string' && labelsRaw['hi-en'].trim()) {
      labels['hi-en'] = labelsRaw['hi-en'].trim();
    }
    if (typeof labelsRaw.gu === 'string' && labelsRaw.gu.trim()) {
      labels.gu = labelsRaw.gu.trim();
    }
    const preset = findPresetMatch(en);
    if (preset) {
      // Backfill missing locale slots from preset; owner edits win on any
      // slot already populated above. `en` stays as entry's canonical.
      if (!labels['gu-en'] && preset.labels['gu-en']) labels['gu-en'] = preset.labels['gu-en'];
      if (!labels['hi-en'] && preset.labels['hi-en']) labels['hi-en'] = preset.labels['hi-en'];
      if (!labels.gu && preset.labels.gu) labels.gu = preset.labels.gu;
      return {
        canonical: en,
        isPreset: true,
        labels,
      };
    }
    return {
      canonical: en,
      isPreset: obj.isPreset === true,
      labels,
    };
  }
  return null;
}
