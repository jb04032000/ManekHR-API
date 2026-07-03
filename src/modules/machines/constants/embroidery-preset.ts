// Default attribute values for the 'embroidery' machine type.
// Values picked as the most common small-factory spec in India — overridable
// on create. Finalize after business-owner validation (plan open question #1).
export const EMBROIDERY_PRESET = {
  type: 'embroidery' as const,
  attributes: {
    needles: 9,
    heads: 12,
    hoopSizeMm: 360, // ~14-inch arm
    maxRpm: 1000,
  },
};
