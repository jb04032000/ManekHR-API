// Textile-first HSN/SAC seed for the plain-language code finder (D18). Rates per the
// post-22-Sep-2025 regime (plan §2). en + gu synonyms so a Surat trader can type "taka",
// "than", "rangai", "dalali", etc. Apparel (Ch 61-63) is value-thresholded (<=Rs2500/pc
// 5%, else 18%): we store the common 5% and note the threshold in the description; the
// per-SKU override (D5) handles the rest. Dyeing/printing job work is 18% (open item §9.1
// - CA confirmation recommended). Admin panel (D15) can extend this set.

export interface HsnSeed {
  code: string;
  type: 'hsn' | 'sac';
  description: string;
  synonyms: string[];
  gstRate: number;
  chapter?: string;
}

export const HSN_SEEDS: HsnSeed[] = [
  // Ch 50-52 silk / cotton
  {
    code: '5007',
    type: 'hsn',
    description: 'Woven fabrics of silk (incl. silk saree)',
    synonyms: ['silk fabric', 'silk saree', 'reshmi', 'pure silk', 'રેશમ', 'સિલ્ક સાડી'],
    gstRate: 5,
    chapter: '50',
  },
  {
    code: '5201',
    type: 'hsn',
    description: 'Raw cotton (5% under RCM when bought from an agriculturist)',
    synonyms: ['raw cotton', 'kapas', 'cotton', 'કપાસ', 'રૂ'],
    gstRate: 5,
    chapter: '52',
  },
  {
    code: '5205',
    type: 'hsn',
    description: 'Cotton yarn (>= 85% cotton)',
    synonyms: ['cotton yarn', 'suti dhaago', 'yarn', 'દોરા', 'સુતરાઉ દોરા'],
    gstRate: 5,
    chapter: '52',
  },
  {
    code: '5208',
    type: 'hsn',
    description: 'Woven fabrics of cotton (grey / finished)',
    synonyms: [
      'cotton fabric',
      'grey fabric',
      'grey cloth',
      'suti kapad',
      'taka',
      'than',
      'કાપડ',
      'સુતરાઉ કાપડ',
      'ગ્રે કાપડ',
    ],
    gstRate: 5,
    chapter: '52',
  },
  // Ch 54-55 man-made fibre
  {
    code: '5402',
    type: 'hsn',
    description: 'Synthetic filament yarn (POY / FDY / texturised)',
    synonyms: [
      'polyester yarn',
      'poy',
      'fdy',
      'filament yarn',
      'synthetic yarn',
      'dhaago',
      'દોરા',
      'પોલિએસ્ટર દોરા',
    ],
    gstRate: 5,
    chapter: '54',
  },
  {
    code: '5407',
    type: 'hsn',
    description: 'Woven fabrics of synthetic filament yarn',
    synonyms: [
      'synthetic fabric',
      'polyester fabric',
      'grey fabric',
      'grey cloth',
      'taka',
      'than',
      'સિન્થેટિક કાપડ',
      'ગ્રે કાપડ',
    ],
    gstRate: 5,
    chapter: '54',
  },
  {
    code: '5509',
    type: 'hsn',
    description: 'Yarn of synthetic staple fibres',
    synonyms: ['spun yarn', 'staple yarn', 'yarn', 'dhaago'],
    gstRate: 5,
    chapter: '55',
  },
  {
    code: '5512',
    type: 'hsn',
    description: 'Woven fabrics of synthetic staple fibres',
    synonyms: ['staple fabric', 'fabric', 'kapad', 'taka', 'than'],
    gstRate: 5,
    chapter: '55',
  },
  // Ch 56 / 58 zari, embroidery, pile
  {
    code: '5605',
    type: 'hsn',
    description: 'Metallised yarn / zari (incl. imitation zari)',
    synonyms: ['zari', 'jari', 'imitation zari', 'metallic yarn', 'જરી', 'ઝરી'],
    gstRate: 5,
    chapter: '56',
  },
  {
    code: '5810',
    type: 'hsn',
    description: 'Embroidery in the piece, strips or motifs',
    synonyms: ['embroidery', 'bharatkaam', 'kasab', 'embroidered fabric', 'ભરતકામ'],
    gstRate: 5,
    chapter: '58',
  },
  {
    code: '5801',
    type: 'hsn',
    description: 'Woven pile fabrics (velvet, corduroy)',
    synonyms: ['velvet', 'corduroy', 'pile fabric'],
    gstRate: 5,
    chapter: '58',
  },
  // Ch 60 knitted fabric
  {
    code: '6004',
    type: 'hsn',
    description: 'Knitted or crocheted fabrics',
    synonyms: ['knitted fabric', 'hosiery fabric', 'knit', 'kapad'],
    gstRate: 5,
    chapter: '60',
  },
  // Ch 61-62 apparel (<=Rs2500/pc: 5%; >Rs2500: 18%)
  {
    code: '6109',
    type: 'hsn',
    description: 'T-shirts, singlets, knitted (<=Rs2500/pc 5%; >Rs2500 18%)',
    synonyms: ['t-shirt', 'tshirt', 'readymade', 'garment', 'kapda', 'ટી-શર્ટ', 'કપડાં'],
    gstRate: 5,
    chapter: '61',
  },
  {
    code: '6110',
    type: 'hsn',
    description: 'Sweaters, pullovers, knitted (<=Rs2500/pc 5%; >Rs2500 18%)',
    synonyms: ['sweater', 'pullover', 'jersey', 'garment'],
    gstRate: 5,
    chapter: '61',
  },
  {
    code: '6203',
    type: 'hsn',
    description: "Men's suits/trousers/shirts, woven (<=Rs2500/pc 5%; >Rs2500 18%)",
    synonyms: [
      'shirt',
      'trouser',
      'pant',
      'suit',
      'kurta',
      'readymade',
      'garment',
      'શર્ટ',
      'કપડાં',
    ],
    gstRate: 5,
    chapter: '62',
  },
  {
    code: '6204',
    type: 'hsn',
    description: "Women's dresses/suits/stitched sarees, woven (<=Rs2500/pc 5%; >Rs2500 18%)",
    synonyms: ['dress', 'kurti', 'salwar', 'ladies garment', 'stitched saree', 'ડ્રેસ', 'કુર્તી'],
    gstRate: 5,
    chapter: '62',
  },
  // Ch 63 made-ups
  {
    code: '6302',
    type: 'hsn',
    description: 'Bed/table linen, made-ups (<=Rs2500/pc 5%; >Rs2500 18%)',
    synonyms: ['bedsheet', 'bed linen', 'table cloth', 'chadar', 'ચાદર'],
    gstRate: 5,
    chapter: '63',
  },
  {
    code: '6303',
    type: 'hsn',
    description: 'Curtains and interior blinds (<=Rs2500/pc 5%; >Rs2500 18%)',
    synonyms: ['curtain', 'blind', 'parda', 'પડદો'],
    gstRate: 5,
    chapter: '63',
  },
  // SAC services
  {
    code: '998821',
    type: 'sac',
    description:
      'Textile manufacturing services (job work) for a registered principal - 5% with ITC',
    synonyms: [
      'job work',
      'jobwork',
      'job-work',
      'processing',
      'textile job work',
      'karigari',
      'જોબ વર્ક',
      'કારીગરી',
    ],
    gstRate: 5,
    chapter: '99',
  },
  {
    code: '998822',
    type: 'sac',
    description: 'Wearing apparel manufacturing services (job work) - stitching',
    synonyms: ['garment job work', 'stitching', 'tailoring service', 'silai', 'સિલાઈ'],
    gstRate: 5,
    chapter: '99',
  },
  {
    code: '9988',
    type: 'sac',
    description: 'Dyeing & printing job work on textiles - 18% (CA confirmation recommended)',
    synonyms: [
      'dyeing',
      'printing',
      'dyeing job work',
      'printing job work',
      'rangai',
      'chhpai',
      'રંગાઈ',
      'છપાઈ',
    ],
    gstRate: 18,
    chapter: '99',
  },
  {
    code: '996111',
    type: 'sac',
    description: 'Commission agent / brokerage services (dalali)',
    synonyms: ['commission', 'brokerage', 'dalali', 'broker', 'agent', 'દલાલી', 'કમિશન'],
    gstRate: 18,
    chapter: '99',
  },
  {
    code: '996511',
    type: 'sac',
    description: 'Road transport of goods (GTA / freight)',
    synonyms: ['freight', 'transport', 'gta', 'lorry', 'bhada', 'ભાડું', 'ટ્રાન્સપોર્ટ'],
    gstRate: 5,
    chapter: '99',
  },
];

// Pure, ranked plain-language search over code + synonyms + description. Generic so it
// runs over both the seed array (tests) and cached HsnCode docs (service). Ranking:
// code prefix > synonym exact > synonym prefix > synonym contains > description contains.
export function matchHsn<T extends { code: string; description: string; synonyms: string[] }>(
  items: T[],
  query: string,
  limit = 10,
): T[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [];
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const code = item.code.toLowerCase();
    const desc = item.description.toLowerCase();
    const syns = item.synonyms.map((s) => s.toLowerCase());
    let score = 0;
    if (code.startsWith(q)) score = 100;
    else if (code.includes(q)) score = 80;
    else if (syns.some((s) => s === q)) score = 90;
    else if (syns.some((s) => s.startsWith(q))) score = 70;
    else if (syns.some((s) => s.includes(q))) score = 50;
    else if (desc.includes(q)) score = 40;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.code.localeCompare(b.item.code));
  return scored.slice(0, limit).map((x) => x.item);
}
