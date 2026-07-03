import { GstRateHistory } from '../gst-rate-history.schema';

/**
 * GST Rate History seed — Jul 2017 launch through FY 2025-26.
 *
 * Sources:
 * - CBIC Notification 1/2017-CT(Rate) to 11/2017-CT(Rate) dated 28-06-2017 (launch rates)
 * - CBIC Notification 14/2021-CT(Rate) dated 18-11-2021 (textile rate revision — partly deferred)
 * - GST Council 46th meeting (29-12-2021) — deferred garment hike on ≤₹1000 articles
 * - CBIC Notification 15/2021-CT(Rate) dated 18-11-2021 (fabric & yarn 12% from Jan 2022)
 * - CBIC Notification 2/2022-CT(Rate) dated 31-03-2022 (various corrections)
 * - CBIC Notification 3/2023-CT(Rate) dated 28-02-2023 (pencil sharpeners, misc.)
 * - Cess rates: CBIC Notification 1/2017-CT(Cess) dated 28-06-2017
 *
 * Coverage:
 * - Chapters 50-63 (textile fibres, yarns, fabrics, garments) — primary focus
 * - HSN 9988 (job-work services) — used by karigar/job-work module
 * - Common other HSNs: 2710 (petroleum), 2401-2403 (tobacco+cess), 2523 (cement),
 *   7108 (gold), 7113-7117 (gems & jewellery), 8414 (fans/AC), 3004 (pharma),
 *   0402 (dairy), 1001-1006 (cereals), 3923 (plastics), 6305 (sacks/bags)
 *
 * [LOW CONFIDENCE] rows are marked per RESEARCH.md guidance — verify against
 * official CBIC notification PDFs at gstcouncil.gov.in before production use.
 *
 * Rate format: decimal percent (e.g. cgstRate: 6 = 6% CGST; igstRate: 12 = 12% IGST).
 * cessRate: 0 unless specific cess applies.
 */

type SeedRow = Partial<GstRateHistory>;

const D_2017_07_01 = new Date('2017-07-01T00:00:00.000Z');
const D_2022_01_01 = new Date('2022-01-01T00:00:00.000Z');
const D_2021_12_31 = new Date('2021-12-31T23:59:59.000Z');

const N_2017_LAUNCH = 'Notification 11/2017-CT(Rate) dated 28-06-2017';
const N_2021_TEXTILE = 'Notification 15/2021-CT(Rate) dated 18-11-2021 (effective 01-01-2022)';
const N_JOB_WORK_2022 =
  'Notification 15/2021-CT(Rate) dated 18-11-2021 (job-work printing, effective 01-01-2022)';

// ─── Helper for intra-state symmetric rates ──────────────────────────────────
function r(cgst: number): { cgstRate: number; sgstRate: number; igstRate: number } {
  return { cgstRate: cgst, sgstRate: cgst, igstRate: cgst * 2 };
}

export const GST_RATE_HISTORY_SEED: SeedRow[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 50 — SILK
  // ═══════════════════════════════════════════════════════════════════════════

  // 5001 — Silkworm cocoons suitable for reeling
  {
    hsnPrefix: '5001',
    description: 'Silkworm cocoons suitable for reeling',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },

  // 5002 — Raw silk (not thrown)
  {
    hsnPrefix: '5002',
    description: 'Raw silk (not thrown)',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },

  // 5003 — Silk waste
  {
    hsnPrefix: '5003',
    description: 'Silk waste',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },

  // 5004 — Silk yarn (not put up for retail sale)
  {
    hsnPrefix: '5004',
    description: 'Silk yarn (not put up for retail sale)',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5004',
    description: 'Silk yarn (not put up for retail sale)',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // 5005 — Yarn spun from silk waste
  {
    hsnPrefix: '5005',
    description: 'Yarn spun from silk waste',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5005',
    description: 'Yarn spun from silk waste',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // 5006 — Silk yarn and yarn spun from silk waste, put up for retail sale; silk-worm gut
  {
    hsnPrefix: '5006',
    description: 'Silk yarn put up for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5006',
    description: 'Silk yarn put up for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // 5007 — Woven fabrics of silk or silk waste
  {
    hsnPrefix: '5007',
    description: 'Woven fabrics of silk or silk waste',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5007',
    description: 'Woven fabrics of silk or silk waste',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 51 — WOOL, FINE/COARSE ANIMAL HAIR
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5101',
    description: 'Wool, not carded or combed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5102',
    description: 'Fine or coarse animal hair, not carded or combed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5103',
    description: 'Waste of wool or of fine or coarse animal hair',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5104',
    description: 'Garnetted stock of wool or fine/coarse animal hair',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },

  // 5105 — Wool and fine/coarse animal hair, carded or combed
  {
    hsnPrefix: '5105',
    description: 'Wool and animal hair, carded or combed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },

  // 5106-5110 — Yarn of wool / fine animal hair
  {
    hsnPrefix: '5106',
    description: 'Carded yarn of wool',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5106',
    description: 'Carded yarn of wool',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5107',
    description: 'Combed yarn of wool',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5107',
    description: 'Combed yarn of wool',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5108',
    description: 'Carded or combed yarn of fine animal hair',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5108',
    description: 'Carded or combed yarn of fine animal hair',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5109',
    description: 'Yarn of wool/fine animal hair for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5109',
    description: 'Yarn of wool/fine animal hair for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5110',
    description: 'Yarn of coarse animal hair or horsehair',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },

  // 5111-5113 — Woven fabrics of wool
  {
    hsnPrefix: '5111',
    description: 'Woven fabrics of carded wool or carded fine animal hair',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5111',
    description: 'Woven fabrics of carded wool or carded fine animal hair',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5112',
    description: 'Woven fabrics of combed wool or combed fine animal hair',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5112',
    description: 'Woven fabrics of combed wool or combed fine animal hair',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5113',
    description: 'Woven fabrics of coarse animal hair or horsehair',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 52 — COTTON
  // ═══════════════════════════════════════════════════════════════════════════

  // 5201-5203 — Raw cotton & cotton waste (nil-rated agricultural produce)
  {
    hsnPrefix: '5201',
    description: 'Cotton, not carded or combed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5202',
    description: 'Cotton waste',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5203',
    description: 'Cotton, carded or combed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },

  // 5204 — Cotton sewing thread
  {
    hsnPrefix: '5204',
    description: 'Cotton sewing thread',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5204',
    description: 'Cotton sewing thread',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // 5205-5207 — Cotton yarn
  {
    hsnPrefix: '5205',
    description: 'Cotton yarn (other than sewing thread), not for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5205',
    description: 'Cotton yarn (other than sewing thread), not for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5206',
    description: 'Cotton yarn, multiple or cabled, not for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5206',
    description: 'Cotton yarn, multiple or cabled, not for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5207',
    description: 'Cotton yarn put up for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5207',
    description: 'Cotton yarn put up for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // 5208-5212 — Woven fabrics of cotton
  {
    hsnPrefix: '5208',
    description: 'Woven fabrics of cotton, >=85% cotton, <=200 g/m2',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5208',
    description: 'Woven fabrics of cotton, >=85% cotton, <=200 g/m2',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5209',
    description: 'Woven fabrics of cotton, >=85% cotton, >200 g/m2',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5209',
    description: 'Woven fabrics of cotton, >=85% cotton, >200 g/m2',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5210',
    description: 'Woven fabrics of cotton, <85% cotton, <=200 g/m2',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5210',
    description: 'Woven fabrics of cotton, <85% cotton, <=200 g/m2',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5211',
    description: 'Woven fabrics of cotton, <85% cotton, >200 g/m2',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5211',
    description: 'Woven fabrics of cotton, <85% cotton, >200 g/m2',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5212',
    description: 'Other woven fabrics of cotton',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5212',
    description: 'Other woven fabrics of cotton',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 53 — VEGETABLE TEXTILE FIBRES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5301',
    description: 'Flax, raw or processed but not spun',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5302',
    description: 'True hemp, raw or processed but not spun',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5303',
    description: 'Jute and other textile bast fibres',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5305',
    description: 'Coconut, abaca, ramie and other vegetable textile fibres',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(0),
    notification: N_2017_LAUNCH,
  },

  // Yarn of vegetable fibres
  {
    hsnPrefix: '5306',
    description: 'Flax yarn',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5306',
    description: 'Flax yarn',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5307',
    description: 'Yarn of jute or other textile bast fibres',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5307',
    description: 'Yarn of jute or other textile bast fibres',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5308',
    description: 'Yarn of other vegetable textile fibres',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5308',
    description: 'Yarn of other vegetable textile fibres',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5309',
    description: 'Woven fabrics of flax',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5309',
    description: 'Woven fabrics of flax',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5310',
    description: 'Woven fabrics of jute',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5310',
    description: 'Woven fabrics of jute',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5311',
    description: 'Woven fabrics of other vegetable textile fibres',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5311',
    description: 'Woven fabrics of other vegetable textile fibres',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 54 — MAN-MADE FILAMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5401',
    description: 'Sewing thread of man-made filaments',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5401',
    description: 'Sewing thread of man-made filaments',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5402',
    description: 'Synthetic filament yarn, not for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5402',
    description: 'Synthetic filament yarn, not for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5403',
    description: 'Artificial filament yarn, not for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5403',
    description: 'Artificial filament yarn, not for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5404',
    description: 'Synthetic monofilament, strip etc of synthetic textile materials',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5405',
    description: 'Artificial monofilament, strip etc of artificial textile materials',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5406',
    description: 'Man-made filament yarn put up for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5406',
    description: 'Man-made filament yarn put up for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // Woven fabrics of man-made filaments
  {
    hsnPrefix: '5407',
    description: 'Woven fabrics of synthetic filament yarn',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5407',
    description: 'Woven fabrics of synthetic filament yarn',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5408',
    description: 'Woven fabrics of artificial filament yarn',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5408',
    description: 'Woven fabrics of artificial filament yarn',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 55 — MAN-MADE STAPLE FIBRES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5501',
    description: 'Synthetic filament tow',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5502',
    description: 'Artificial filament tow',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5503',
    description: 'Synthetic staple fibres, not carded, combed or processed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5504',
    description: 'Artificial staple fibres, not carded, combed or processed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5505',
    description: 'Waste of man-made fibres',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5506',
    description: 'Synthetic staple fibres, carded, combed or processed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5507',
    description: 'Artificial staple fibres, carded, combed or processed',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },

  // Yarn of man-made staple fibres
  {
    hsnPrefix: '5508',
    description: 'Sewing thread of man-made staple fibres',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5508',
    description: 'Sewing thread of man-made staple fibres',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5509',
    description: 'Yarn of synthetic staple fibres, not for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5509',
    description: 'Yarn of synthetic staple fibres, not for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5510',
    description: 'Yarn of artificial staple fibres, not for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5510',
    description: 'Yarn of artificial staple fibres, not for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5511',
    description: 'Yarn of man-made staple fibres, put up for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5511',
    description: 'Yarn of man-made staple fibres, put up for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // Woven fabrics of man-made staple fibres
  {
    hsnPrefix: '5512',
    description: 'Woven fabrics of synthetic staple fibres, >=85%',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5512',
    description: 'Woven fabrics of synthetic staple fibres, >=85%',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5513',
    description: 'Woven fabrics of synthetic staple fibres, <85% with cotton, <=170 g/m2',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5513',
    description: 'Woven fabrics of synthetic staple fibres, <85% with cotton, <=170 g/m2',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5514',
    description: 'Woven fabrics of synthetic staple fibres, <85% with cotton, >170 g/m2',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5514',
    description: 'Woven fabrics of synthetic staple fibres, <85% with cotton, >170 g/m2',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5515',
    description: 'Other woven fabrics of synthetic staple fibres',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5515',
    description: 'Other woven fabrics of synthetic staple fibres',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5516',
    description: 'Woven fabrics of artificial staple fibres',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5516',
    description: 'Woven fabrics of artificial staple fibres',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 56 — WADDING, FELT, NONWOVENS, CORDAGE
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5601',
    description: 'Wadding of textile materials and articles thereof; textile fibres, <=5mm',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5601',
    description: 'Wadding of textile materials and articles thereof',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5602',
    description: 'Felt, whether or not impregnated',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5602',
    description: 'Felt, whether or not impregnated',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5603',
    description: 'Nonwovens, whether or not impregnated',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5603',
    description: 'Nonwovens, whether or not impregnated',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5604',
    description: 'Rubber thread and cord, textile covered; textile yarn with rubber or plastics',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5605',
    description: 'Metallised yarn, whether or not gimped',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5606',
    description: 'Gimped yarn, slit yarn etc; chenille yarn; loop wale-yarn',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5607',
    description: 'Twine, cordage, ropes and cables',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5607',
    description: 'Twine, cordage, ropes and cables',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5608',
    description: 'Knotted netting of twine, cordage or rope; made-up fishing nets',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5609',
    description: 'Articles of yarn, strip, twine, cordage, rope or cables',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 57 — CARPETS AND FLOOR COVERINGS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5701',
    description: 'Carpets and other textile floor coverings, knotted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5701',
    description: 'Carpets and other textile floor coverings, knotted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5702',
    description: 'Carpets and other textile floor coverings, woven',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5702',
    description: 'Carpets and other textile floor coverings, woven',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5703',
    description: 'Carpets and other textile floor coverings, tufted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5703',
    description: 'Carpets and other textile floor coverings, tufted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5704',
    description: 'Carpets and other textile floor coverings, of felt',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5705',
    description: 'Other carpets and other textile floor coverings',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5705',
    description: 'Other carpets and other textile floor coverings',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 58 — SPECIAL WOVEN FABRICS, TUFTED, LACE, EMBROIDERY
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5801',
    description: 'Woven pile fabrics and chenille fabrics',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5801',
    description: 'Woven pile fabrics and chenille fabrics',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5802',
    description: 'Terry towelling and similar woven terry fabrics',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5802',
    description: 'Terry towelling and similar woven terry fabrics',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5803',
    description: 'Gauze, other than narrow fabrics',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5803',
    description: 'Gauze, other than narrow fabrics',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5804',
    description: 'Tulles and other net fabrics; lace in the piece',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5804',
    description: 'Tulles and other net fabrics; lace in the piece',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5805',
    description: 'Hand-woven tapestries; needlepoint, upholstery (Gobelins etc.)',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5805',
    description: 'Hand-woven tapestries',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5806',
    description: 'Narrow woven fabrics; narrow fabrics of warp without weft',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5806',
    description: 'Narrow woven fabrics',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5807',
    description: 'Labels, badges and similar articles of textile materials',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5808',
    description: 'Braids in the piece; ornamental trimmings in the piece',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5808',
    description: 'Braids in the piece; ornamental trimmings in the piece',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5809',
    description: 'Woven fabrics of metal thread and woven fabrics of metallised yarn',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5810',
    description: 'Embroidery in the piece, in strips or in motifs',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  }, // KEY: embroidery HSN
  {
    hsnPrefix: '5810',
    description: 'Embroidery in the piece, in strips or in motifs',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '5811',
    description: 'Quilted textile products in the piece',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5811',
    description: 'Quilted textile products in the piece',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 59 — IMPREGNATED, COATED, COVERED TEXTILE FABRICS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '5901',
    description: 'Textile fabrics coated with gum or amylaceous substances',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5902',
    description: 'Tyre cord fabric of high tenacity yarn of nylon/polyesters/viscose rayon',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5903',
    description: 'Textile fabrics impregnated, coated, covered with plastics',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5904',
    description: 'Linoleum; floor coverings with textile backing',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(9),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5905',
    description: 'Textile wall coverings',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5906',
    description: 'Rubberised textile fabrics',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5907',
    description: 'Textile fabrics otherwise impregnated, coated or covered',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5908',
    description: 'Textile wicks, woven, plaited or knitted for lamps, stoves, etc.',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5909',
    description: 'Textile hosepiping and similar textile tubing',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5910',
    description: 'Transmission or conveyor belts of textile material',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '5911',
    description: 'Textile products and articles, for technical uses',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 60 — KNITTED OR CROCHETED FABRICS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '6001',
    description: 'Pile fabrics, including long pile fabrics and terry fabrics, knitted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6001',
    description: 'Pile fabrics, knitted or crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6002',
    description: 'Knitted or crocheted fabrics, width <=30 cm, >=5% elastomeric/rubber',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6002',
    description: 'Knitted or crocheted fabrics, narrow',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6003',
    description: 'Knitted or crocheted fabrics, width <=30 cm NES',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6003',
    description: 'Knitted or crocheted fabrics, width <=30 cm NES',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6004',
    description: 'Knitted or crocheted fabrics, width >30 cm, >=5% elastomeric/rubber',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6004',
    description: 'Knitted or crocheted fabrics, width >30 cm, with elastane',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6005',
    description: 'Warp knit fabrics (including those made on galloon machines)',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6005',
    description: 'Warp knit fabrics',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6006',
    description: 'Other knitted or crocheted fabrics',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6006',
    description: 'Other knitted or crocheted fabrics',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 61 — KNITTED/CROCHETED GARMENTS
  // Garments <=₹1000 taxable value: 5% (2017) → 5% (2022, Council deferred hike)
  // Garments >₹1000: 5% (2017) → 12% (Jan 2022)
  // [LOW CONFIDENCE] on exact ₹1000 cutoff post-2022 — verify vs Notif 14/2021-CT(Rate)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '6101',
    description: 'Overcoats, car-coats, capes, cloaks etc of knitted/crocheted, men/boys (<=₹1000)',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6102',
    description:
      'Overcoats, car-coats, capes, cloaks etc of knitted/crocheted, women/girls (<=₹1000)',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6103',
    description: 'Suits, ensembles, jackets, trousers etc knitted/crocheted, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6103',
    description: 'Suits, ensembles, jackets, trousers etc knitted/crocheted, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6104',
    description: 'Suits, ensembles, jackets, dresses etc knitted/crocheted, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6104',
    description: 'Suits, ensembles, jackets, dresses etc knitted/crocheted, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6105',
    description: 'Shirts, knitted or crocheted, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6105',
    description: 'Shirts, knitted or crocheted, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6106',
    description: 'Blouses, shirts, knitted or crocheted, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6106',
    description: 'Blouses, shirts, knitted or crocheted, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6107',
    description: 'Underpants, briefs, nightwear etc knitted/crocheted, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6107',
    description: 'Underpants, briefs, nightwear etc knitted/crocheted, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6108',
    description: 'Slips, petticoats, briefs, nightwear etc knitted/crocheted, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6108',
    description: 'Slips, petticoats, briefs, nightwear etc knitted/crocheted, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6109',
    description: 'T-shirts, singlets and other vests, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6109',
    description: 'T-shirts, singlets and other vests, knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6110',
    description: 'Jerseys, pullovers, sweatshirts, cardigans, waistcoats etc knitted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6110',
    description: 'Jerseys, pullovers, sweatshirts, cardigans, waistcoats etc knitted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6111',
    description: 'Babies garments and clothing accessories, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6111',
    description: 'Babies garments and clothing accessories, knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6112',
    description: 'Track suits, ski suits and swimwear, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6112',
    description: 'Track suits, ski suits and swimwear, knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6113',
    description: 'Garments of fabrics of heading 5903, 5906 or 5907, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6114',
    description: 'Other garments, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6114',
    description: 'Other garments, knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6115',
    description: 'Panty hose, tights, stockings, socks etc knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6115',
    description: 'Panty hose, tights, stockings, socks etc knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6116',
    description: 'Gloves, mittens and mitts, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6116',
    description: 'Gloves, mittens and mitts, knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6117',
    description: 'Other clothing accessories, knitted/crocheted',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6117',
    description: 'Other clothing accessories, knitted/crocheted',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 62 — NOT KNITTED OR CROCHETED GARMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '6201',
    description: 'Overcoats, raincoats, car-coats etc of woven, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6201',
    description: 'Overcoats, raincoats etc of woven, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6202',
    description: 'Overcoats, raincoats, car-coats etc of woven, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6202',
    description: 'Overcoats, raincoats etc of woven, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6203',
    description: 'Suits, ensembles, jackets, blazers, trousers etc woven, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6203',
    description: 'Suits, ensembles, jackets, blazers, trousers etc woven, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6204',
    description: 'Suits, ensembles, jackets, dresses, skirts etc woven, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6204',
    description: 'Suits, ensembles, jackets, dresses, skirts etc woven, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6205',
    description: 'Shirts of woven fabric, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6205',
    description: 'Shirts of woven fabric, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6206',
    description: 'Blouses, shirts of woven fabric, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6206',
    description: 'Blouses, shirts of woven fabric, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6207',
    description: 'Underpants, briefs, nightshirts, pyjamas etc woven, men/boys',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6207',
    description: 'Underpants, briefs, nightshirts, pyjamas etc woven, men/boys',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6208',
    description: 'Slips, petticoats, briefs, pyjamas, negligees etc woven, women/girls',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6208',
    description: 'Slips, petticoats, briefs, pyjamas, negligees etc woven, women/girls',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6209',
    description: 'Babies garments and clothing accessories of woven',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6209',
    description: 'Babies garments and clothing accessories of woven',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6210',
    description: 'Garments made up of fabrics of 5602, 5603, 5903, 5906 or 5907',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6211',
    description: 'Track suits, ski suits and swimwear; other garments of woven',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6211',
    description: 'Track suits, ski suits and swimwear; other garments of woven',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6212',
    description: 'Brassieres, girdles, corsets, braces, suspenders etc',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6212',
    description: 'Brassieres, girdles, corsets, braces, suspenders etc',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6213',
    description: 'Handkerchiefs',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6213',
    description: 'Handkerchiefs',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6214',
    description: 'Shawls, scarves, mufflers, mantillas, veils and the like',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6214',
    description: 'Shawls, scarves, mufflers, mantillas, veils and the like',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6215',
    description: 'Ties, bow ties and cravats',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6215',
    description: 'Ties, bow ties and cravats',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6216',
    description: 'Gloves, mittens and mitts of woven',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6216',
    description: 'Gloves, mittens and mitts of woven',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6217',
    description: 'Other clothing accessories of woven; parts of garments',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6217',
    description: 'Other clothing accessories of woven; parts of garments',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAPTER 63 — OTHER MADE-UP TEXTILE ARTICLES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '6301',
    description: 'Blankets and travelling rugs',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6301',
    description: 'Blankets and travelling rugs',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6302',
    description: 'Bed linen, table linen, toilet linen, kitchen linen',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6302',
    description: 'Bed linen, table linen, toilet linen, kitchen linen',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6303',
    description: 'Curtains (including drapes) and interior blinds; curtain or bed valances',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6303',
    description: 'Curtains (including drapes) and interior blinds',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6304',
    description: 'Other furnishing articles, excluding those of 9404',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6304',
    description: 'Other furnishing articles',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6305',
    description: 'Sacks and bags, for packaging of goods',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  }, // jute bags 5%
  {
    hsnPrefix: '6305',
    description: 'Sacks and bags, for packaging of goods',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6306',
    description: 'Tarpaulins, awnings, sunblinds; tents; sails; camping goods',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6306',
    description: 'Tarpaulins, awnings, sunblinds; tents; sails; camping goods',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6307',
    description: 'Other made-up articles, including dress patterns',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6307',
    description: 'Other made-up articles, including dress patterns',
    fromDate: D_2022_01_01,
    toDate: null,
    ...r(6),
    notification: N_2021_TEXTILE,
  },
  {
    hsnPrefix: '6308',
    description: 'Sets consisting of woven fabric and yarn',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(6),
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '6309',
    description: 'Worn clothing and other worn articles',
    fromDate: D_2017_07_01,
    toDate: null,
    ...r(2.5),
    notification: N_2017_LAUNCH,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HSN 9988 — JOB-WORK SERVICES (used by F-11 karigar module)
  // ═══════════════════════════════════════════════════════════════════════════

  // 9988 — Manufacturing services on physical inputs owned by others (job-work)
  {
    hsnPrefix: '9988',
    description:
      'Job-work services (general) — manufacturing services on physical inputs owned by others',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017, Entry 26(id)',
  },

  // Job-work on textile (printing, dyeing, weaving) — reclassified Jan 2022
  {
    hsnPrefix: '9988',
    description: 'Job-work services on textile articles — printing, dyeing, embroidery, weaving',
    fromDate: D_2022_01_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: N_JOB_WORK_2022,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PETROLEUM — HSN 2710 (Mineral oils and their derivatives)
  // [LOW CONFIDENCE] — cess varies by product sub-type; verify before use
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '2710',
    description: 'Petroleum oils and oils from bituminous minerals (petrol, diesel, HSD, LDO)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 0,
    sgstRate: 0,
    igstRate: 0,
    cessRate: 0,
    notification:
      'Notification 1/2017-CT(Rate); petroleum products outside GST — state VAT + central excise applies. // [LOW CONFIDENCE]',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TOBACCO — HSN 2401-2403 (with cess)
  // [LOW CONFIDENCE] — cess rates change frequently; verify vs current notif
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '2401',
    description: 'Unmanufactured tobacco; tobacco refuse',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 65,
    notification:
      'Notification 1/2017-CT(Cess); Notification 1/2017-CT(Rate). // [LOW CONFIDENCE] cess % varies',
  },
  {
    hsnPrefix: '2402',
    description: 'Cigars, cheroots, cigarillos and cigarettes',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 5,
    notification:
      'Notification 1/2017-CT(Cess); specific cess varies by length. // [LOW CONFIDENCE]',
  },
  {
    hsnPrefix: '2403',
    description: 'Other manufactured tobacco; tobacco extracts and essences',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 12,
    notification: 'Notification 1/2017-CT(Cess); Notification 1/2017-CT(Rate). // [LOW CONFIDENCE]',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CEMENT — HSN 2523
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '2523',
    description: 'Portland cement, aluminous cement, slag cement, supersulphate cement etc.',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GOLD — HSN 7108
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '7108',
    description:
      'Gold (including gold plated with platinum) unwrought or in semi-manufactured forms',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 1.5,
    sgstRate: 1.5,
    igstRate: 3,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GEMS & JEWELLERY — HSN 7113-7117
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '7113',
    description: 'Articles of jewellery and parts thereof, of precious metal',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 1.5,
    sgstRate: 1.5,
    igstRate: 3,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '7114',
    description: 'Articles of goldsmiths or silversmiths wares and parts thereof',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 1.5,
    sgstRate: 1.5,
    igstRate: 3,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '7115',
    description: 'Other articles of precious metal or of metal clad with precious metal',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 1.5,
    sgstRate: 1.5,
    igstRate: 3,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '7116',
    description: 'Articles of natural or cultured pearls, precious or semi-precious stones',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 1.5,
    sgstRate: 1.5,
    igstRate: 3,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '7117',
    description: 'Imitation jewellery',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 1.5,
    sgstRate: 1.5,
    igstRate: 3,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AIR CONDITIONERS / FANS — HSN 8414, 8415
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '8414',
    description: 'Fans (industrial/domestic), air pumps, air or vacuum pumps, compressors',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '8415',
    description: 'Air conditioning machines',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PHARMACEUTICALS — HSN 3004
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '3004',
    description: 'Medicaments (excluding goods of 3002, 3005 or 3006) in measured doses',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DAIRY — HSN 0402 (Milk and cream, concentrated or with added sugar)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '0402',
    description: 'Milk and cream, concentrated or containing added sugar or sweetening matter',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 2/2017-CT(Rate) dated 28-06-2017 (reduced rate schedule)',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CEREALS — HSN 1001-1006 (wheat, rice, maize, barley, oats, other grain)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '1001',
    description: 'Wheat and meslin (branded packaged)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) — branded/packaged 5%; unbranded NIL',
  },
  {
    hsnPrefix: '1002',
    description: 'Rye (branded packaged)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate)',
  },
  {
    hsnPrefix: '1003',
    description: 'Barley (branded packaged)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate)',
  },
  {
    hsnPrefix: '1004',
    description: 'Oats (branded packaged)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate)',
  },
  {
    hsnPrefix: '1005',
    description: 'Maize (corn) (branded packaged)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate)',
  },
  {
    hsnPrefix: '1006',
    description: 'Rice (branded packaged)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate)',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PLASTICS — HSN 3923 (Articles for conveyance/packing of goods, of plastics)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    hsnPrefix: '3923',
    description: 'Articles for the conveyance or packing of goods, of plastics (bags, boxes etc)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ADDITIONAL COMMON HSNs — IT HARDWARE, SERVICES, CONSTRUCTION, FOOD
  // ═══════════════════════════════════════════════════════════════════════════

  // IT hardware (laptops, tablets, phones)
  {
    hsnPrefix: '8471',
    description: 'Automatic data processing machines (computers, laptops, tablets)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '8517',
    description: 'Telephone sets; mobile phones; routers; networking equipment',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '8443',
    description: 'Printing machinery; printers, photocopiers, fax machines',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // Office furniture & stationery
  {
    hsnPrefix: '9403',
    description: 'Other furniture and parts thereof (office furniture, racks, shelving)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '4802',
    description: 'Paper and paperboard (uncoated) for writing and printing',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '4820',
    description: 'Registers, account books, notebooks, exercise books, diaries, blotters',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // Chemicals & cleaning
  {
    hsnPrefix: '3402',
    description: 'Organic surface-active agents; washing preparations, surface-active preparations',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '3808',
    description: 'Insecticides, rodenticides, fungicides, herbicides; disinfectants',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // Packaging materials
  {
    hsnPrefix: '4819',
    description: 'Cartons, boxes and cases of corrugated paper or paperboard',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '3920',
    description: 'Other plates, sheets, film, foil and strip, of plastics',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // Construction materials
  {
    hsnPrefix: '6810',
    description: 'Articles of cement, concrete or artificial stone (bricks, blocks, tiles, slabs)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '7214',
    description: 'Other bars and rods of iron or non-alloy steel (TMT bars)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '7208',
    description: 'Flat-rolled products of iron or non-alloy steel, width >= 600 mm, hot-rolled',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // Transport
  {
    hsnPrefix: '8703',
    description: 'Motor cars and other motor vehicles (passenger vehicles)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 17,
    notification:
      'Notification 1/2017-CT(Rate) + Notification 1/2017-CT(Cess). // [LOW CONFIDENCE] cess varies by segment',
  },
  {
    hsnPrefix: '8704',
    description: 'Motor vehicles for transport of goods (commercial vehicles)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
  {
    hsnPrefix: '8708',
    description: 'Parts and accessories for motor vehicles of headings 8701 to 8705',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 14,
    sgstRate: 14,
    igstRate: 28,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // SAC codes — Services
  // 9954 — Construction services
  {
    hsnPrefix: '9954',
    description: 'Construction services (works contract — composite supply)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9961 — Services in wholesale trade
  {
    hsnPrefix: '9961',
    description: 'Services in wholesale trade (commission agent, trading)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9962 — Services in retail trade
  {
    hsnPrefix: '9962',
    description: 'Services in retail trade',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9965 — Goods transport services
  {
    hsnPrefix: '9965',
    description: 'Goods transport services',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9966 — Passenger transport services
  {
    hsnPrefix: '9966',
    description: 'Passenger transport services',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9971 — Financial and related services
  {
    hsnPrefix: '9971',
    description: 'Financial and related services (banking charges, loan processing fees etc.)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9972 — Real estate services
  {
    hsnPrefix: '9972',
    description: 'Real estate services (renting of commercial property)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9973 — Leasing or rental services without operator
  {
    hsnPrefix: '9973',
    description: 'Leasing or rental services without operator (machinery & equipment hire)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9983 — Other professional, technical and business services
  {
    hsnPrefix: '9983',
    description: 'Other professional, technical and business services (consulting, IT services)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9984 — Telecommunications services
  {
    hsnPrefix: '9984',
    description: 'Telecommunications, broadcasting and information supply services',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9985 — Support services
  {
    hsnPrefix: '9985',
    description: 'Support services (security, cleaning, HR staffing, payroll processing)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9992 — Education services
  {
    hsnPrefix: '9992',
    description: 'Education services (private coaching/tutorials)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9993 — Human health and social care services
  {
    hsnPrefix: '9993',
    description: 'Human health and social care services (hospitals, diagnostic labs)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 0,
    sgstRate: 0,
    igstRate: 0,
    cessRate: 0,
    notification: 'Notification 12/2017-CT(Rate) dated 28-06-2017 (exempted)',
  },

  // 9994 — Sewage and waste collection, treatment and disposal services
  {
    hsnPrefix: '9994',
    description: 'Sewage and waste collection, treatment and disposal services',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // 9997 — Other services — repair & maintenance
  {
    hsnPrefix: '9997',
    description: 'Other services (repairs and maintenance of machinery, computers, vehicles)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 11/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FOOD PROCESSING & SPICES — Common for SMB traders
  // ═══════════════════════════════════════════════════════════════════════════

  // 0901 — Coffee
  {
    hsnPrefix: '0901',
    description: 'Coffee, whether or not roasted or decaffeinated; coffee husks and skins',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 0902 — Tea
  {
    hsnPrefix: '0902',
    description: 'Tea, whether or not flavoured',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 1701 — Sugar
  {
    hsnPrefix: '1701',
    description: 'Cane or beet sugar and chemically pure sucrose in solid form',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 1901 — Food preparations of malt extract, flour
  {
    hsnPrefix: '1901',
    description: 'Malt extract; food preparations of flour, groats, meal, starch etc.',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 2106 — Food preparations NES
  {
    hsnPrefix: '2106',
    description: 'Food preparations not elsewhere specified or included',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 0904 — Pepper
  {
    hsnPrefix: '0904',
    description: 'Pepper of the genus Piper (dried/crushed spice)',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 0910 — Ginger, saffron, turmeric, thyme, bay leaves, curry
  {
    hsnPrefix: '0910',
    description: 'Ginger, saffron, turmeric (curcuma), thyme, bay leaves, curry and other spices',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EMBROIDERY THREAD / ACCESSORIES — Core to the embroidery factory segment
  // ═══════════════════════════════════════════════════════════════════════════

  // 5204 10 10 — Cotton embroidery thread (more specific than 5204 prefix)
  {
    hsnPrefix: '520410',
    description: 'Cotton sewing/embroidery thread, not put up for retail sale',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    cgstRate: 2.5,
    sgstRate: 2.5,
    igstRate: 5,
    cessRate: 0,
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '520410',
    description: 'Cotton sewing/embroidery thread, not put up for retail sale',
    fromDate: D_2022_01_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: N_2021_TEXTILE,
  },

  // 5402 31 — Textured polyester yarn (used in machine embroidery)
  {
    hsnPrefix: '540231',
    description: 'Textured polyester yarn, single, not for retail sale (embroidery thread)',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '540231',
    description: 'Textured polyester yarn, single, not for retail sale (embroidery thread)',
    fromDate: D_2022_01_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: N_2021_TEXTILE,
  },

  // 5810 10 — Embroidery (on a textile fabric ground, chemical lace type) — more specific
  {
    hsnPrefix: '581010',
    description: 'Embroidery on a textile fabric ground (machine embroidery, chemical lace)',
    fromDate: D_2017_07_01,
    toDate: D_2021_12_31,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: N_2017_LAUNCH,
  },
  {
    hsnPrefix: '581010',
    description: 'Embroidery on a textile fabric ground (machine embroidery, chemical lace)',
    fromDate: D_2022_01_01,
    toDate: null,
    cgstRate: 6,
    sgstRate: 6,
    igstRate: 12,
    cessRate: 0,
    notification: N_2021_TEXTILE,
  },

  // Embroidery frames, hoops (classified under 8448 — machine accessories)
  {
    hsnPrefix: '8448',
    description:
      'Auxiliary machinery for use with textile machines; parts/accessories of textile machines',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DYES & CHEMICALS FOR TEXTILE PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  // 3204 — Synthetic organic colouring matter (textile dyes)
  {
    hsnPrefix: '3204',
    description:
      'Synthetic organic colouring matter; synthetic luminescent brighteners; mordants; lakes',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 3206 — Other colouring matter; inorganic pigments
  {
    hsnPrefix: '3206',
    description: 'Other colouring matter; preparations as specified in Note 3 to Chapter 32',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // 3212 — Pigments (including metallic powders) dispersed in non-aqueous media
  {
    hsnPrefix: '3212',
    description: 'Pigments dispersed in non-aqueous media, used in textile printing pastes',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },

  // Sizing agents & textile auxiliaries
  {
    hsnPrefix: '3809',
    description: 'Finishing agents, dye carriers, fixing agents, mordants used in textile industry',
    fromDate: D_2017_07_01,
    toDate: null,
    cgstRate: 9,
    sgstRate: 9,
    igstRate: 18,
    cessRate: 0,
    notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// GST 2.0 LAYER - effective 22-09-2025 (56th GST Council, 03-04 Sep 2025)
// Notification 9/2025-CT(Rate) dated 17-09-2025 collapsed the 4-slab structure
// to two main slabs (5% merit / 18% standard) plus a 40% de-merit slab.
// Textile headline changes encoded here:
//   - MMF fibres: 18% -> 5%  (full inverted-duty-structure correction)
//   - MMF yarns:  12% -> 5%
//   - Sewing machines + parts (HS 8452): 12% -> 5%
// The apparel value-slab (5% up to Rs 2500/piece, 18% above) is value-dependent
// and is resolved at line entry (see the rate-default service), not by HSN
// prefix alone, so it is not encoded as a fixed seed row.
// [VERIFY-PRIMARY] confirm the exact notification number and per-HSN entries
// against the live CBIC PDF before production sign-off.
// ═══════════════════════════════════════════════════════════════════════════

const D_2025_09_22 = new Date('2025-09-22T00:00:00.000Z');
const D_2025_09_21 = new Date('2025-09-21T23:59:59.000Z');
const N_2025_GST2 =
  'Notification 9/2025-CT(Rate) dated 17-09-2025 (GST 2.0, effective 22-09-2025; 56th GST Council). // [VERIFY-PRIMARY]';

// MMF fibre + yarn prefixes (Chapters 54-55) that move to the 5% slab.
const GST2_MMF_TO_5: string[] = [
  // Chapter 54 - man-made filaments (sewing thread, filament yarn, monofilament)
  '5401',
  '5402',
  '5403',
  '5404',
  '5405',
  '5406',
  // Chapter 55 - man-made staple fibres + their yarns
  '5501',
  '5502',
  '5503',
  '5504',
  '5505',
  '5506',
  '5507',
  '5508',
  '5509',
  '5510',
  '5511',
];

/**
 * Apply the GST 2.0 layer in place: for each affected prefix, close the
 * currently-open rate window at 2025-09-21 and append a successor effective
 * 2025-09-22. Runs once at module load, before any consumer reads the seed.
 */
(function applyGst2TextileLayer(): void {
  for (const prefix of GST2_MMF_TO_5) {
    const open = GST_RATE_HISTORY_SEED.find(
      (row) => row.hsnPrefix === prefix && (row.toDate === null || row.toDate === undefined),
    );
    if (!open) continue;
    const description = open.description ?? prefix;
    open.toDate = D_2025_09_21;
    GST_RATE_HISTORY_SEED.push({
      hsnPrefix: prefix,
      description,
      fromDate: D_2025_09_22,
      toDate: null,
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 5,
      cessRate: 0,
      notification: N_2025_GST2,
    });
  }

  // Sewing machines + parts (HS 8452) - not previously seeded. 12% until the
  // GST 2.0 cutover, then 5%.
  GST_RATE_HISTORY_SEED.push(
    {
      hsnPrefix: '8452',
      description: 'Sewing machines (domestic + industrial); needles, furniture, bases and parts',
      fromDate: D_2017_07_01,
      toDate: D_2025_09_21,
      cgstRate: 6,
      sgstRate: 6,
      igstRate: 12,
      cessRate: 0,
      notification: 'Notification 1/2017-CT(Rate) dated 28-06-2017 (12% pre-GST 2.0)',
    },
    {
      hsnPrefix: '8452',
      description: 'Sewing machines (domestic + industrial); needles, furniture, bases and parts',
      fromDate: D_2025_09_22,
      toDate: null,
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 5,
      cessRate: 0,
      notification: N_2025_GST2,
    },
  );
})();
