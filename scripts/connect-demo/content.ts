/**
 * connect-demo/content.ts — the demo "world".
 *
 * A hand-written cast of Surat / Gujarat textile-trade personas and the things
 * they post, sell, hire for and ask about. Everything here is plain data so the
 * seed script and the auto-poster can both draw from it. Copy mixes English,
 * Hinglish and Latin-script Gujarati the way the trade actually talks.
 *
 * Personas cover every account type the platform supports:
 *   karigar (worker) · workshop_owner · trader/wholesaler · buyer · recruiter ·
 *   explorer — plus a deliberately near-empty "day 1" karigar so the empty
 *   states stay demoable.
 *
 * Money convention (mirrors the original seed):
 *   • rateCard fields (dailyWage / pieceRate / monthly) are in PAISE.
 *   • listing prices, job wages and RFQ budgets are plain RUPEES.
 */

export type PersonaType =
  | 'karigar'
  | 'workshop_owner'
  | 'trader'
  | 'buyer'
  | 'recruiter'
  | 'explorer';

/** Stored onboarding intent enum (only these four are valid on the schema). */
export type OnboardingIntent = 'workshop_owner' | 'karigar' | 'buyer' | 'explorer';

export interface Persona {
  key: string; // stable id used to wire relationships in the seed
  name: string;
  mobile: string; // unique; demo block 91000000xx
  type: PersonaType;
  intent: OnboardingIntent;
  headline: string;
  bio: string;
  city: string;
  district: string;
  state: string;
  skills: string[];
  contactPreference: 'whatsapp' | 'phone' | 'dm';
  openTo: { work?: boolean; hiring?: boolean; deals?: boolean; customOrders?: boolean };
  /** PAISE. Omitted for non-workers. */
  rateCard?: { dailyWage?: number; pieceRate?: number; monthly?: number };
  experience?: Array<{
    workshop: string;
    role: string;
    fromYear: number;
    toYear?: number;
    description?: string;
    /**
     * Optional link to a COMPANY_PAGES key — resolved to the real CompanyPage id
     * in a seed post-pass (pages are created after profiles). A CURRENT entry
     * (no toYear) with this set gives the institute Placements tab a named
     * employer card instead of the anonymous "other workplaces" count.
     */
    companyPageKey?: string;
  }>;
  /**
   * Training credentials at a seeded institute page (COMPANY_PAGES key with
   * kind: 'institute'). Seeded as CONFIRMED + shareWithInstitute so the
   * institute's public Placements / Alumni tabs demo with content. Omitted
   * completedYear = course still ongoing.
   */
  training?: Array<{ instituteKey: string; course: string; completedYear?: number }>;
  services?: Array<{ title: string; note?: string }>;
  /** A near-empty profile that drives the 0%-strength / empty-state demo. */
  sparse?: boolean;
  /** Owns a workspace → derived ERP-linked badge lights up. */
  erpLinked?: boolean;
}

export const PERSONAS: Persona[] = [
  // ── Workers (karigar) ──────────────────────────────────────────────────
  {
    key: 'meera',
    name: 'Meera Sharma',
    mobile: '9100000001',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Master zari karigar · 14 years · Multi-head machine',
    bio: '14 saal se hand aur machine zari embroidery kar rahi hoon — zyada tar bridal lehenga aur festive wear. Chhoti team lead karti hoon, clean aur on-time finishing pe pura dhyan. Job-work aur custom bridal orders ke liye available.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Zari', 'Zardozi', 'Sequins', 'Aari', 'Hand embroidery'],
    contactPreference: 'whatsapp',
    openTo: { work: true, customOrders: true },
    rateCard: { dailyWage: 95000, pieceRate: 280000 },
    experience: [
      {
        workshop: 'Surat Embroidery Works',
        role: 'Senior karigar',
        fromYear: 2016,
        description: 'Lead karigar on bridal orders.',
      },
      { workshop: 'Anand Zari House', role: 'Karigar', fromYear: 2011, toYear: 2016 },
    ],
    services: [
      { title: 'Bridal lehenga zardozi', note: 'Hand + machine, premium finishing' },
      { title: 'Saree pallu zari work', note: 'Bulk job-work welcome' },
    ],
  },
  {
    key: 'anand',
    name: 'Anand Patel',
    mobile: '9100000002',
    type: 'karigar',
    intent: 'karigar',
    headline: '',
    bio: '',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: [],
    contactPreference: 'whatsapp',
    openTo: { work: true },
    sparse: true, // day-1 profile → empty states + 0% strength
  },
  {
    key: 'imran',
    name: 'Imran Shaikh',
    mobile: '9100000004',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Aari & zardozi specialist · 9 years · Fine hand work',
    bio: 'Specialist in aari and zardozi hand embroidery. I work on bridal blouses, dupattas and high-end occasion wear. Small batches, fine finishing, no shortcuts. Available for custom and job-work.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Aari', 'Zardozi', 'Dabka', 'Moti work', 'Hand embroidery'],
    contactPreference: 'whatsapp',
    openTo: { work: true, customOrders: true },
    rateCard: { dailyWage: 90000, pieceRate: 350000 },
    experience: [
      {
        workshop: 'Heritage Aari Studio',
        role: 'Aari karigar',
        fromYear: 2017,
        description: 'Bridal blouse and dupatta hand work.',
      },
    ],
    services: [{ title: 'Aari blouse work', note: 'Per-piece, fine finishing' }],
  },
  {
    key: 'lakshmi',
    name: 'Lakshmi Devi',
    mobile: '9100000005',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Sequins & moti hand work · Women’s karigar group lead',
    bio: 'હું આઠ બહેનોના group ને lead કરું છું — ઘરેથી sequins, moti અને thread નું હાથભરત. Festive અને dress-material કામ contract પર લઈએ. ભરોસાપાત્ર, ચોખ્ખું, અને હંમેશા સમયસર delivery.',
    city: 'Navsari',
    district: 'Navsari',
    state: 'Gujarat',
    skills: ['Sequins', 'Moti work', 'Thread work', 'Hand embroidery'],
    contactPreference: 'phone',
    openTo: { work: true, customOrders: true },
    rateCard: { pieceRate: 120000 },
    experience: [
      {
        workshop: 'Self-help karigar group',
        role: 'Group lead',
        fromYear: 2014,
        description: '8-women home embroidery contract group.',
      },
    ],
    services: [{ title: 'Contract hand embroidery', note: 'Dress material & festive, batch work' }],
  },
  {
    key: 'suresh',
    name: 'Suresh Vaghela',
    mobile: '9100000006',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Multi-needle machine operator · 3 years · Looking for work',
    bio: 'Multi-needle embroidery machine operator, 3 saal ka experience Barudan aur Tajima heads pe. Bulk saree aur dress-material runs comfortable. Surat me steady workshop dhoond raha hoon.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Multi-head machine', 'Barudan', 'Tajima', 'Bulk embroidery'],
    contactPreference: 'whatsapp',
    openTo: { work: true },
    rateCard: { dailyWage: 70000 },
    experience: [
      {
        workshop: 'Shree Embroidery',
        role: 'Machine operator',
        fromYear: 2022,
        description: 'Bulk saree and dress-material embroidery.',
      },
    ],
    // Placed Zariya alumnus — free-text employer, so counts in "other workplaces".
    training: [
      {
        instituteKey: 'zariya',
        course: 'Machine operator course (Barudan / Tajima)',
        completedYear: 2022,
      },
    ],
  },

  // ── Workshop owners ────────────────────────────────────────────────────
  {
    key: 'rajesh',
    name: 'Rajesh Mehta',
    mobile: '9100000003',
    type: 'workshop_owner',
    intent: 'workshop_owner',
    headline: 'Embroidery workshop owner · Mehta Embroidery Works',
    bio: 'We run a 20-machine embroidery workshop in Varachha, Surat. We take bulk and custom orders for sarees, lehengas and dress material, and we are always looking for skilled karigars.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Bulk embroidery', 'Custom orders', 'Multi-head machine', 'Job work'],
    contactPreference: 'phone',
    openTo: { hiring: true, deals: true, customOrders: true },
    erpLinked: true,
    experience: [
      {
        workshop: 'Mehta Embroidery Works',
        role: 'Owner',
        fromYear: 2009,
        description: 'Founded and run the workshop.',
      },
    ],
  },
  {
    key: 'bhavna',
    name: 'Bhavna Desai',
    mobile: '9100000007',
    type: 'workshop_owner',
    intent: 'workshop_owner',
    headline: 'Owner · Devi Creations · Women-led embroidery unit',
    bio: 'Devi Creations is a women-led embroidery unit in Sachin, Surat. 12 machines, focus on dress-material and kurti embroidery. We train and employ women karigars from nearby villages.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Dress material', 'Kurti embroidery', 'Schiffli', 'Job work'],
    contactPreference: 'whatsapp',
    openTo: { hiring: true, deals: true, customOrders: true },
    experience: [
      {
        workshop: 'Devi Creations',
        role: 'Founder',
        fromYear: 2015,
        description: 'Women-led embroidery unit, 12 machines.',
      },
    ],
  },
  {
    key: 'yusuf',
    name: 'Yusuf Memon',
    mobile: '9100000008',
    type: 'workshop_owner',
    intent: 'workshop_owner',
    headline: 'Owner · Memon Zari House · Job-work specialist',
    bio: 'Three generations in zari job-work. We do per-metre multi-head embroidery on your fabric — sarees, lehengas, dupattas. Fast turnaround, fair rates, and we never compromise on thread quality.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Zari job-work', 'Multi-head machine', 'Per-metre embroidery', 'Bulk capacity'],
    contactPreference: 'phone',
    openTo: { hiring: true, deals: true, customOrders: true },
    experience: [
      {
        workshop: 'Memon Zari House',
        role: 'Owner',
        fromYear: 2006,
        description: 'Family job-work unit, third generation.',
      },
    ],
  },

  // ── Traders / wholesalers ──────────────────────────────────────────────
  {
    key: 'kiran',
    name: 'Kiran Shah',
    mobile: '9100000009',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Saree wholesaler · Kiran Textiles · Surat textile market',
    bio: 'Wholesale sarees and dress material from Surat to all India. Office in Ring Road textile market. We carry georgette, organza and silk-blend ranges and ship daily by transport.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Wholesale sarees', 'Dress material', 'All-India dispatch', 'Trading'],
    contactPreference: 'phone',
    openTo: { deals: true },
    experience: [
      {
        workshop: 'Kiran Textiles',
        role: 'Proprietor',
        fromYear: 2012,
        description: 'Wholesale saree trading, Ring Road market.',
      },
    ],
  },
  {
    key: 'haresh',
    name: 'Haresh Ramani',
    mobile: '9100000010',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Grey & finished fabric trader · Hari Om Fabrics',
    bio: 'We supply grey and finished fabric — georgette, crepe, satin — to embroidery units and garment makers across Surat and Ahmedabad. Container lots and small lots both welcome.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Grey fabric', 'Finished fabric', 'Georgette', 'Crepe', 'Wholesale'],
    contactPreference: 'phone',
    openTo: { deals: true },
    experience: [
      {
        workshop: 'Hari Om Fabrics',
        role: 'Partner',
        fromYear: 2010,
        description: 'Grey and finished fabric supply.',
      },
    ],
  },

  // ── Buyers ─────────────────────────────────────────────────────────────
  {
    key: 'priya',
    name: 'Priya Nair',
    mobile: '9100000011',
    type: 'buyer',
    intent: 'buyer',
    headline: 'Boutique owner · Bengaluru · Sources bridal & festive wear',
    bio: 'I run a bridal boutique in Bengaluru and source custom lehengas, blouses and festive sarees from Surat workshops. Looking for reliable embroidery partners for small premium batches.',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    state: 'Karnataka',
    skills: ['Bridal sourcing', 'Boutique', 'Custom orders'],
    contactPreference: 'dm',
    openTo: { deals: true },
  },
  {
    key: 'anjali',
    name: 'Anjali Verma',
    mobile: '9100000012',
    type: 'buyer',
    intent: 'buyer',
    headline: 'Designer · Anjali Label · Ahmedabad',
    bio: 'Independent designer working on contemporary Indian wear. I post RFQs for embroidery and job-work and like to compare quotes before placing. Quality and timelines matter more than lowest price.',
    city: 'Ahmedabad',
    district: 'Ahmedabad',
    state: 'Gujarat',
    skills: ['Fashion design', 'Sourcing', 'Indian wear'],
    contactPreference: 'dm',
    openTo: { deals: true },
  },

  // ── Recruiter ──────────────────────────────────────────────────────────
  {
    key: 'sunita',
    name: 'Sunita Rao',
    mobile: '9100000013',
    type: 'recruiter',
    intent: 'workshop_owner',
    headline: 'Staffing partner · Sunita Staffing · Embroidery & textile labour',
    bio: 'I connect skilled karigars and machine operators with Surat embroidery units. If you are a workshop short on hands, or a karigar looking for steady work, message me — I place people every week.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Staffing', 'Recruitment', 'Karigar placement', 'Textile labour'],
    contactPreference: 'whatsapp',
    openTo: { hiring: true },
    experience: [
      {
        workshop: 'Sunita Staffing',
        role: 'Founder',
        fromYear: 2018,
        description: 'Textile and embroidery labour placement.',
      },
    ],
  },

  // ── Explorer ───────────────────────────────────────────────────────────
  {
    key: 'vikram',
    name: 'Vikram Joshi',
    mobile: '9100000014',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Textile design student · NIFT · Exploring the trade',
    bio: 'Final-year textile design student. Here to learn how the Surat embroidery trade works, follow workshops I admire, and maybe find an internship. I post about design trends I am studying.',
    city: 'Gandhinagar',
    district: 'Gandhinagar',
    state: 'Gujarat',
    skills: ['Textile design', 'Surface ornamentation', 'CAD'],
    contactPreference: 'dm',
    openTo: { work: true },
  },

  // ── Specialist embroidery roles (Surat trade) ──────────────────────────
  {
    key: 'firoz',
    name: 'Firoz Khan',
    mobile: '9100000015',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Embroidery digitizer / punching designer · Wilcom · 7 years',
    bio: 'I convert artwork and sketches into machine embroidery files (punching) on Wilcom. Clean fills, minimal jump stitches, sequin and zari sequences planned for fast runs. Freelance digitizing for Surat job-work units.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Wilcom', 'Punching', 'Digitizing', 'Sequence design', 'Sequins'],
    contactPreference: 'whatsapp',
    openTo: { work: true, customOrders: true },
    rateCard: { monthly: 2600000, pieceRate: 60000 },
    experience: [
      {
        workshop: 'Freelance digitizing',
        role: 'Punching designer',
        fromYear: 2019,
        description: 'Artwork-to-machine files for embroidery units.',
      },
    ],
    // Placed Zariya alumnus — freelance, counts in "other workplaces".
    training: [
      { instituteKey: 'zariya', course: 'Punching / digitizing (Wilcom)', completedYear: 2019 },
    ],
    services: [{ title: 'Embroidery punching (Wilcom)', note: 'Per design, fast turnaround' }],
  },
  {
    key: 'hasmukh',
    name: 'Hasmukh Prajapati',
    mobile: '9100000016',
    type: 'recruiter',
    intent: 'workshop_owner',
    headline: 'Job-work thekedar · supplies karigars to Surat units',
    bio: 'Main thekedar (job-work contractor) hoon. Bulk embroidery job-work apne karigar groups se karwata hoon, aur jahan haath kam pade wahan trained karigar aur operator supply karta hoon. Varachha-Sachin belt me 18 saal.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Thekedar', 'Karigar supply', 'Job-work coordination', 'Labour contracting'],
    contactPreference: 'phone',
    openTo: { hiring: true, deals: true },
    experience: [
      {
        workshop: 'Prajapati job-work',
        role: 'Thekedar',
        fromYear: 2008,
        description: 'Job-work distribution and karigar supply.',
      },
    ],
  },
  {
    key: 'jigna',
    name: 'Jignaben Chauhan',
    mobile: '9100000017',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Adda hand-work karigar · zardozi & dabka · women-run group',
    bio: 'અમે adda હાથકામ કરીએ છીએ — zardozi, dabka, moti અને sitara, લાકડાના frame પર. Bridal blouse, pallu અને yoke નું કામ. છ બહેનોની ટીમ, ચોખ્ખું કામ અને સમયસર. Adda કામ આવકાર્ય છે.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Adda work', 'Zardozi', 'Dabka', 'Moti work', 'Sitara'],
    contactPreference: 'whatsapp',
    openTo: { work: true, customOrders: true },
    rateCard: { pieceRate: 200000 },
    experience: [
      {
        workshop: 'Adda karigar group',
        role: 'Group lead',
        fromYear: 2013,
        description: 'Adda-frame hand embroidery, 6-women group.',
      },
    ],
    services: [{ title: 'Adda hand embroidery', note: 'Zardozi / dabka on the frame' }],
  },
  {
    key: 'ramesh',
    name: 'Ramesh Solanki',
    mobile: '9100000018',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Checking & finishing master · 11 years · quality control',
    bio: 'Final checking and finishing — thread cutting, defect catching, pressing and packing before dispatch. A good checker saves a workshop from returns. Available for steady work or per-piece finishing.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Checking', 'Finishing', 'Quality control', 'Thread cutting', 'Pressing'],
    contactPreference: 'phone',
    openTo: { work: true },
    rateCard: { dailyWage: 65000 },
    experience: [
      {
        workshop: 'Surat embroidery units',
        role: 'Checking & finishing',
        fromYear: 2015,
        description: 'Final QC and finishing before dispatch.',
      },
    ],
  },

  // ── Raw material & process (upstream) ──────────────────────────────────
  {
    key: 'dilip',
    name: 'Dilip Patel',
    mobile: '9100000019',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Yarn & grey fabric supplier · Ring Road · daily lots',
    bio: 'I supply grey georgette, chiffon and embroidery-base yarn to Surat units — Ring Road godown, daily lots, container and small quantity both. Steady rates and credit terms for regulars.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Grey fabric', 'Yarn supply', 'Georgette base', 'Wholesale'],
    contactPreference: 'phone',
    openTo: { deals: true },
    services: [{ title: 'Grey & yarn supply', note: 'Daily lots, container or small qty' }],
  },
  {
    key: 'naran',
    name: 'Naran Mistry',
    mobile: '9100000020',
    type: 'workshop_owner',
    intent: 'workshop_owner',
    headline: 'Owner · Shree Naran Process House · dyeing & digital print',
    bio: 'Dyeing and digital printing process house in Pandesara, Surat. 8000 m/day capacity, colour matching and job-work printing for traders and embroidery units. Consistent shades, on-time.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Dyeing', 'Digital printing', 'Colour matching', 'Job-work processing'],
    contactPreference: 'phone',
    openTo: { deals: true, hiring: true },
    services: [{ title: 'Dyeing + digital print', note: 'Job-work, 8000 m/day' }],
  },

  // ── Professional & allied services ─────────────────────────────────────
  {
    key: 'hetal',
    name: 'Hetal Mehta',
    mobile: '9100000021',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Chartered Accountant · GST, e-way bill & books for textile units',
    bio: 'Surat ના embroidery અને saree વેપાર સાથે કામ કરતી CA — GST return, e-way bill, TDS અને ચોખ્ખા હિસાબ, જેથી તમારું ITC ક્યારેય અટકે નહીં. સાદી ગુજરાતીમાં સમજાવું, કોઈ jargon નહીં. નાના unit માટે પહેલી review free.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['GST returns', 'Accounting', 'E-way bill', 'TDS', 'Bookkeeping'],
    contactPreference: 'dm',
    openTo: { deals: true },
    services: [
      { title: 'GST returns & filing', note: 'Monthly GSTR-1 / 3B, e-invoice' },
      { title: 'Bookkeeping for units', note: 'Tally / books, ITC reconciliation' },
    ],
  },
  {
    key: 'nilesh',
    name: 'Nilesh Shah',
    mobile: '9100000022',
    type: 'explorer',
    intent: 'explorer',
    headline: 'GST & e-invoice consultant · billing setup for traders',
    bio: 'I set up clean billing and e-invoicing for textile traders — GSTR filing, e-way bill, and getting your software, HSN codes and rates right so the festive rush stays smooth. Surat-based, on-call support.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['GST', 'E-invoice', 'Billing software', 'HSN codes', 'Compliance'],
    contactPreference: 'whatsapp',
    openTo: { deals: true },
    services: [{ title: 'Billing & e-invoice setup', note: 'For traders & units' }],
  },
  {
    key: 'mahesh',
    name: 'Mahesh Parmar',
    mobile: '9100000023',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Embroidery machine technician · Barudan/Tajima AMC & spares',
    bio: 'Multi-head embroidery machines ki service karta hoon — Barudan, Tajima, Ricoma. Head repair, hook timing, thread trimmer aur AMC, saath me genuine spare. Jaldi call-out, taaki season me aapka floor idle na rahe.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Machine repair', 'Barudan', 'Tajima', 'AMC', 'Spare parts'],
    contactPreference: 'phone',
    openTo: { work: true, deals: true },
    services: [
      { title: 'Machine AMC & service', note: 'Multi-head, call-out' },
      { title: 'Spare parts', note: 'Hooks, trimmers, needles' },
    ],
  },
  {
    key: 'alpa',
    name: 'Alpa Shah',
    mobile: '9100000024',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Catalogue photographer · Studio Rang · sarees & dress material',
    bio: 'I run Studio Rang — product photography and short reels for saree and dress-material catalogues. Soft daylight setup that brings out fabric fall and zari shine. WhatsApp-ready catalogue exports, quick turnaround.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Product photography', 'Catalogue shoots', 'Reels', 'Photo editing'],
    contactPreference: 'whatsapp',
    openTo: { deals: true, customOrders: true },
    services: [{ title: 'Catalogue shoot', note: 'Per-piece or per-day, sarees & suits' }],
  },
  {
    key: 'bharat',
    name: 'Bharat Patel',
    mobile: '9100000025',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Patel Transport · daily Surat → all-India parcel service',
    bio: 'Daily parcel and full-load transport from Surat to Bengaluru, Hyderabad, Delhi, Kolkata and more. Safe packing for saree cartons, doorstep pickup from textile markets, on-time delivery you can track.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Transport', 'Logistics', 'Parcel service', 'All-India delivery'],
    contactPreference: 'phone',
    openTo: { deals: true },
    services: [{ title: 'Parcel & transport', note: 'Surat to all India, daily' }],
  },
  {
    key: 'kruti',
    name: 'Kruti Shah',
    mobile: '9100000026',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Kruti Packaging · saree covers, boxes & poly bags',
    bio: 'We supply packaging to textile traders — printed saree covers, gift boxes, poly bags and tags. Custom shop-name branding on covers in small quantities too. Women-run unit, neat and reliable.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Packaging', 'Saree covers', 'Custom printing', 'Wholesale supply'],
    contactPreference: 'whatsapp',
    openTo: { deals: true },
    services: [{ title: 'Packaging supply', note: 'Covers, boxes, custom branding' }],
  },

  // ── Stitching / finishing services (women-led) ─────────────────────────
  {
    key: 'reena',
    name: 'Reena Chauhan',
    mobile: '9100000027',
    type: 'workshop_owner',
    intent: 'workshop_owner',
    headline: 'Reenaben Tailoring · blouse & pre-draped saree stitching',
    bio: 'બહેનો ચલાવતી stitching unit — designer blouse, ruffle-belt વાળી pre-draped સાડી અને matching falls. Boutique અને reseller માટે bulk stitching, ચોખ્ખું finishing, size પ્રમાણે fit. અમે સ્થાનિક બહેનોને તાલીમ આપીએ છીએ.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Blouse stitching', 'Pre-draped saree', 'Tailoring', 'Finishing'],
    contactPreference: 'whatsapp',
    openTo: { hiring: true, deals: true, customOrders: true },
    services: [
      { title: 'Blouse stitching', note: 'Designer, bulk for boutiques' },
      { title: 'Pre-draped saree', note: 'Ruffle / belt, matching blouse' },
    ],
  },
  {
    key: 'daxa',
    name: 'Daxaben Rana',
    mobile: '9100000028',
    type: 'karigar',
    intent: 'karigar',
    headline: 'Saree falls, pico & finishing · home-based women’s service',
    bio: 'સાડી પર falls, pico અને edge finishing — ઘરેથી બહેનોની નાની ટીમ સાથે. ચોખ્ખું invisible pico, colour-match falls, shop અને reseller માટે ઝડપી batch. Market વિસ્તારમાં pickup-drop પણ.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Falls', 'Pico', 'Saree finishing', 'Edge work'],
    contactPreference: 'phone',
    openTo: { work: true, customOrders: true },
    rateCard: { pieceRate: 4000 },
    services: [{ title: 'Falls & pico', note: 'Per saree, batch work' }],
  },

  // ── Trade & export (downstream) ────────────────────────────────────────
  {
    key: 'ashok',
    name: 'Ashok Jain',
    mobile: '9100000029',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Merchant exporter · Surat sarees & dress material to Gulf/US',
    bio: 'Merchant exporter handling embroidered sarees, dress material and ethnic wear to Gulf, US and UK buyers. I manage export documentation, GST/LUT and container consolidation for units that want to go overseas.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Export', 'Documentation', 'Container orders', 'Overseas buyers'],
    contactPreference: 'dm',
    openTo: { deals: true },
    services: [{ title: 'Export handling', note: 'Docs, LUT, container consolidation' }],
  },
  {
    key: 'neha',
    name: 'Neha Agarwal',
    mobile: '9100000030',
    type: 'buyer',
    intent: 'buyer',
    headline: 'Online saree reseller · Instagram & Meesho',
    bio: 'I resell Surat sarees and suits online — Instagram and Meesho — to customers across India. Always looking for reliable units with fresh designs, good catalogue photos and small-quantity dispatch.',
    city: 'Ahmedabad',
    district: 'Ahmedabad',
    state: 'Gujarat',
    skills: ['Online reselling', 'Social selling', 'Sourcing'],
    contactPreference: 'whatsapp',
    openTo: { deals: true },
  },

  // ── Embroidery materials / components supplier ─────────────────────────
  {
    key: 'rafiq',
    name: 'Rafiq Mansuri',
    mobile: '9100000031',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Zari & embroidery material supplier · kasab, cutdana, moti, sitara, gota',
    bio: 'Surat me embroidery material ka wholesaler — kasab/zari thread, cutdana, moti, sitara, sequins aur gota lace. Imported aur local stock, har season fresh shades. Karigar aur units ke liye bulk aur chhoti quantity dono.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Zari/kasab', 'Cutdana', 'Moti', 'Sitara', 'Gota lace'],
    contactPreference: 'whatsapp',
    openTo: { deals: true },
    services: [{ title: 'Embroidery material supply', note: 'Kasab, cutdana, moti, sitara, gota' }],
  },

  // ── Companies (larger brands / dealers with pages) ─────────────────────
  {
    key: 'manish',
    name: 'Manish Agrawal',
    mobile: '9100000032',
    type: 'workshop_owner',
    intent: 'workshop_owner',
    headline: 'Director · Vraj Creations · designer saree manufacturer',
    bio: 'Vraj Creations is a Surat designer-saree manufacturer with an in-house design team and embroidery unit. We produce festive and bridal ranges for wholesalers and exporters across India, and we hire designers, merchandisers and karigars year round.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Saree manufacturing', 'Designer sarees', 'In-house embroidery', 'Bulk production'],
    contactPreference: 'phone',
    openTo: { hiring: true, deals: true, customOrders: true },
    experience: [
      {
        workshop: 'Vraj Creations',
        role: 'Director',
        fromYear: 2012,
        description: 'Designer saree manufacturing house.',
      },
    ],
  },
  {
    key: 'paresh',
    name: 'Paresh Patel',
    mobile: '9100000033',
    type: 'trader',
    intent: 'workshop_owner',
    headline: 'Owner · Surat Embroidery Machines · Tajima & Barudan dealer',
    bio: 'Authorised dealer for multi-head embroidery machines — Tajima, Barudan and Ricoma — new and certified pre-owned. We sell, install, train operators and provide AMC and spares. Serving Surat and Gujarat embroidery units for 15 years.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Embroidery machines', 'Tajima', 'Barudan', 'Machine dealer', 'AMC'],
    contactPreference: 'phone',
    openTo: { deals: true },
    services: [{ title: 'Machine sales + install', note: 'New / pre-owned, with training' }],
  },

  // ── Coaching / training institutes ─────────────────────────────────────
  {
    key: 'anita',
    name: 'Anita Deshmukh',
    mobile: '9100000034',
    type: 'recruiter',
    intent: 'workshop_owner',
    headline: 'Director · Surat Institute of Fashion & Design',
    bio: 'We run diploma and certificate courses in fashion design, textile design and CAD, with sampling labs and industry projects. Strong placement support — our students intern and place with Surat manufacturers, exporters and boutiques.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Fashion design education', 'Textile design', 'CAD training', 'Placements'],
    contactPreference: 'dm',
    openTo: { hiring: true },
    services: [
      { title: 'Diploma in Fashion Design', note: 'Hands-on, industry projects' },
      { title: 'Textile design + CAD course', note: 'Photoshop / Illustrator / CorelDRAW' },
    ],
  },
  {
    key: 'rohit',
    name: 'Rohit Varma',
    mobile: '9100000035',
    type: 'recruiter',
    intent: 'workshop_owner',
    headline: 'Founder · Zariya Embroidery & CAD Academy · operator + punching training',
    bio: 'Vocational academy training computerized-embroidery machine operators and punching designers (Wilcom). Short, job-ready courses with placement into Surat units. We help karigars and youngsters move into better-paid machine and design roles.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Embroidery training', 'Wilcom', 'Punching', 'Machine operation', 'Placements'],
    contactPreference: 'whatsapp',
    openTo: { hiring: true },
    services: [
      { title: 'Machine operator course', note: 'Barudan / Tajima, job-ready' },
      { title: 'Punching / digitizing course', note: 'Wilcom, with placement' },
    ],
  },

  // ── Design students & freelance designers ──────────────────────────────
  {
    key: 'khushi',
    name: 'Khushi Patel',
    mobile: '9100000036',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Fashion design student · final year · looking for an internship',
    bio: 'Final-year fashion design student in Surat. I love bridal and festive wear, and I sketch by hand and on Illustrator. Building my portfolio and looking for an internship with a manufacturer or designer where I can learn the real trade.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Fashion sketching', 'Illustrator', 'Mood boards', 'Draping'],
    contactPreference: 'dm',
    openTo: { work: true },
    // Current SIFD student (no completedYear = ongoing) — appears on the
    // institute's Alumni (open-to-work) tab, not Placements (no current job).
    training: [{ instituteKey: 'sifd', course: 'Fashion Design Diploma' }],
  },
  {
    key: 'aditya',
    name: 'Aditya Rana',
    mobile: '9100000037',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Textile design student · prints, motifs & repeats',
    bio: 'Studying textile design — I work on prints, motifs and repeats for sarees and dress material, mostly in Photoshop and CorelDRAW. Fascinated by how traditional zari motifs translate to modern machine embroidery. Open to internships and live projects.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Print design', 'Motifs', 'Repeats', 'Photoshop', 'CorelDRAW'],
    contactPreference: 'dm',
    openTo: { work: true },
  },
  {
    key: 'riya',
    name: 'Riya Kapoor',
    mobile: '9100000038',
    type: 'explorer',
    intent: 'explorer',
    headline: 'Freelance fashion designer · saree & suit collections',
    bio: 'Freelance fashion designer working with Surat manufacturers and boutiques on festive saree and suit collections. I take a range from concept and mood board to tech pack and sampling. Available for per-collection or monthly retainer work.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['Collection design', 'Tech packs', 'Illustrator', 'Trend research', 'Sampling'],
    contactPreference: 'dm',
    openTo: { work: true, customOrders: true },
    // Placed SIFD alumna — currently designing at Vraj Creations (linked page),
    // so the institute's Placements tab shows a named employer card.
    experience: [
      {
        workshop: 'Vraj Creations',
        role: 'Collection designer',
        fromYear: 2024,
        description: 'Festive and bridal saree collections, concept to sampling.',
        companyPageKey: 'vraj',
      },
    ],
    training: [{ instituteKey: 'sifd', course: 'Fashion Design Diploma', completedYear: 2023 }],
    services: [
      { title: 'Freelance collection design', note: 'Concept to sampling, per collection' },
    ],
  },
  {
    key: 'saurabh',
    name: 'Saurabh Bhatt',
    mobile: '9100000039',
    type: 'explorer',
    intent: 'explorer',
    headline: 'CAD / sketch designer · saree layouts, repeats, colourways',
    bio: 'CAD designer for the saree trade — I make print layouts, repeats and colourways in Photoshop, Illustrator and CorelDRAW, and turn hand sketches into production-ready files. Fast turnaround for manufacturers and exporters. Freelance or monthly.',
    city: 'Surat',
    district: 'Surat',
    state: 'Gujarat',
    skills: ['CAD design', 'Photoshop', 'Illustrator', 'CorelDRAW', 'Colourways'],
    contactPreference: 'whatsapp',
    openTo: { work: true, customOrders: true },
    // Placed SIFD alumnus — freelance (no linked page), so he counts in the
    // Placements tab's "other workplaces" bucket rather than an employer card.
    experience: [
      {
        workshop: 'Freelance CAD design',
        role: 'CAD designer',
        fromYear: 2022,
        description: 'Saree print layouts, repeats and colourways for manufacturers.',
      },
    ],
    training: [{ instituteKey: 'sifd', course: 'Saree CAD & Colourways', completedYear: 2022 }],
    services: [{ title: 'Saree CAD / repeats', note: 'Layouts, colourways, production files' }],
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Business entities (owned by trader / workshop_owner personas)
 * ──────────────────────────────────────────────────────────────────────── */

export interface CompanyPageSeed {
  key: string;
  ownerKey: string;
  slug: string;
  name: string;
  about: string;
  specialization: string[];
  machineCapacity: string;
  production: string;
  languages: string[];
  erpLinked?: boolean;
  /** 'institute' pages get the Institute badge + Placements/Alumni tabs. Default: business. */
  kind?: 'business' | 'institute';
  /** Institute "what we teach" panel — only meaningful with kind: 'institute'. */
  institutePanel?: {
    coursesOffered: string[];
    modes: Array<'online' | 'offline'>;
    languages: string[];
  };
}

export const COMPANY_PAGES: CompanyPageSeed[] = [
  {
    key: 'mehta',
    ownerKey: 'rajesh',
    slug: 'mehta-embroidery-works',
    name: 'Mehta Embroidery Works',
    about:
      'Family-run zari embroidery and job-work unit in Varachha, Surat since 2009. Multi-head machines, bulk capacity, on-time delivery.',
    specialization: ['embroidery-zari', 'job-work'],
    machineCapacity: '20 multi-head machines',
    production: '6000 metres / week',
    languages: ['gu', 'hi'],
    erpLinked: true,
  },
  {
    key: 'devi',
    ownerKey: 'bhavna',
    slug: 'devi-creations',
    name: 'Devi Creations',
    about:
      'Women-led embroidery unit in Sachin, Surat. Dress-material and kurti embroidery, trained karigars from nearby villages.',
    specialization: ['embroidery-zari', 'job-work'],
    machineCapacity: '12 machines',
    production: '3500 metres / week',
    languages: ['gu', 'hi'],
  },
  {
    key: 'memon',
    ownerKey: 'yusuf',
    slug: 'memon-zari-house',
    name: 'Memon Zari House',
    about:
      'Third-generation zari job-work. Per-metre multi-head embroidery on your fabric — fast turnaround, fair rates, premium thread.',
    specialization: ['embroidery-zari', 'job-work'],
    machineCapacity: '16 multi-head machines',
    production: '5000 metres / week',
    languages: ['gu', 'hi', 'ur'],
  },
  {
    key: 'kiran-tex',
    ownerKey: 'kiran',
    slug: 'kiran-textiles',
    name: 'Kiran Textiles',
    about:
      'Wholesale sarees and dress material from Surat to all India. Georgette, organza and silk-blend ranges, daily dispatch.',
    specialization: ['finished-goods'],
    machineCapacity: 'Wholesale trading house',
    production: '2000+ pieces / week dispatch',
    languages: ['gu', 'hi', 'en'],
  },
  // ── Companies + institutes (larger entities with pages) ────────────────
  {
    key: 'vraj',
    ownerKey: 'manish',
    slug: 'vraj-creations',
    name: 'Vraj Creations',
    about:
      'Designer saree manufacturer in Surat with an in-house design team and embroidery unit. Festive and bridal ranges for wholesalers and exporters across India.',
    specialization: ['finished-goods', 'embroidery-zari'],
    machineCapacity: '40 multi-head machines + design studio',
    production: '8000+ sarees / month',
    languages: ['gu', 'hi', 'en'],
  },
  {
    key: 'suremb',
    ownerKey: 'paresh',
    slug: 'surat-embroidery-machines',
    name: 'Surat Embroidery Machines',
    about:
      'Authorised dealer for Tajima, Barudan and Ricoma multi-head embroidery machines — new and certified pre-owned. Sales, installation, operator training, AMC and spares.',
    specialization: ['machinery'],
    machineCapacity: 'Showroom + service workshop',
    production: 'Sales, install, AMC & spares',
    languages: ['gu', 'hi', 'en'],
  },
  {
    key: 'sifd',
    ownerKey: 'anita',
    slug: 'surat-institute-fashion-design',
    name: 'Surat Institute of Fashion & Design',
    about:
      'Diploma and certificate courses in fashion design, textile design and CAD, with sampling labs, industry projects and placement support for Surat manufacturers, exporters and boutiques.',
    specialization: ['fashion design', 'textile design', 'CAD'],
    machineCapacity: 'Design studio + CAD lab + sampling unit',
    production: 'Diploma / certificate courses · placements',
    languages: ['gu', 'hi', 'en'],
    kind: 'institute',
    institutePanel: {
      coursesOffered: [
        'Fashion Design Diploma',
        'Textile Design Certificate',
        'Saree CAD & Colourways',
      ],
      modes: ['offline'],
      languages: ['gu', 'hi', 'en'],
    },
  },
  {
    key: 'zariya',
    ownerKey: 'rohit',
    slug: 'zariya-embroidery-cad-academy',
    name: 'Zariya Embroidery & CAD Academy',
    about:
      'Vocational training for computerized-embroidery machine operators and punching designers (Wilcom). Short, job-ready courses with placement into Surat embroidery units.',
    specialization: ['embroidery training', 'punching', 'machine operation'],
    machineCapacity: 'Training floor with embroidery machines + CAD lab',
    production: 'Operator + punching courses · placements',
    languages: ['gu', 'hi', 'en'],
    kind: 'institute',
    institutePanel: {
      coursesOffered: [
        'Machine operator course (Barudan / Tajima)',
        'Punching / digitizing (Wilcom)',
      ],
      modes: ['offline'],
      languages: ['gu', 'hi'],
    },
  },
];

export interface StorefrontSeed {
  key: string;
  ownerKey: string;
  companyPageKey?: string;
  slug: string;
  name: string;
  description: string;
  categories: string[];
}

export const STOREFRONTS: StorefrontSeed[] = [
  {
    key: 'mehta-shop',
    ownerKey: 'rajesh',
    companyPageKey: 'mehta',
    slug: 'mehta-embroidery-works-shop',
    name: 'Mehta Embroidery Works',
    description: 'Zari embroidery, job-work and finished trims. Wholesale and bulk orders welcome.',
    categories: ['embroidery-zari', 'job-work', 'finished-goods'],
  },
  {
    key: 'memon-shop',
    ownerKey: 'yusuf',
    companyPageKey: 'memon',
    slug: 'memon-zari-house-shop',
    name: 'Memon Zari House',
    description: 'Per-metre zari job-work and ready zari borders. Bulk discounts, premium thread.',
    categories: ['embroidery-zari', 'job-work'],
  },
  {
    key: 'kiran-shop',
    ownerKey: 'kiran',
    companyPageKey: 'kiran-tex',
    slug: 'kiran-textiles-shop',
    name: 'Kiran Textiles',
    description: 'Wholesale sarees, dress material and dupattas. All-India transport dispatch.',
    categories: ['finished-goods'],
  },
  {
    key: 'hariom-shop',
    ownerKey: 'haresh',
    slug: 'hari-om-fabrics-shop',
    name: 'Hari Om Fabrics',
    description: 'Grey and finished fabric — georgette, crepe, satin. Container and small lots.',
    categories: ['raw-material', 'finished-goods'],
  },
  // ── Service-provider shops (chain expansion) ───────────────────────────
  {
    key: 'dilip-shop',
    ownerKey: 'dilip',
    slug: 'dilip-grey-yarn-shop',
    name: 'Dilip Grey & Yarn',
    description:
      'Grey georgette, chiffon and embroidery-base yarn. Ring Road godown, daily lots, container or small quantity.',
    categories: ['raw-material'],
  },
  {
    key: 'naran-shop',
    ownerKey: 'naran',
    slug: 'shree-naran-process-house-shop',
    name: 'Shree Naran Process House',
    description:
      'Dyeing and digital-print job-work. Colour matching, 8000 m/day, on-time processing for traders and units.',
    categories: ['dyeing', 'printing'],
  },
  {
    key: 'mahesh-shop',
    ownerKey: 'mahesh',
    slug: 'parmar-machine-service-shop',
    name: 'Parmar Machine Service',
    description:
      'Embroidery machine AMC, head repair and genuine spares — Barudan, Tajima, Ricoma. Fast call-out.',
    categories: ['machinery'],
  },
  {
    key: 'alpa-shop',
    ownerKey: 'alpa',
    slug: 'studio-rang-shop',
    name: 'Studio Rang',
    description:
      'Catalogue photography and short reels for sarees and dress material. WhatsApp-ready exports, quick turnaround.',
    categories: ['job-work'],
  },
  {
    key: 'kruti-shop',
    ownerKey: 'kruti',
    slug: 'kruti-packaging-shop',
    name: 'Kruti Packaging',
    description:
      'Printed saree covers, gift boxes, poly bags and tags. Custom shop-name branding from small quantities.',
    categories: ['finished-goods'],
  },
  {
    key: 'reena-shop',
    ownerKey: 'reena',
    slug: 'reenaben-tailoring-shop',
    name: 'Reenaben Tailoring',
    description:
      'Women-run stitching unit — designer blouses, pre-draped sarees and matching falls. Bulk for boutiques and resellers.',
    categories: ['job-work'],
  },
  {
    key: 'daxa-shop',
    ownerKey: 'daxa',
    slug: 'daxaben-falls-pico-shop',
    name: 'Daxaben Falls & Pico',
    description:
      'Saree falls, pico and edge finishing. Neat invisible pico, colour-matched falls, quick batches with market pickup-drop.',
    categories: ['job-work'],
  },
  {
    key: 'rafiq-shop',
    ownerKey: 'rafiq',
    slug: 'mansuri-zari-material-shop',
    name: 'Mansuri Zari & Material',
    description:
      'Kasab/zari thread, cutdana, moti, sitara, sequins and gota lace. Imported + local stock, fresh seasonal shades, bulk or small quantity.',
    categories: ['raw-material'],
  },
  // ── Company storefronts (brand + machine dealer) ───────────────────────
  {
    key: 'vraj-shop',
    ownerKey: 'manish',
    companyPageKey: 'vraj',
    slug: 'vraj-creations-shop',
    name: 'Vraj Creations',
    description:
      'Designer festive and bridal sarees, manufacturer-direct. Embroidered georgette, organza and silk-blend ranges. Wholesale and export.',
    categories: ['finished-goods', 'embroidery-zari'],
  },
  {
    key: 'suremb-shop',
    ownerKey: 'paresh',
    companyPageKey: 'suremb',
    slug: 'surat-embroidery-machines-shop',
    name: 'Surat Embroidery Machines',
    description:
      'Tajima, Barudan and Ricoma multi-head machines — new and certified pre-owned. Install, training, AMC and spares.',
    categories: ['machinery'],
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Listings
 * ──────────────────────────────────────────────────────────────────────── */

export interface ListingSeed {
  ownerKey: string;
  storefrontKey: string;
  title: string;
  description: string;
  category: string; // LISTING_CATEGORIES
  priceType: 'fixed' | 'range' | 'negotiable';
  priceMin?: number;
  priceMax?: number;
  unit: 'per-meter' | 'per-piece' | 'per-kg' | 'per-set' | 'per-dozen' | 'per-order';
  moq?: number;
  leadTimeDays?: number;
  specs?: Array<{ label: string; value: string }>;
  tradeTerms?: { dispatch?: string; payment?: string; returns?: string };
  tags?: string[];
}

export const LISTINGS: ListingSeed[] = [
  {
    ownerKey: 'rajesh',
    storefrontKey: 'mehta-shop',
    title: 'Gold zari embroidery job-work (multi-head)',
    description:
      'Per-metre multi-head embroidery on your fabric. Bridal-grade gold zari, clean reverse, fine finishing. Min 200 m. 3–4 day turnaround once fabric reaches us.',
    category: 'embroidery-zari',
    priceType: 'range',
    priceMin: 35,
    priceMax: 80,
    unit: 'per-meter',
    moq: 200,
    leadTimeDays: 4,
    specs: [
      { label: 'Machine', value: 'Barudan multi-head' },
      { label: 'Thread', value: 'Premium gold zari' },
      { label: 'Min order', value: '200 metres' },
    ],
    tradeTerms: {
      dispatch: 'Pickup or transport, Surat',
      payment: '50% advance, balance on dispatch',
      returns: 'Rework for genuine defects',
    },
    tags: ['zari', 'job-work', 'bridal'],
  },
  {
    ownerKey: 'rajesh',
    storefrontKey: 'mehta-shop',
    title: 'Ready zari border rolls (assorted designs)',
    description:
      'Finished zari border rolls, assorted festive designs. Sold per piece (9 m roll), bulk discounts above 50 pieces.',
    category: 'finished-goods',
    priceType: 'fixed',
    priceMin: 120,
    unit: 'per-piece',
    moq: 50,
    leadTimeDays: 2,
    specs: [
      { label: 'Roll length', value: '9 metres' },
      { label: 'Designs', value: 'Assorted festive' },
    ],
    tradeTerms: { dispatch: 'Daily transport dispatch', payment: 'Advance for new buyers' },
    tags: ['zari-border', 'ready-stock'],
  },
  {
    ownerKey: 'yusuf',
    storefrontKey: 'memon-shop',
    title: 'Per-metre saree embroidery job-work',
    description:
      'Bulk saree embroidery on your georgette or silk. Sequin + zari combination designs. 5000 m/week capacity. Sample run before bulk.',
    category: 'job-work',
    priceType: 'range',
    priceMin: 28,
    priceMax: 65,
    unit: 'per-meter',
    moq: 500,
    leadTimeDays: 5,
    specs: [
      { label: 'Capacity', value: '5000 m / week' },
      { label: 'Work', value: 'Sequin + zari' },
    ],
    tradeTerms: {
      dispatch: 'Transport, Surat',
      payment: '40% advance',
      returns: 'Rework for defects',
    },
    tags: ['job-work', 'saree', 'bulk'],
  },
  {
    ownerKey: 'yusuf',
    storefrontKey: 'memon-shop',
    title: 'Dupatta zari work (per piece)',
    description:
      'Festive dupatta zari and sequin work, per piece on your base. Min 100 pieces. Consistent quality across the batch.',
    category: 'embroidery-zari',
    priceType: 'range',
    priceMin: 45,
    priceMax: 110,
    unit: 'per-piece',
    moq: 100,
    leadTimeDays: 4,
    tags: ['dupatta', 'zari'],
  },
  {
    ownerKey: 'kiran',
    storefrontKey: 'kiran-shop',
    title: 'Georgette designer sarees (wholesale lot)',
    description:
      'Wholesale georgette sarees with embroidered borders, mixed festive colours. Sold per dozen, fresh designs every week.',
    category: 'finished-goods',
    priceType: 'range',
    priceMin: 650,
    priceMax: 1450,
    unit: 'per-piece',
    moq: 12,
    leadTimeDays: 2,
    specs: [
      { label: 'Fabric', value: 'Georgette' },
      { label: 'Pack', value: 'Per dozen, mixed colours' },
    ],
    tradeTerms: {
      dispatch: 'All-India transport, daily',
      payment: 'Advance / against delivery for regulars',
    },
    tags: ['saree', 'wholesale', 'georgette'],
  },
  {
    ownerKey: 'kiran',
    storefrontKey: 'kiran-shop',
    title: 'Dress material — unstitched sets (wholesale)',
    description:
      'Unstitched dress-material sets, embroidered yoke + dupatta. Catalogue dispatch all India. Per-set wholesale pricing.',
    category: 'finished-goods',
    priceType: 'fixed',
    priceMin: 420,
    unit: 'per-set',
    moq: 24,
    leadTimeDays: 2,
    tags: ['dress-material', 'wholesale'],
  },
  {
    ownerKey: 'haresh',
    storefrontKey: 'hariom-shop',
    title: 'Grey georgette fabric (per kg)',
    description:
      'Grey georgette for embroidery and dyeing units. Consistent GSM, container and small lots. Surat pickup or transport.',
    category: 'raw-material',
    priceType: 'negotiable',
    unit: 'per-kg',
    moq: 100,
    leadTimeDays: 3,
    specs: [
      { label: 'Type', value: 'Grey georgette' },
      { label: 'Supply', value: 'Container + small lot' },
    ],
    tags: ['grey-fabric', 'georgette', 'raw-material'],
  },
  {
    ownerKey: 'haresh',
    storefrontKey: 'hariom-shop',
    title: 'Finished crepe & satin (per metre)',
    description:
      'Dyed finished crepe and satin in stock shades. For garment makers and boutiques. Per-metre, min 500 m.',
    category: 'finished-goods',
    priceType: 'range',
    priceMin: 60,
    priceMax: 145,
    unit: 'per-meter',
    moq: 500,
    leadTimeDays: 3,
    tags: ['crepe', 'satin', 'finished'],
  },
  // ── Service & allied-trade listings (chain expansion) ──────────────────
  {
    ownerKey: 'dilip',
    storefrontKey: 'dilip-shop',
    title: 'Grey georgette base fabric (daily lots)',
    description:
      'Grey georgette and chiffon base for embroidery units. Consistent width and GSM, daily lots from Ring Road godown. Container or small quantity, credit terms for regulars.',
    category: 'raw-material',
    priceType: 'range',
    priceMin: 38,
    priceMax: 60,
    unit: 'per-meter',
    moq: 500,
    leadTimeDays: 2,
    specs: [
      { label: 'Fabric', value: 'Grey georgette / chiffon' },
      { label: 'Min order', value: '500 metres' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: 'Credit terms for regulars' },
    tags: ['grey-fabric', 'georgette', 'raw-material'],
  },
  {
    ownerKey: 'naran',
    storefrontKey: 'naran-shop',
    title: 'Dyeing + digital print job-work',
    description:
      'Process-house job-work — dyeing and digital print on your fabric, colour matched to sample. 8000 m/day capacity, consistent shades, on-time for festive ranges.',
    category: 'dyeing',
    priceType: 'range',
    priceMin: 12,
    priceMax: 30,
    unit: 'per-meter',
    moq: 1000,
    leadTimeDays: 5,
    specs: [
      { label: 'Process', value: 'Dyeing + digital print' },
      { label: 'Capacity', value: '8000 m / day' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: '50% advance' },
    tags: ['dyeing', 'digital-print', 'job-work'],
  },
  {
    ownerKey: 'mahesh',
    storefrontKey: 'mahesh-shop',
    title: 'Embroidery machine AMC & service (call-out)',
    description:
      'Annual maintenance and on-call service for multi-head machines — Barudan, Tajima, Ricoma. Head repair, hook timing, trimmer reset. Genuine spares carried.',
    category: 'machinery',
    priceType: 'negotiable',
    unit: 'per-order',
    leadTimeDays: 1,
    specs: [
      { label: 'Brands', value: 'Barudan / Tajima / Ricoma' },
      { label: 'Service', value: 'AMC, repair, spares' },
    ],
    tradeTerms: { dispatch: 'On-site, Surat', payment: 'On completion' },
    tags: ['machine-service', 'AMC', 'spares'],
  },
  {
    ownerKey: 'alpa',
    storefrontKey: 'alpa-shop',
    title: 'Catalogue photography (per shoot)',
    description:
      'Product photography and short reels for saree and dress-material catalogues. Soft daylight setup, WhatsApp-ready exports. Per-piece or per-day packages.',
    category: 'job-work',
    priceType: 'range',
    priceMin: 40,
    priceMax: 120,
    unit: 'per-piece',
    moq: 20,
    leadTimeDays: 3,
    specs: [
      { label: 'Output', value: 'Photos + reels, edited' },
      { label: 'Turnaround', value: '2–3 days' },
    ],
    tradeTerms: { dispatch: 'Studio, Surat', payment: 'Advance booking' },
    tags: ['photography', 'catalogue', 'reels'],
  },
  {
    ownerKey: 'kruti',
    storefrontKey: 'kruti-shop',
    title: 'Printed saree covers (custom branding)',
    description:
      'Saree covers and gift boxes with optional custom shop-name printing. Small-quantity custom runs, wholesale rates for traders. Neat, durable packaging.',
    category: 'finished-goods',
    priceType: 'range',
    priceMin: 8,
    priceMax: 25,
    unit: 'per-piece',
    moq: 200,
    leadTimeDays: 5,
    specs: [
      { label: 'Type', value: 'Covers / boxes / poly bags' },
      { label: 'Branding', value: 'Custom from small qty' },
    ],
    tradeTerms: { dispatch: 'Transport, Surat', payment: '50% advance' },
    tags: ['packaging', 'saree-covers', 'custom'],
  },
  {
    ownerKey: 'reena',
    storefrontKey: 'reena-shop',
    title: 'Designer blouse stitching (bulk)',
    description:
      'Women-run bulk blouse stitching for boutiques and resellers — piping, lining, hooks, pressed and size-sorted. Pre-draped sarees and matching falls also available.',
    category: 'job-work',
    priceType: 'range',
    priceMin: 90,
    priceMax: 250,
    unit: 'per-piece',
    moq: 25,
    leadTimeDays: 7,
    specs: [
      { label: 'Work', value: 'Blouse / pre-draped saree' },
      { label: 'Min order', value: '25 pieces' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: '50% advance' },
    tags: ['blouse-stitching', 'tailoring', 'pre-draped'],
  },
  {
    ownerKey: 'daxa',
    storefrontKey: 'daxa-shop',
    title: 'Saree falls & pico (per saree)',
    description:
      'Falls and invisible pico finishing on sarees, colour matched. Home-based women’s group, quick batches for shops and resellers, market-area pickup and drop.',
    category: 'job-work',
    priceType: 'fixed',
    priceMin: 40,
    unit: 'per-piece',
    moq: 20,
    leadTimeDays: 2,
    specs: [
      { label: 'Work', value: 'Falls + pico' },
      { label: 'Batch', value: 'From 20 sarees' },
    ],
    tradeTerms: { dispatch: 'Market-area pickup-drop', payment: 'On delivery' },
    tags: ['falls', 'pico', 'finishing'],
  },
  // ── Embroidery-material / component listings (market-researched) ───────
  {
    ownerKey: 'rafiq',
    storefrontKey: 'rafiq-shop',
    title: 'Cutdana & moti (beads) — assorted shades',
    description:
      'Imported and local cutdana and moti for hand and machine embroidery. Assorted sizes and seasonal shades, colour-fast. Bulk by weight or small packs for karigars.',
    category: 'raw-material',
    priceType: 'range',
    priceMin: 250,
    priceMax: 900,
    unit: 'per-kg',
    moq: 1,
    leadTimeDays: 2,
    specs: [
      { label: 'Items', value: 'Cutdana, moti (beads)' },
      { label: 'Range', value: 'Assorted sizes & shades' },
    ],
    tradeTerms: { dispatch: 'Counter or transport, Surat', payment: 'Advance for new buyers' },
    tags: ['cutdana', 'moti', 'beads'],
  },
  {
    ownerKey: 'rafiq',
    storefrontKey: 'rafiq-shop',
    title: 'Sitara & sequins — metal and plastic',
    description:
      'Sitara (star sequins) and assorted sequins in metal and plastic finish for aari, zardozi and machine work. Gold, silver and colour shades. Bulk packs.',
    category: 'raw-material',
    priceType: 'range',
    priceMin: 200,
    priceMax: 700,
    unit: 'per-kg',
    moq: 1,
    leadTimeDays: 2,
    specs: [
      { label: 'Items', value: 'Sitara, sequins' },
      { label: 'Finish', value: 'Metal / plastic, multi-shade' },
    ],
    tradeTerms: { dispatch: 'Counter or transport, Surat', payment: 'Advance for new buyers' },
    tags: ['sitara', 'sequins', 'embroidery-material'],
  },
  {
    ownerKey: 'rafiq',
    storefrontKey: 'rafiq-shop',
    title: 'Kasab / zari thread & gota lace borders',
    description:
      'Imitation kasab (zari) thread on cones and ready gota lace borders for embroidery and saree work. Gold/silver and antique shades, fast colours. Per-piece rolls or by weight.',
    category: 'raw-material',
    priceType: 'range',
    priceMin: 40,
    priceMax: 180,
    unit: 'per-piece',
    moq: 10,
    leadTimeDays: 2,
    specs: [
      { label: 'Items', value: 'Kasab/zari thread, gota lace' },
      { label: 'Shades', value: 'Gold / silver / antique' },
    ],
    tradeTerms: { dispatch: 'Counter or transport, Surat', payment: 'Advance for new buyers' },
    tags: ['kasab', 'zari', 'gota'],
  },
  // ── Second listings so each seller's shop feels stocked ────────────────
  {
    ownerKey: 'rajesh',
    storefrontKey: 'mehta-shop',
    title: 'Bridal lehenga panels — zardozi (made to order)',
    description:
      'Made-to-order bridal lehenga panels with zardozi, cutdana and sequin work on your fabric. Premium finishing, clean reverse. Sample on request before bulk.',
    category: 'embroidery-zari',
    priceType: 'range',
    priceMin: 1500,
    priceMax: 6000,
    unit: 'per-piece',
    moq: 5,
    leadTimeDays: 10,
    specs: [
      { label: 'Work', value: 'Zardozi, cutdana, sequins' },
      { label: 'Order', value: 'Made to order, sample first' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: '50% advance' },
    tags: ['bridal', 'zardozi', 'lehenga'],
  },
  {
    ownerKey: 'kiran',
    storefrontKey: 'kiran-shop',
    title: 'Wholesale dress material (per-dozen)',
    description:
      'Unstitched dress material in festive ranges — georgette, cotton and blends with embroidered yokes. Per-dozen wholesale, mixed-design catalogues. All-India dispatch.',
    category: 'finished-goods',
    priceType: 'range',
    priceMin: 220,
    priceMax: 650,
    unit: 'per-dozen',
    moq: 5,
    leadTimeDays: 3,
    specs: [
      { label: 'Type', value: 'Unstitched dress material' },
      { label: 'Pack', value: 'Per-dozen, mixed designs' },
    ],
    tradeTerms: { dispatch: 'All-India transport', payment: 'Advance for new buyers' },
    tags: ['dress-material', 'wholesale', 'catalogue'],
  },
  {
    ownerKey: 'dilip',
    storefrontKey: 'dilip-shop',
    title: 'Embroidery-base yarn (cones)',
    description:
      'Polyester and viscose embroidery-base yarn on cones for multi-head units. Consistent tex, fast colours, daily availability. Bulk by carton or small quantity.',
    category: 'raw-material',
    priceType: 'range',
    priceMin: 180,
    priceMax: 420,
    unit: 'per-kg',
    moq: 25,
    leadTimeDays: 2,
    specs: [
      { label: 'Type', value: 'Polyester / viscose yarn' },
      { label: 'Form', value: 'Cones' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: 'Credit terms for regulars' },
    tags: ['yarn', 'embroidery-base', 'raw-material'],
  },
  {
    ownerKey: 'naran',
    storefrontKey: 'naran-shop',
    title: 'Fabric dyeing — colour matched (job-work)',
    description:
      'Dyeing job-work on georgette, chiffon and crepe to your shade card. Consistent batches, soft finish, quick festive turnaround. Min 1000 m.',
    category: 'dyeing',
    priceType: 'range',
    priceMin: 8,
    priceMax: 18,
    unit: 'per-meter',
    moq: 1000,
    leadTimeDays: 4,
    specs: [
      { label: 'Service', value: 'Dyeing, colour matched' },
      { label: 'Fabrics', value: 'Georgette / chiffon / crepe' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: '50% advance' },
    tags: ['dyeing', 'job-work'],
  },
  {
    ownerKey: 'mahesh',
    storefrontKey: 'mahesh-shop',
    title: 'Embroidery machine spare parts',
    description:
      'Genuine spares for multi-head machines — hooks, rotary trimmers, needles, tension assemblies, drive belts. For Barudan, Tajima and Ricoma. Counter or doorstep.',
    category: 'machinery',
    priceType: 'negotiable',
    unit: 'per-piece',
    leadTimeDays: 1,
    specs: [
      { label: 'Parts', value: 'Hooks, trimmers, needles' },
      { label: 'Brands', value: 'Barudan / Tajima / Ricoma' },
    ],
    tradeTerms: { dispatch: 'Counter or doorstep, Surat', payment: 'On purchase' },
    tags: ['spares', 'machinery', 'embroidery'],
  },
  {
    ownerKey: 'alpa',
    storefrontKey: 'alpa-shop',
    title: 'Instagram reels package (sarees)',
    description:
      'Short vertical reels for sarees and dress material — styling, soft daylight, music-ready edits for Instagram and catalogues. Per-reel or monthly package.',
    category: 'job-work',
    priceType: 'range',
    priceMin: 150,
    priceMax: 500,
    unit: 'per-piece',
    moq: 5,
    leadTimeDays: 3,
    specs: [
      { label: 'Output', value: 'Vertical reels, edited' },
      { label: 'For', value: 'Instagram / catalogue' },
    ],
    tradeTerms: { dispatch: 'Studio, Surat', payment: 'Advance booking' },
    tags: ['reels', 'photography', 'catalogue'],
  },
  {
    ownerKey: 'kruti',
    storefrontKey: 'kruti-shop',
    title: 'Poly bags & hang tags (bulk)',
    description:
      'Transparent and printed poly bags, hang tags and price tags for sarees and dress material. Bulk rolls, custom printing available. Wholesale rate for traders.',
    category: 'finished-goods',
    priceType: 'range',
    priceMin: 1,
    priceMax: 6,
    unit: 'per-piece',
    moq: 500,
    leadTimeDays: 4,
    specs: [
      { label: 'Items', value: 'Poly bags, hang tags' },
      { label: 'Printing', value: 'Plain or custom' },
    ],
    tradeTerms: { dispatch: 'Transport, Surat', payment: '50% advance' },
    tags: ['packaging', 'polybags', 'tags'],
  },
  {
    ownerKey: 'reena',
    storefrontKey: 'reena-shop',
    title: 'Pre-draped saree stitching (ruffle / belt)',
    description:
      'Ready-to-wear pre-draped sarees stitched with ruffle or belt and matching blouse. Sized to fit, clean finishing. Bulk for boutiques and online resellers.',
    category: 'job-work',
    priceType: 'range',
    priceMin: 250,
    priceMax: 600,
    unit: 'per-piece',
    moq: 20,
    leadTimeDays: 7,
    specs: [
      { label: 'Style', value: 'Ruffle / belt, matching blouse' },
      { label: 'Min order', value: '20 pieces' },
    ],
    tradeTerms: { dispatch: 'Pickup or transport, Surat', payment: '50% advance' },
    tags: ['pre-draped', 'tailoring', 'blouse'],
  },
  {
    ownerKey: 'daxa',
    storefrontKey: 'daxa-shop',
    title: 'Roll hemming & saree edge finishing',
    description:
      'Machine roll hemming and edge finishing on sarees and dupattas, colour-matched thread. Neat, fast batches for shops and resellers. Market-area pickup-drop.',
    category: 'job-work',
    priceType: 'fixed',
    priceMin: 25,
    unit: 'per-piece',
    moq: 20,
    leadTimeDays: 2,
    specs: [
      { label: 'Work', value: 'Roll hem / edge finishing' },
      { label: 'Batch', value: 'From 20 pieces' },
    ],
    tradeTerms: { dispatch: 'Market-area pickup-drop', payment: 'On delivery' },
    tags: ['hemming', 'finishing', 'saree'],
  },
  // ── Company listings (manufacturer brand + machine dealer) ─────────────
  {
    ownerKey: 'manish',
    storefrontKey: 'vraj-shop',
    title: 'Designer embroidered georgette sarees (wholesale)',
    description:
      'Manufacturer-direct designer sarees — embroidered georgette and organza, festive shades, fresh catalogues every fortnight. Per-piece wholesale, bulk and export quantities.',
    category: 'finished-goods',
    priceType: 'range',
    priceMin: 650,
    priceMax: 2500,
    unit: 'per-piece',
    moq: 50,
    leadTimeDays: 7,
    specs: [
      { label: 'Fabric', value: 'Georgette / organza' },
      { label: 'Work', value: 'Embroidered, festive' },
    ],
    tradeTerms: { dispatch: 'All-India transport + export', payment: 'Advance for new buyers' },
    tags: ['designer-saree', 'wholesale', 'georgette'],
  },
  {
    ownerKey: 'manish',
    storefrontKey: 'vraj-shop',
    title: 'Bridal sarees — zardozi & cutdana (made to order)',
    description:
      'Bridal and reception sarees with zardozi, cutdana and sequin work, made to order in our in-house unit. Premium finishing, custom colours. Sample before bulk.',
    category: 'embroidery-zari',
    priceType: 'range',
    priceMin: 2500,
    priceMax: 12000,
    unit: 'per-piece',
    moq: 20,
    leadTimeDays: 15,
    specs: [
      { label: 'Work', value: 'Zardozi, cutdana, sequins' },
      { label: 'Order', value: 'Made to order' },
    ],
    tradeTerms: { dispatch: 'All-India + export', payment: '50% advance' },
    tags: ['bridal', 'zardozi', 'designer-saree'],
  },
  {
    ownerKey: 'paresh',
    storefrontKey: 'suremb-shop',
    title: 'Tajima 15-head embroidery machine (new)',
    description:
      'New Tajima 15-head multi-head embroidery machine, supplied, installed and operator-trained. Best for bulk saree and dress-material job-work. AMC and spares available.',
    category: 'machinery',
    priceType: 'negotiable',
    unit: 'per-piece',
    leadTimeDays: 20,
    specs: [
      { label: 'Brand', value: 'Tajima' },
      { label: 'Heads', value: '15-head multi-head' },
    ],
    tradeTerms: {
      dispatch: 'Install at your unit, Surat/Gujarat',
      payment: 'As per finance terms',
    },
    tags: ['embroidery-machine', 'tajima', 'machinery'],
  },
  {
    ownerKey: 'paresh',
    storefrontKey: 'suremb-shop',
    title: 'Certified pre-owned Barudan machine',
    description:
      'Certified pre-owned Barudan multi-head machine, serviced and tested, with warranty on service. A budget entry for new units. Install and training included.',
    category: 'machinery',
    priceType: 'negotiable',
    unit: 'per-piece',
    leadTimeDays: 10,
    specs: [
      { label: 'Brand', value: 'Barudan (pre-owned)' },
      { label: 'Condition', value: 'Serviced + tested' },
    ],
    tradeTerms: { dispatch: 'Install at your unit, Surat', payment: 'As per terms' },
    tags: ['embroidery-machine', 'barudan', 'pre-owned'],
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Jobs
 * ──────────────────────────────────────────────────────────────────────── */

export interface JobSeed {
  ownerKey: string;
  companyPageKey?: string;
  title: string;
  description: string;
  responsibilities?: string[];
  category: string;
  role: 'karigar' | 'operator' | 'designer' | 'supervisor' | 'helper';
  wageType: 'hourly' | 'daily' | 'piece' | 'monthly';
  wageMin: number;
  wageMax: number;
  openings: number;
  skills?: string[];
  machineType?: string;
  employmentType: 'full_time' | 'part_time' | 'contract' | 'temporary' | 'apprenticeship';
  experienceMin?: number;
  shift?: 'day' | 'night' | 'rotational' | 'flexible';
  workingDays?: string;
  languages?: string[];
  benefits?: string[];
}

export const JOBS: JobSeed[] = [
  {
    ownerKey: 'rajesh',
    companyPageKey: 'mehta',
    title: 'Multi-needle machine operators (festive season)',
    description:
      'Hiring 4 experienced multi-head embroidery operators for the festive season. Daily wage based on machine experience. Varachha, Surat.',
    responsibilities: [
      'Run Barudan / Tajima multi-head machines',
      'Thread changes and basic maintenance',
      'Maintain quality on bulk runs',
    ],
    category: 'embroidery-zari',
    role: 'operator',
    wageType: 'daily',
    wageMin: 500,
    wageMax: 800,
    openings: 4,
    skills: ['Multi-head machine', 'Barudan', 'Tajima'],
    machineType: 'Multi-head',
    employmentType: 'full_time',
    experienceMin: 2,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Tea + lunch', 'Overtime pay', 'Festival bonus'],
  },
  {
    ownerKey: 'bhavna',
    companyPageKey: 'devi',
    title: 'Women karigars — dress material hand embroidery',
    description:
      'Devi Creations is hiring women karigars for hand and machine embroidery on dress material. Training given to willing learners. Safe, women-led workplace in Sachin.',
    responsibilities: [
      'Hand and machine embroidery on dress material',
      'Finishing and thread cutting',
      'Batch quality checks',
    ],
    category: 'embroidery-zari',
    role: 'karigar',
    wageType: 'monthly',
    wageMin: 11000,
    wageMax: 16000,
    openings: 6,
    skills: ['Hand embroidery', 'Thread work', 'Finishing'],
    employmentType: 'full_time',
    experienceMin: 0,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Training provided', 'Women-led unit', 'Pickup van for nearby villages'],
  },
  {
    ownerKey: 'yusuf',
    companyPageKey: 'memon',
    title: 'Supervisor — zari job-work floor',
    description:
      'Memon Zari House needs a floor supervisor to manage 16 machines, plan job-work orders and keep quality consistent. 5+ years embroidery experience required.',
    responsibilities: [
      'Plan and schedule job-work orders',
      'Supervise 16 machines and operators',
      'Quality and timeline ownership',
    ],
    category: 'job-work',
    role: 'supervisor',
    wageType: 'monthly',
    wageMin: 22000,
    wageMax: 32000,
    openings: 1,
    skills: ['Production planning', 'Team handling', 'Embroidery'],
    employmentType: 'full_time',
    experienceMin: 5,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi', 'ur'],
    benefits: ['Monthly incentive', 'Festival bonus'],
  },
  {
    ownerKey: 'sunita',
    title: 'Helpers & trainees — embroidery units (multiple)',
    description:
      'Placing helpers and trainees across several Surat embroidery units. No experience needed for trainee roles. Steady work, weekly placements. Message to apply.',
    responsibilities: ['Assist machine operators', 'Thread, cut and pack', 'Learn on the job'],
    category: 'embroidery-zari',
    role: 'helper',
    wageType: 'daily',
    wageMin: 350,
    wageMax: 500,
    openings: 10,
    skills: ['Willing to learn'],
    employmentType: 'full_time',
    experienceMin: 0,
    shift: 'flexible',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['On-the-job training', 'Weekly placements'],
  },
  {
    ownerKey: 'rajesh',
    companyPageKey: 'mehta',
    title: 'Embroidery designer (CAD / Wilcom)',
    description:
      'Looking for an embroidery designer comfortable with Wilcom / punching software to convert artwork to machine files. Portfolio preferred.',
    category: 'embroidery-zari',
    role: 'designer',
    wageType: 'monthly',
    wageMin: 18000,
    wageMax: 28000,
    openings: 1,
    skills: ['Wilcom', 'Punching', 'CAD'],
    employmentType: 'full_time',
    experienceMin: 2,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi', 'en'],
    benefits: ['Creative work', 'Incentives on output'],
  },
  {
    ownerKey: 'yusuf',
    companyPageKey: 'memon',
    title: 'Adda hand-work karigars — zardozi (women preferred)',
    description:
      'Hiring adda hand-embroidery karigars for zardozi, dabka and moti work on the frame. Bridal blouses and pallus. Per-piece rates, steady work through the season.',
    responsibilities: [
      'Zardozi / dabka / moti on the adda frame',
      'Bridal blouse and pallu hand work',
      'Neat finishing',
    ],
    category: 'embroidery-zari',
    role: 'karigar',
    wageType: 'piece',
    wageMin: 400,
    wageMax: 1200,
    openings: 8,
    skills: ['Adda work', 'Zardozi', 'Dabka', 'Hand embroidery'],
    employmentType: 'full_time',
    experienceMin: 1,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Per-piece incentive', 'Steady seasonal work'],
  },
  {
    ownerKey: 'rajesh',
    companyPageKey: 'mehta',
    title: 'Checking & finishing staff',
    description:
      'Need careful checking and finishing hands — thread cutting, defect catching, pressing and packing before dispatch. Attention to detail matters more than speed.',
    responsibilities: [
      'Final quality checking',
      'Thread cutting and finishing',
      'Pressing and packing',
    ],
    category: 'embroidery-zari',
    role: 'helper',
    wageType: 'monthly',
    wageMin: 12000,
    wageMax: 17000,
    openings: 3,
    skills: ['Checking', 'Finishing', 'Quality control'],
    employmentType: 'full_time',
    experienceMin: 1,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Tea + lunch', 'Festival bonus'],
  },
  {
    ownerKey: 'reena',
    title: 'Women tailors — blouse & pre-draped saree stitching',
    description:
      'Reenaben Tailoring is hiring women tailors for designer blouse and pre-draped saree stitching. Steady bulk work, training for willing learners, safe women-led workplace in Surat.',
    responsibilities: [
      'Stitch designer blouses (piping, lining, hooks)',
      'Pre-draped saree assembly and finishing',
      'Maintain size and quality on bulk orders',
    ],
    category: 'job-work',
    role: 'karigar',
    wageType: 'monthly',
    wageMin: 12000,
    wageMax: 20000,
    openings: 5,
    skills: ['Blouse stitching', 'Tailoring', 'Finishing'],
    employmentType: 'full_time',
    experienceMin: 1,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Tea + lunch', 'Festival bonus', 'Training given'],
  },
  // ── More jobs across the chain (jobs board feels active) ───────────────
  {
    ownerKey: 'naran',
    title: 'Dyeing & stenter machine operators',
    description:
      'Shree Naran Process House is hiring operators for jet dyeing and stenter machines. Day and rotational shifts, Pandesara, Surat. Experience preferred, helpers can train up.',
    responsibilities: [
      'Operate jet dyeing / stenter machines',
      'Maintain shade consistency and temperature',
      'Basic cleaning and shift handover',
    ],
    category: 'dyeing',
    role: 'operator',
    wageType: 'monthly',
    wageMin: 14000,
    wageMax: 22000,
    openings: 4,
    skills: ['Dyeing machine', 'Stenter', 'Processing'],
    machineType: 'Jet dyeing / stenter',
    employmentType: 'full_time',
    experienceMin: 1,
    shift: 'rotational',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Tea + lunch', 'Overtime pay'],
  },
  {
    ownerKey: 'kiran',
    companyPageKey: 'kiran-tex',
    title: 'Packing & dispatch staff (saree wholesale)',
    description:
      'Kiran Textiles needs packing and dispatch staff for our wholesale saree godown — folding, poly-packing, labelling and loading for all-India transport. Ring Road, Surat.',
    responsibilities: [
      'Fold, poly-pack and label sarees',
      'Prepare cartons for transport',
      'Maintain dispatch records',
    ],
    category: 'finished-goods',
    role: 'helper',
    wageType: 'monthly',
    wageMin: 11000,
    wageMax: 16000,
    openings: 3,
    skills: ['Packing', 'Dispatch', 'Labelling'],
    employmentType: 'full_time',
    experienceMin: 0,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Tea + lunch', 'Festival bonus'],
  },
  {
    ownerKey: 'hasmukh',
    title: 'Multi-needle operators & helpers (multiple units)',
    description:
      'Thekedar hiring on behalf of several Varachha-Sachin units — multi-needle operators and helpers for the festive season. Steady work, weekly payment, placed fast.',
    responsibilities: [
      'Run multi-head embroidery machines',
      'Thread changes and basic upkeep',
      'Helpers assist and learn on the job',
    ],
    category: 'embroidery-zari',
    role: 'operator',
    wageType: 'daily',
    wageMin: 450,
    wageMax: 750,
    openings: 10,
    skills: ['Multi-head machine', 'Embroidery'],
    machineType: 'Multi-head',
    employmentType: 'contract',
    experienceMin: 0,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Weekly payment', 'Tea + lunch'],
  },
  {
    ownerKey: 'yusuf',
    companyPageKey: 'memon',
    title: 'Zari job-work karigars (per-metre)',
    description:
      'Memon Zari House needs karigars for per-metre zari job-work on sarees and dupattas. Piece-rate based on work, steady festive load. Sachin, Surat.',
    responsibilities: [
      'Per-metre zari embroidery on multi-head',
      'Maintain clean thread and reverse',
      'Meet daily metre targets',
    ],
    category: 'embroidery-zari',
    role: 'karigar',
    wageType: 'piece',
    wageMin: 20,
    wageMax: 45,
    openings: 6,
    skills: ['Zari', 'Multi-head machine', 'Job work'],
    machineType: 'Multi-head',
    employmentType: 'full_time',
    experienceMin: 1,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['gu', 'hi'],
    benefits: ['Tea + lunch', 'Overtime pay'],
  },
  // ── Design / company / institute jobs (designer roles + internships) ───
  {
    ownerKey: 'manish',
    companyPageKey: 'vraj',
    title: 'Fashion designer — saree & festive collections',
    description:
      'Vraj Creations is hiring a fashion designer for festive and bridal saree collections. Concept to tech pack, trend research, work with our sampling and embroidery teams. Surat.',
    responsibilities: [
      'Design festive / bridal saree collections',
      'Make mood boards, sketches and tech packs',
      'Coordinate sampling with the embroidery unit',
    ],
    category: 'finished-goods',
    role: 'designer',
    wageType: 'monthly',
    wageMin: 25000,
    wageMax: 45000,
    openings: 2,
    skills: ['Fashion design', 'Illustrator', 'Tech packs', 'Trend research'],
    employmentType: 'full_time',
    experienceMin: 1,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['hi', 'en'],
    benefits: ['Festival bonus', 'Designer studio'],
  },
  {
    ownerKey: 'manish',
    companyPageKey: 'vraj',
    title: 'Saree design internship (stipend)',
    description:
      'Internship at Vraj Creations for fashion / textile design students — assist the design team with sketches, CAD, mood boards and sampling. Stipend, real collections, placement for top interns.',
    responsibilities: [
      'Assist with sketches and CAD files',
      'Help build mood boards and colourways',
      'Support sampling and fittings',
    ],
    category: 'finished-goods',
    role: 'designer',
    wageType: 'monthly',
    wageMin: 8000,
    wageMax: 15000,
    openings: 3,
    skills: ['Sketching', 'Illustrator', 'Photoshop'],
    employmentType: 'apprenticeship',
    experienceMin: 0,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['hi', 'en'],
    benefits: ['Stipend', 'Placement for top interns'],
  },
  {
    ownerKey: 'manish',
    companyPageKey: 'vraj',
    title: 'Merchandiser — wholesale & export',
    description:
      'Merchandiser to manage buyer orders, costing, samples and dispatch timelines for our wholesale and export business. Coordinate between design, production and buyers. Surat.',
    responsibilities: [
      'Manage buyer orders and costing',
      'Track samples and production timelines',
      'Coordinate dispatch and follow-ups',
    ],
    category: 'finished-goods',
    role: 'supervisor',
    wageType: 'monthly',
    wageMin: 20000,
    wageMax: 38000,
    openings: 1,
    skills: ['Merchandising', 'Costing', 'Order management', 'Excel'],
    employmentType: 'full_time',
    experienceMin: 2,
    shift: 'day',
    workingDays: 'Mon–Sat',
    languages: ['hi', 'en'],
    benefits: ['Festival bonus'],
  },
  {
    ownerKey: 'anita',
    companyPageKey: 'sifd',
    title: 'Fashion design faculty (part-time / full-time)',
    description:
      'Surat Institute of Fashion & Design is hiring faculty for fashion design, draping and CAD. Industry experience valued; share your craft with the next generation of designers.',
    responsibilities: [
      'Teach fashion design / draping / CAD',
      'Guide student projects and portfolios',
      'Support placements with industry links',
    ],
    category: 'fashion design',
    role: 'designer',
    wageType: 'monthly',
    wageMin: 25000,
    wageMax: 50000,
    openings: 2,
    skills: ['Fashion design', 'Teaching', 'CAD', 'Draping'],
    employmentType: 'part_time',
    experienceMin: 3,
    shift: 'flexible',
    workingDays: 'Mon–Sat',
    languages: ['hi', 'en'],
    benefits: ['Flexible hours'],
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * RFQs (buyers + designers asking for quotes)
 * ──────────────────────────────────────────────────────────────────────── */

export interface RfqSeed {
  buyerKey: string;
  title: string;
  description: string;
  category: string;
  quantity: number;
  unit: 'per-meter' | 'per-piece' | 'per-kg' | 'per-set' | 'per-dozen' | 'per-order';
  budgetMin: number;
  budgetMax: number;
  neededInDays?: number;
}

export const RFQS: RfqSeed[] = [
  {
    buyerKey: 'priya',
    title: 'Need 30 bridal blouses — aari + zardozi hand work',
    description:
      'Premium bridal blouses, fine aari and zardozi hand work, on my base fabric. Small premium batch, quality over price. Delivery to Bengaluru.',
    category: 'embroidery-zari',
    quantity: 30,
    unit: 'per-piece',
    budgetMin: 60000,
    budgetMax: 105000,
    neededInDays: 30,
  },
  {
    buyerKey: 'anjali',
    title: '400 m contemporary embroidery on georgette',
    description:
      'Modern, minimal embroidery (thread + light sequin) on georgette for a designer collection. Looking for clean finishing and on-time delivery.',
    category: 'job-work',
    quantity: 400,
    unit: 'per-meter',
    budgetMin: 16000,
    budgetMax: 28000,
    neededInDays: 21,
  },
  {
    buyerKey: 'meera',
    title: 'Need 400 m gold zari embroidery on cotton',
    description:
      'Bridal-grade gold zari on cotton base, fine finishing. Delivery to Surat. Sample on request before bulk.',
    category: 'embroidery-zari',
    quantity: 400,
    unit: 'per-meter',
    budgetMin: 18000,
    budgetMax: 26000,
    neededInDays: 18,
  },
  // ── Service-demand RFQs (chain expansion) ──────────────────────────────
  {
    buyerKey: 'neha',
    title: 'Need a catalogue photographer for 50 sarees',
    description:
      'Looking for product photography + a few reels for 50 georgette sarees for my online store. Clean daylight look, WhatsApp-ready exports, quick turnaround.',
    category: 'job-work',
    quantity: 50,
    unit: 'per-piece',
    budgetMin: 3000,
    budgetMax: 6000,
    neededInDays: 10,
  },
  {
    buyerKey: 'kiran',
    title: '500 custom-printed saree covers',
    description:
      'Need 500 saree covers with our shop name printed. Durable material, neat finish. Wholesale rate, dispatch in Surat.',
    category: 'finished-goods',
    quantity: 500,
    unit: 'per-piece',
    budgetMin: 6000,
    budgetMax: 12000,
    neededInDays: 14,
  },
  {
    buyerKey: 'anjali',
    title: '300 m dyeing + digital print on georgette',
    description:
      'Designer collection — need 300 m georgette dyed and digitally printed to my artwork, colour matched. Clean, on-time processing.',
    category: 'dyeing',
    quantity: 300,
    unit: 'per-meter',
    budgetMin: 9000,
    budgetMax: 16000,
    neededInDays: 18,
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Feed posts — all post kinds
 * media.kind drives which image generator the seed calls.
 * ──────────────────────────────────────────────────────────────────────── */

export interface PostSeed {
  authorKey: string;
  asPageKey?: string; // post AS a company page
  kind: 'text' | 'photo' | 'video' | 'document' | 'voice';
  body: string;
  tags?: string[];
  hashtags?: string[];
  media?: {
    count: number;
    kind: 'image' | 'video' | 'document';
    label?: string;
    layout?: 'grid' | 'carousel';
  };
  voice?: { durationSec: number; transcript?: string };
}

export const POSTS: PostSeed[] = [
  {
    authorKey: 'meera',
    kind: 'photo',
    body: 'Finished a bridal lehenga panel today. Gold zardozi over silk georgette, full hand finishing on the border. So happy with how the pallu turned out. #zardozi #bridal',
    tags: ['Open to custom orders'],
    hashtags: ['zardozi', 'bridal'],
    media: { count: 5, kind: 'image', label: 'Bridal lehenga panel', layout: 'carousel' },
  },
  {
    authorKey: 'meera',
    kind: 'text',
    body: 'Tip for new karigars: always check your reverse side. A clean back is what separates ₹40 work from ₹120 work. Buyers notice.',
    hashtags: ['karigartips'],
  },
  {
    authorKey: 'imran',
    kind: 'photo',
    body: 'Aari work in progress on a bridal blouse. Dabka, sitara and a little moti. This one is taking 3 days but worth it. #aari #handembroidery',
    hashtags: ['aari', 'handembroidery'],
    media: { count: 3, kind: 'image', label: 'Aari blouse — WIP', layout: 'grid' },
  },
  {
    authorKey: 'imran',
    kind: 'voice',
    body: 'Quick voice note on how I price aari blouse work — by motif density, not just hours.',
    voice: {
      durationSec: 48,
      transcript:
        'Main aari blouse ka rate motif density se lagata hoon, sirf ghante se nahi. Jitna bharaav zyada, utna rate. Plain border alag, full jaal alag.',
    },
  },
  {
    authorKey: 'lakshmi',
    kind: 'photo',
    body: 'Our women’s group finished 60 dupattas this week — sequins and moti hand work. Proud of the team. Contract work welcome. #womenkarigars',
    tags: ['Open to work'],
    hashtags: ['womenkarigars', 'sequins'],
    media: { count: 4, kind: 'image', label: 'Dupatta batch', layout: 'grid' },
  },
  {
    authorKey: 'suresh',
    kind: 'text',
    body: 'Looking for a steady multi-needle operator job in Surat. 3 years on Barudan and Tajima. Can join immediately. Varachha / Sachin preferred. Please DM.',
    tags: ['Open to work'],
  },
  {
    authorKey: 'rajesh',
    asPageKey: 'mehta',
    kind: 'text',
    body: 'Festive collection is live: fresh gold zari borders and bridal panels, ready for bulk orders. Sample rolls available. DM for rates.',
    tags: ['New collection'],
  },
  {
    authorKey: 'rajesh',
    asPageKey: 'mehta',
    kind: 'photo',
    body: 'We just added 4 new multi-head machines. Faster turnaround on large job-work orders this season. Capacity now 6000 m/week.',
    media: { count: 2, kind: 'image', label: 'New machine floor', layout: 'grid' },
  },
  {
    authorKey: 'rajesh',
    kind: 'text',
    body: 'Hiring 4 multi-needle machine operators for the festive season. Daily wage based on machine experience. Varachha, Surat. Tea, lunch and overtime.',
    tags: ['Hiring karigars'],
  },
  {
    authorKey: 'bhavna',
    asPageKey: 'devi',
    kind: 'photo',
    body: 'Training day at Devi Creations. Five new women started on dress-material embroidery this week. When you train locally, quality and loyalty both grow. #womenled',
    hashtags: ['womenled'],
    media: { count: 3, kind: 'image', label: 'Training day', layout: 'carousel' },
  },
  {
    authorKey: 'yusuf',
    asPageKey: 'memon',
    kind: 'video',
    body: 'Short clip from the floor — 16 heads running a saree job-work order. Three generations of zari work, same obsession with clean thread. #jobwork',
    hashtags: ['jobwork', 'zari'],
    media: { count: 1, kind: 'video', label: 'Job-work floor' },
  },
  {
    authorKey: 'kiran',
    asPageKey: 'kiran-tex',
    kind: 'photo',
    body: 'This week’s georgette saree catalogue is out. Mixed festive shades, embroidered borders, per-dozen wholesale. Transport all India daily. DM for the PDF.',
    media: { count: 6, kind: 'image', label: 'New catalogue', layout: 'carousel' },
  },
  {
    authorKey: 'kiran',
    asPageKey: 'kiran-tex',
    kind: 'document',
    body: 'Sharing our latest wholesale rate list (festive season). Per-dozen pricing for georgette and dress material. Regulars get credit terms.',
    media: { count: 1, kind: 'document', label: 'Rate list' },
  },
  {
    authorKey: 'haresh',
    kind: 'text',
    body: 'Grey georgette rates have softened a little this fortnight. Good time for embroidery units to stock base fabric before the festive rush. Container and small lots available.',
    hashtags: ['fabricmarket'],
  },
  {
    authorKey: 'priya',
    kind: 'text',
    body: 'Boutique owners — how are you handling bridal delivery timelines this season? I’m building a small set of reliable Surat partners. Quality over lowest price, always.',
    tags: ['Open to deals'],
  },
  {
    authorKey: 'anjali',
    kind: 'photo',
    body: 'Mood board for my next collection — pastel georgette, minimal thread embroidery, a little sequin catching light. Sourcing job-work partners now.',
    hashtags: ['designprocess'],
    media: { count: 4, kind: 'image', label: 'Mood board', layout: 'grid' },
  },
  {
    authorKey: 'sunita',
    kind: 'text',
    body: 'This week I placed 12 karigars and 3 operators across Surat units. If your workshop is short on hands before the festive rush, message me early — good people go fast.',
    tags: ['Hiring karigars'],
  },
  {
    authorKey: 'vikram',
    kind: 'text',
    body: 'Studying how traditional zari motifs are being simplified for modern machine embroidery. The paisley is getting cleaner lines but losing some of the old density. Following workshops here to learn more. #textiledesign',
    hashtags: ['textiledesign'],
  },
  {
    authorKey: 'meera',
    kind: 'photo',
    body: 'Before and after of a saree pallu restoration. Old zari was tarnished; we lifted it and re-did the border. Sometimes repair is harder than new work.',
    media: { count: 2, kind: 'image', label: 'Pallu restoration', layout: 'grid' },
  },
  {
    authorKey: 'yusuf',
    asPageKey: 'memon',
    kind: 'text',
    body: 'Reminder to job-work buyers: send us a 5-metre sample run before bulk. It saves everyone the heartburn of a 500 m order going wrong. Good units welcome this, not fear it.',
    hashtags: ['jobwork'],
  },
  {
    authorKey: 'firoz',
    kind: 'photo',
    body: 'Punched a heavy bridal jaal today on Wilcom — sequins and zari planned into one sequence so the machine runs without stopping for thread changes. Clean fills, almost no jump stitches. #digitizing #punching',
    hashtags: ['digitizing', 'punching'],
    media: { count: 2, kind: 'image', label: 'Punching layout', layout: 'grid' },
  },
  {
    authorKey: 'hasmukh',
    kind: 'text',
    body: 'Thekedar update: I have 8 trained karigars and 3 machine operators free from next week. If your unit is short before the festive rush, message me — I place people fast and I stand behind their work.',
    tags: ['Hiring karigars'],
  },
  {
    authorKey: 'jigna',
    kind: 'photo',
    body: 'Adda work in progress — zardozi border on a bridal pallu, full hand on the frame. Three of us on one adda, two days of work. #addawork #zardozi',
    tags: ['Open to work'],
    hashtags: ['addawork', 'zardozi'],
    media: { count: 3, kind: 'image', label: 'Adda zardozi', layout: 'carousel' },
  },
  {
    authorKey: 'ramesh',
    kind: 'text',
    body: 'A checker reminder: most returns are not bad embroidery — they are missed thread cuts and a careless press. Slow down on finishing and your buyer never argues. #finishing #quality',
    hashtags: ['finishing', 'quality'],
  },

  // ── Service-provider & allied-trade posts (chain expansion) ────────────
  {
    authorKey: 'hetal',
    kind: 'text',
    body: 'GST રિટર્ન ભરવાનું ભૂલશો નહીં — આ મહિને GSTR-1 ની છેલ્લી તારીખ 11 છે. ₹2,500 સુધીના પીસ પર 5% અને ઉપર 18%. બિલિંગ અત્યારથી સેટ કરી લો, festive rush માં ગૂંચવણ ન થાય.',
    hashtags: ['GST', 'SuratTextile'],
  },
  {
    authorKey: 'hetal',
    kind: 'text',
    body: 'Many small embroidery units file GST late and lose ITC they were entitled to. I help workshops keep books and e-way bills clean so credit never gets stuck. Free first review for Surat units — DM me.',
    hashtags: ['accounts', 'GST'],
  },
  {
    authorKey: 'hetal',
    kind: 'text',
    body: 'E-way bill reminder: any consignment over ₹50,000 needs one — even job-work fabric going out for embroidery. Generate it before the vehicle moves. Most penalties I see are just timing mistakes, not tax.',
    hashtags: ['ewaybill', 'compliance'],
  },
  {
    authorKey: 'nilesh',
    kind: 'text',
    body: 'If your turnover crossed the e-invoice threshold this year, your billing software must generate IRN + QR or buyers can lose ITC. Get it set up before the festive billing peak, not during it.',
    hashtags: ['einvoice', 'GST'],
  },
  {
    authorKey: 'mahesh',
    kind: 'text',
    body: 'Barudan ya Tajima head jam ho raha hai festive se pehle? Hook timing aur thread trimmer ki service abhi karwa lo — season me technician milna mushkil ho jata hai. AMC ke saath genuine spare bhi rakhta hoon.',
    hashtags: ['embroiderymachine', 'AMC'],
  },
  {
    authorKey: 'mahesh',
    kind: 'photo',
    body: 'Today: full service on a 12-head machine — cleaned the hooks, reset trimmer timing, replaced worn needles. Running smooth again before the saree job-work load picks up.',
    hashtags: ['machineservice', 'embroidery'],
    media: { count: 2, kind: 'image', label: 'Machine service', layout: 'grid' },
  },
  {
    authorKey: 'alpa',
    kind: 'photo',
    body: 'Catalogue ka pehla impression photo hi hota hai. Soft daylight setup pe georgette ka fall aur zari shine dono saaf aate hain. Is week 3 wholesale catalogues shoot kiye, WhatsApp-ready exports diye. DM for slots.',
    hashtags: ['sareephotography', 'catalogue'],
    media: { count: 4, kind: 'image', label: 'Catalogue shoot', layout: 'carousel' },
  },
  {
    authorKey: 'alpa',
    kind: 'text',
    body: 'Reseller tip: shoot your saree on a plain wall in morning light, fold the pallu to show the border, and keep the same angle for the whole catalogue. Consistency sells more than filters.',
    hashtags: ['cataloguetips', 'reselling'],
  },
  {
    authorKey: 'dilip',
    kind: 'text',
    body: 'Grey georgette rates thoda soft hue hain is fortnight. Embroidery units ke liye base fabric stock karne ka acha window hai festive rush se pehle. Container aur chhote lot dono available, Ring Road godown.',
    hashtags: ['greyfabric', 'SuratTextile'],
  },
  {
    authorKey: 'naran',
    kind: 'photo',
    body: 'Fresh batch off the line at the process house — digital print on georgette, colours matched to the trader’s sample. 8000 m/day keeps job-work moving for the festive ranges.',
    hashtags: ['dyeing', 'digitalprint'],
    media: { count: 2, kind: 'image', label: 'Process house floor', layout: 'grid' },
  },
  {
    authorKey: 'bharat',
    kind: 'text',
    body: 'Surat se Bengaluru, Hyderabad aur Delhi — daily parcel service, saree cartons safe packing ke saath. Festive me booking jaldi karo, trucks full chal rahe hain. Market se doorstep pickup bhi.',
    hashtags: ['logistics', 'SuratTextile'],
  },
  {
    authorKey: 'kruti',
    kind: 'photo',
    body: 'New stock of printed saree covers and gift boxes ready. Custom shop-name printing on covers from small quantities too — your sarees travel in your own brand. Wholesale rates for traders.',
    hashtags: ['packaging', 'sareecovers'],
    media: { count: 3, kind: 'image', label: 'Packaging range', layout: 'grid' },
  },
  {
    authorKey: 'reena',
    kind: 'text',
    body: 'આ સીઝનમાં pre-draped સાડી અને matching blouse ની માંગ બહુ વધી છે. અમારી આખી ટીમ — બધી બહેનો — ચોખ્ખું finishing કરે છે. Boutique અને resellers માટે bulk stitching લઈએ છીએ. અત્યારથી લાઇન ભરાવા લાગી છે.',
    hashtags: ['blousestitching', 'predrapedsaree'],
  },
  {
    authorKey: 'reena',
    kind: 'photo',
    body: 'Batch of designer blouses ready for a boutique order — piping, lining and hooks all done, pressed and sorted by size. Bulk stitching with clean finishing is what keeps buyers coming back.',
    hashtags: ['tailoring', 'blousestitching'],
    media: { count: 3, kind: 'image', label: 'Blouse batch', layout: 'grid' },
  },
  {
    authorKey: 'daxa',
    kind: 'text',
    body: 'Falls aur pico ka kaam ab ghar se — humari chhoti si team neat invisible pico aur colour-matched falls karti hai. Shops aur resellers ke liye jaldi batch ready. Market area me pickup-drop bhi ho jata hai.',
    hashtags: ['sareefalls', 'pico'],
  },
  {
    authorKey: 'ashok',
    kind: 'text',
    body: 'Gulf and US buyers are asking for lighter embroidered sarees and ready-to-ship dress material this quarter. If your unit has export-quality finishing, I handle the docs, LUT and container side. Let’s take Surat work overseas.',
    hashtags: ['export', 'SuratTextile'],
  },
  {
    authorKey: 'neha',
    kind: 'text',
    body: 'Looking for Surat units with fresh georgette designs and good catalogue photos for my online store — Instagram and Meesho. Small-quantity dispatch and on-time matter more to me than the lowest rate. DM if that’s you.',
    hashtags: ['reselling', 'sourcing'],
  },

  // ── Component & material posts (native language, market-researched) ─────
  {
    authorKey: 'rafiq',
    kind: 'photo',
    body: 'Naya stock aa gaya — cutdana, moti, sitara aur kasab ki fresh festive shades. Gold, silver aur antique teeno. Karigar bhai chhoti quantity bhi le sakte hain, units ke liye bulk rate. Gota lace borders bhi ready.',
    hashtags: ['cutdana', 'zari', 'embroiderymaterial'],
    media: { count: 4, kind: 'image', label: 'Material shades', layout: 'grid' },
  },
  {
    authorKey: 'jigna',
    kind: 'photo',
    body: 'આજનું કામ — bridal blouse પર cutdana, moti અને sitara નું હાથનું ભરતકામ. Dabka થી outline અને વચ્ચે zari fill. ધીરજનું કામ છે, પણ shine જબરજસ્ત આવે છે.',
    hashtags: ['cutdana', 'zardozi'],
    media: { count: 3, kind: 'image', label: 'Cutdana-moti hand work', layout: 'grid' },
  },
  {
    authorKey: 'meera',
    kind: 'text',
    body: 'Buyers ab poochhne lage hain — “yeh kaam haath ka hai ya machine ka, kitne din lage, kis karigar ne kiya”. Transparency hi naya premium hai. Apne karigar ka naam aur ghante batao, customer khushi se zyada deta hai.',
    hashtags: ['handwork', 'karigar'],
  },
  {
    authorKey: 'anjali',
    kind: 'text',
    body: 'For my next collection I’m mixing techniques the bridal way — zardozi borders, aari filling, a little gota patti and mirror work. Sourcing karigars who can do clean cutdana and dabka. Quality over lowest rate, always.',
    hashtags: ['zardozi', 'gotapatti', 'aari'],
  },

  // ── Fuller per-account activity (every account feels active) ───────────
  {
    authorKey: 'lakshmi',
    kind: 'photo',
    body: '60 dupatte is hafte dispatch ho gaye — sequins aur moti hand work, saari behno ne milke kiya. Festive ka contract kaam abhi le rahe hain, jaldi book karo.',
    hashtags: ['womenkarigars', 'handwork'],
    media: { count: 3, kind: 'image', label: 'Dupatta dispatch', layout: 'grid' },
  },
  {
    authorKey: 'lakshmi',
    kind: 'text',
    body: 'Hamari group me 2 nayi behne judi hain. Ab dress-material aur festive ka thoda bada batch bhi le sakte hain. Neat moti aur thread work, time pe delivery — yahi hamari pehchaan.',
    hashtags: ['contractwork', 'womenled'],
  },
  {
    authorKey: 'bhavna',
    kind: 'photo',
    body: 'Devi Creations me ek nayi schiffli machine lagayi — dress-material ke bade orders ab fast nikalenge. Quality wahi, capacity zyada. Bulk job-work welcome.',
    hashtags: ['dressmaterial', 'womenled'],
    media: { count: 2, kind: 'image', label: 'New schiffli machine', layout: 'grid' },
  },
  {
    authorKey: 'bhavna',
    kind: 'text',
    body: 'Is mahine 5 nayi behno ne hamare yahan kaam shuru kiya — gaon se aayi, ab khud kama rahi hain. Jab aap locally train karte ho, quality aur loyalty dono milti hai.',
    hashtags: ['womenempowerment', 'embroidery'],
  },
  {
    authorKey: 'haresh',
    kind: 'text',
    body: 'Crepe aur satin ki dyed stock fresh shades me aa gayi. Garment makers aur boutiques ke liye per-metre, min 500 m. Festive se pehle base stock kar lo, rate abhi theek hai.',
    hashtags: ['fabric', 'wholesale'],
  },
  {
    authorKey: 'haresh',
    kind: 'photo',
    body: 'Godown me naye grey aur finished rolls. Container aur chhote lot dono — Surat pickup ya transport. Regular buyers ko credit terms.',
    hashtags: ['greyfabric', 'surattextile'],
    media: { count: 2, kind: 'image', label: 'Fabric rolls', layout: 'grid' },
  },
  {
    authorKey: 'priya',
    kind: 'text',
    body: 'Building a small, reliable set of Surat partners for bridal blouses and lehenga panels. I pay fair and on time — I just need clean finishing and honest timelines. DM if that’s how you work.',
    hashtags: ['sourcing', 'bridal'],
  },
  {
    authorKey: 'priya',
    kind: 'photo',
    body: 'A few pieces from my Bengaluru boutique — hand-embroidered bridal blouses sourced from Surat karigars. Customers always ask who made it. Credit to the karigar matters.',
    hashtags: ['boutique', 'handwork'],
    media: { count: 3, kind: 'image', label: 'Boutique pieces', layout: 'carousel' },
  },
  {
    authorKey: 'sunita',
    kind: 'text',
    body: 'This week: placed 9 karigars and 4 machine operators across Varachha and Sachin units. Festive hiring is heating up — if you need hands, message me before the rush takes the good people.',
    hashtags: ['hiring', 'karigar'],
  },
  {
    authorKey: 'sunita',
    kind: 'text',
    body: 'Units keep asking me for good checking & finishing masters — that one role saves the most returns. If you do clean QC and finishing, send me your details, I place fast.',
    hashtags: ['placement', 'finishing'],
  },
  {
    authorKey: 'firoz',
    kind: 'photo',
    body: 'Heavy bridal jaal punched today — sequins aur zari ek hi sequence me, taaki machine bina ruke chale. Clean fills, almost no jump stitches. Job-work units ke liye digitizing karta hoon.',
    hashtags: ['digitizing', 'punching'],
    media: { count: 2, kind: 'image', label: 'Jaal punching layout', layout: 'grid' },
  },
  {
    authorKey: 'firoz',
    kind: 'text',
    body: 'Punching tip: design me thread changes minimize karo aur color sequence soch ke lagao — machine ka idle time aadha ho jata hai. Acha digitizing production ko seedha paisa bachata hai.',
    hashtags: ['embroiderydesign', 'wilcom'],
  },
  {
    authorKey: 'hasmukh',
    kind: 'text',
    body: 'Thekedar update: 8 trained karigar aur 3 operator agle hafte se free. Festive se pehle jis unit ko haath chahiye, message karo — main jaldi place karta hoon aur kaam ki guarantee leta hoon.',
    hashtags: ['karigarsupply', 'jobwork'],
  },
  {
    authorKey: 'hasmukh',
    kind: 'text',
    body: 'Bulk embroidery job-work bhi leta hoon — apne karigar groups se karwa ke deta hoon. Saree aur dress-material ke bade lots, fair rate, time pe delivery. Varachha-Sachin belt me 18 saal ka bharosa.',
    hashtags: ['jobwork', 'thekedar'],
  },
  {
    authorKey: 'ramesh',
    kind: 'photo',
    body: 'Aaj ka finished batch — thread cut, defect check, press aur pack, dispatch ke liye ready. Ek accha checker workshop ko returns se bachata hai.',
    hashtags: ['finishing', 'quality'],
    media: { count: 2, kind: 'image', label: 'Finished & packed', layout: 'grid' },
  },
  {
    authorKey: 'ramesh',
    kind: 'text',
    body: 'Checker ki seedhi baat: zyada tar returns kharab embroidery se nahi, balki missed thread cut aur careless press se hote hain. Finishing pe thoda dhyaan do, buyer kabhi argue nahi karega.',
    hashtags: ['qualitycontrol', 'finishing'],
  },
  {
    authorKey: 'dilip',
    kind: 'photo',
    body: 'Godown me fresh grey georgette aur chiffon rolls. Daily lots, consistent width aur GSM. Embroidery units ke liye container ya chhoti quantity dono — Ring Road se pickup.',
    hashtags: ['greyfabric', 'georgette'],
    media: { count: 2, kind: 'image', label: 'Grey rolls', layout: 'grid' },
  },
  {
    authorKey: 'dilip',
    kind: 'text',
    body: 'Embroidery-base yarn ki nayi lot aayi hai. Rate festive se pehle thoda soft chal raha hai — units ko advise karunga ki base ab stock kar lein, season me yarn upar jata hai.',
    hashtags: ['yarn', 'surattextile'],
  },
  {
    authorKey: 'naran',
    kind: 'text',
    body: 'Process house me festive ki booking khulni shuru ho gayi. Dyeing + digital print, colour matched to your sample, 8000 m/day. Slots jaldi bhar rahe hain — traders advance me book karein.',
    hashtags: ['dyeing', 'digitalprint'],
  },
  {
    authorKey: 'naran',
    kind: 'photo',
    body: 'Colour matching lab se aaj ke samples — trader ke shade card se bilkul match. Consistent shades hi process house ki asli pehchaan hai.',
    hashtags: ['colourmatching', 'processing'],
    media: { count: 2, kind: 'image', label: 'Shade samples', layout: 'grid' },
  },
  {
    authorKey: 'nilesh',
    kind: 'text',
    body: 'Festive billing peak aane se pehle apna billing software aur HSN codes check kar lo. Galat HSN ya late e-invoice se buyer ka ITC atak jata hai — chhoti si setting badi headache bacha deti hai.',
    hashtags: ['einvoice', 'GST'],
  },
  {
    authorKey: 'nilesh',
    kind: 'text',
    body: 'Traders ke liye reminder: e-way bill aur GSTR filing season me late mat karo. Main billing setup aur on-call support deta hoon taaki rush me compliance smooth rahe.',
    hashtags: ['compliance', 'billing'],
  },
  {
    authorKey: 'bharat',
    kind: 'text',
    body: 'Nayi route add ki — Surat se Kolkata aur Guwahati direct parcel. Saree cartons safe packing, doorstep pickup market se. Festive me trucks full chal rahe hain, booking jaldi.',
    hashtags: ['logistics', 'transport'],
  },
  {
    authorKey: 'bharat',
    kind: 'text',
    body: 'Transport tip: saree cartons me corner protection aur proper taping rakho, monsoon me waterproof cover. Damage-free delivery hi repeat business laati hai. Tracking har parcel pe.',
    hashtags: ['logistics', 'surattextile'],
  },
  {
    authorKey: 'kruti',
    kind: 'photo',
    body: 'Naye gift box aur printed saree cover designs ready. Festive ke liye premium look, custom shop-name printing chhoti quantity me bhi. Women-run unit, neat aur time pe.',
    hashtags: ['packaging', 'sareecovers'],
    media: { count: 3, kind: 'image', label: 'New box designs', layout: 'grid' },
  },
  {
    authorKey: 'kruti',
    kind: 'text',
    body: 'Apni sarees apne brand me bhejo — covers pe shop ka naam print karwa lo, customer ko yaad rehta hai. Wholesale rate traders ke liye, sample bhej sakte hain.',
    hashtags: ['branding', 'packaging'],
  },
  {
    authorKey: 'ashok',
    kind: 'text',
    body: 'Gulf aur US buyers is quarter lighter embroidered sarees aur ready-to-ship dress material maang rahe hain. Export-quality finishing wale units ke liye main docs, LUT aur container side sambhalta hoon.',
    hashtags: ['export', 'surattextile'],
  },
  {
    authorKey: 'ashok',
    kind: 'text',
    body: 'Export tip: pehli baar export kar rahe ho toh LUT file kar lo, IGST blocked nahi hoga. Packing list aur HS codes saaf rakho. Documentation theek ho toh container clear jaldi hota hai.',
    hashtags: ['exportdocs', 'LUT'],
  },
  {
    authorKey: 'neha',
    kind: 'text',
    body: 'Online pe abhi light georgette aur organza sarees sabse fast move kar rahe hain, ₹800–1500 range. Reels me fall aur shine dikhao toh booking jaldi hoti hai. Surat units se fresh designs dhoond rahi hoon.',
    hashtags: ['reselling', 'onlinesaree'],
  },
  {
    authorKey: 'neha',
    kind: 'text',
    body: 'Resellers ke liye seedhi baat: small-quantity dispatch aur on-time matter karta hai, lowest rate se zyada. Reliable unit mil jaye toh main long-term chalti hoon. DM karo agar aap wahi ho.',
    hashtags: ['sourcing', 'meesho'],
  },
  {
    authorKey: 'rafiq',
    kind: 'photo',
    body: 'Sitara aur sequins ki nayi shades aa gayi — gold, silver aur multi-colour, metal aur plastic dono finish. Aari, zardozi aur machine work ke liye. Bulk pack aur chhoti quantity dono.',
    hashtags: ['sitara', 'sequins'],
    media: { count: 4, kind: 'image', label: 'Sitara & sequins shades', layout: 'grid' },
  },
  {
    authorKey: 'rafiq',
    kind: 'text',
    body: 'Kasab/zari thread aur gota lace borders fresh stock me — antique aur bright dono shades. Karigar bhai counter se le sakte hain, units ke liye bulk rate. Cutdana, moti sab ready.',
    hashtags: ['kasab', 'gota'],
  },
  {
    authorKey: 'imran',
    kind: 'text',
    body: 'Aari blouse ka kaam abhi 3-4 din ka lead chal raha hai — festive se pehle line bhar rahi hai. Clean dabka aur sitara, fine finishing. Advance do toh slot pakka.',
    hashtags: ['aari', 'bridal'],
  },
  {
    authorKey: 'suresh',
    kind: 'text',
    body: 'Abhi bhi steady multi-needle operator job dhoond raha hoon, Varachha ya Sachin. Barudan aur Tajima dono pe comfortable, turant join kar sakta hoon. Kisi unit ko chahiye toh DM karein.',
    hashtags: ['jobsearch', 'machineoperator'],
  },
  {
    authorKey: 'yusuf',
    kind: 'photo',
    body: '16-head floor festive load ke liye ready. Per-metre zari job-work — saree, lehenga, dupatta. Teen peedhi se same obsession: clean thread, fast turnaround.',
    hashtags: ['jobwork', 'zari'],
    media: { count: 2, kind: 'image', label: 'Job-work floor', layout: 'grid' },
  },
  {
    authorKey: 'kiran',
    kind: 'photo',
    body: 'Is hafte ka naya georgette catalogue — mixed festive shades, embroidered borders, per-dozen wholesale. All-India transport daily. PDF ke liye DM karo.',
    hashtags: ['wholesalesaree', 'catalogue'],
    media: { count: 6, kind: 'image', label: 'New catalogue', layout: 'carousel' },
  },
  {
    authorKey: 'anjali',
    kind: 'text',
    body: 'Collection progress: pastel organza base lock ho gaya, ab thread aur light sequin samples aa rahe hain. Job-work partner chahiye jo minimal, clean work time pe de. Quality first.',
    hashtags: ['designer', 'organza'],
  },
  {
    authorKey: 'vikram',
    kind: 'text',
    body: 'Aaj seekha: ek hi motif machine pe kaise simplify hota hai vs haath pe. Density kam hoti hai par speed badh jaati hai. In dono ka balance hi asli design skill hai. Workshops follow kar raha hoon seekhne ke liye.',
    hashtags: ['textiledesign', 'learning'],
  },
  {
    authorKey: 'jigna',
    kind: 'text',
    body: 'Adda કામ માટે હમણાં slot ખુલ્લા છે — zardozi, dabka, moti અને sitara, frame પર હાથનું કામ. Bridal blouse અને pallu. છ બહેનોની ટીમ, advance આપો તો line માં place મળે.',
    hashtags: ['addawork', 'zardozi'],
  },
  {
    authorKey: 'mahesh',
    kind: 'text',
    body: 'Genuine spare stock me hain — hooks, rotary trimmers, needles, tension assemblies. Festive se pehle apni machine ka ek service round karwa lo, season me breakdown sabse mehenga padta hai.',
    hashtags: ['spares', 'machineservice'],
  },
  {
    authorKey: 'alpa',
    kind: 'photo',
    body: 'Behind the scenes — ek wholesale catalogue shoot, soft daylight setup. Georgette ka fall aur zari shine camera me aane ke liye lighting hi sab kuch hai. Slots ke liye DM.',
    hashtags: ['sareephotography', 'bts'],
    media: { count: 3, kind: 'image', label: 'Shoot setup', layout: 'grid' },
  },
  {
    authorKey: 'reena',
    kind: 'text',
    body: 'Stitching unit માં હમણાં designer blouse અને pre-draped સાડીની line full ચાલે છે. Boutique અને reseller માટે bulk લઈએ છીએ, size પ્રમાણે clean finishing. Tailor બહેનોની જરૂર છે — અનુભવ હોય તો સંપર્ક કરો.',
    hashtags: ['blousestitching', 'hiring'],
  },

  // ── Companies, institutes & design students (posts) ────────────────────
  {
    authorKey: 'manish',
    asPageKey: 'vraj',
    kind: 'photo',
    body: 'New festive collection off our floor at Vraj Creations — embroidered georgette in this season’s lighter shades. Manufacturer-direct for wholesalers and exporters. Catalogue on WhatsApp.',
    hashtags: ['designersaree', 'surattextile'],
    media: { count: 5, kind: 'image', label: 'Festive collection', layout: 'carousel' },
  },
  {
    authorKey: 'manish',
    asPageKey: 'vraj',
    kind: 'text',
    body: 'We’re expanding our design team — hiring a fashion designer, a merchandiser and 3 design interns this season. If you love festive and bridal saree work, come build collections with us. Details on our jobs.',
    hashtags: ['hiring', 'fashiondesign'],
  },
  {
    authorKey: 'paresh',
    asPageKey: 'suremb',
    kind: 'photo',
    body: 'Installed a new Tajima 15-head at a Sachin unit this week — supplied, installed and operators trained on site. Festive capacity sorted before the rush. New and certified pre-owned machines available.',
    hashtags: ['embroiderymachine', 'tajima'],
    media: { count: 2, kind: 'image', label: 'Machine install', layout: 'grid' },
  },
  {
    authorKey: 'paresh',
    asPageKey: 'suremb',
    kind: 'text',
    body: 'Buying your first embroidery machine? Certified pre-owned Barudan/Tajima are a smart entry — serviced, tested and installed with training. AMC ke saath spare bhi. Festive se pehle plan kar lo.',
    hashtags: ['embroiderymachine', 'machinedealer'],
  },
  {
    authorKey: 'anita',
    asPageKey: 'sifd',
    kind: 'photo',
    body: 'Final-year showcase at Surat Institute of Fashion & Design — our students presented festive and bridal collections to local manufacturers. Proud of this batch. Admissions open for the new term.',
    hashtags: ['fashiondesign', 'students'],
    media: { count: 4, kind: 'image', label: 'Student showcase', layout: 'carousel' },
  },
  {
    authorKey: 'anita',
    asPageKey: 'sifd',
    kind: 'text',
    body: 'Placement update: 18 of our students interned with Surat manufacturers and boutiques this season, several offered full-time roles. If your unit wants design interns, message us — talented hands looking to learn the trade.',
    hashtags: ['placements', 'internship'],
  },
  {
    authorKey: 'rohit',
    asPageKey: 'zariya',
    kind: 'text',
    body: 'Naya batch shuru — multi-head machine operator aur Wilcom punching course, dono job-ready. Course ke baad Surat units me placement karwate hain. Karigar bhai jo better-paid machine/design role me jaana chahte hain, unke liye sahi mauka.',
    hashtags: ['embroiderytraining', 'placement'],
  },
  {
    authorKey: 'rohit',
    asPageKey: 'zariya',
    kind: 'photo',
    body: 'Training floor pe aaj ke learners — multi-head machine pe practice aur Wilcom pe punching. 6 hafte me job-ready. Units ko trained operator chahiye toh humse batch bookings le sakte hain.',
    hashtags: ['training', 'punching'],
    media: { count: 2, kind: 'image', label: 'Training floor', layout: 'grid' },
  },
  {
    authorKey: 'khushi',
    kind: 'photo',
    body: 'A few pages from my portfolio — a festive saree line I designed this term, hand sketches plus Illustrator renders. Final-year student, looking for an internship with a Surat manufacturer or designer. Feedback welcome!',
    hashtags: ['fashiondesign', 'portfolio'],
    media: { count: 4, kind: 'image', label: 'Portfolio — festive line', layout: 'carousel' },
  },
  {
    authorKey: 'khushi',
    kind: 'text',
    body: 'Learning so much following Surat workshops and karigars here — seeing how a sketch actually becomes zari and cutdana on fabric is different from the classroom. If anyone takes design interns this season, I’d love to learn on a real floor.',
    hashtags: ['student', 'internship'],
  },
  {
    authorKey: 'aditya',
    kind: 'photo',
    body: 'Print exploration — turning a traditional paisley motif into a clean repeat for georgette, done in CorelDRAW. Studying how dense zari motifs simplify for machine embroidery without losing character.',
    hashtags: ['textiledesign', 'motifs'],
    media: { count: 3, kind: 'image', label: 'Paisley repeat', layout: 'grid' },
  },
  {
    authorKey: 'aditya',
    kind: 'text',
    body: 'Textile design student here — open to internships and live projects on prints, motifs and repeats for sarees and dress material. Photoshop and CorelDRAW, fast with colourways. Keen to work with a Surat manufacturer or designer.',
    hashtags: ['textiledesign', 'internship'],
  },
  {
    authorKey: 'riya',
    kind: 'text',
    body: 'Wrapped a festive saree collection for a Surat manufacturer — concept, mood board, tech packs and sampling. Freelance designers: get your tech packs tight, it saves the sampling team days. Open for the next collection.',
    hashtags: ['fashiondesign', 'freelance'],
  },
  {
    authorKey: 'riya',
    kind: 'photo',
    body: 'Mood board for an autumn festive line — muted georgette, minimal thread work, a little sequin to catch light. Now sourcing job-work partners for sampling. Manufacturers, DM if you want a fresh collection designed end to end.',
    hashtags: ['moodboard', 'collection'],
    media: { count: 4, kind: 'image', label: 'Mood board', layout: 'grid' },
  },
  {
    authorKey: 'saurabh',
    kind: 'photo',
    body: 'Turned a designer’s hand sketch into a production-ready saree layout today — repeat, placement and three colourways in CorelDRAW. Manufacturers, clean CAD files mean fewer sampling mistakes. Freelance CAD for the saree trade.',
    hashtags: ['CADdesign', 'saree'],
    media: { count: 3, kind: 'image', label: 'Saree layout + colourways', layout: 'grid' },
  },
  {
    authorKey: 'saurabh',
    kind: 'text',
    body: 'CAD designer for sarees — layouts, repeats, colourways aur hand sketch ko production file me convert. Photoshop, Illustrator, CorelDRAW. Fast turnaround manufacturers aur exporters ke liye. Freelance ya monthly dono.',
    hashtags: ['CADdesign', 'freelance'],
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Comments — a pool the seed sprinkles onto posts (varied, on-trade voice)
 * ──────────────────────────────────────────────────────────────────────── */

export const COMMENTS: string[] = [
  'Beautiful work. Very clean finishing.',
  'Kya baat hai 👌 finishing top class.',
  'Rate kya rahega per piece? DM kar raha hoon.',
  'This is the standard we should all aim for.',
  'Khup sundar! Border ekdum sharp aahe.',
  'Interested for bulk. Will message you.',
  'Reverse side bhi itna saaf — that’s skill.',
  'Following for more such work.',
  'Festive season ke liye perfect timing.',
  'Can you do this on georgette base too?',
  'Great to see a women-led unit growing.',
  'Sample dekh ke order karunga, looks promising.',
  'Thread quality clearly premium. Noted.',
  'Bohot badhiya, keep it up 🙏',
  'Timeline kya rehta hai 200m ke liye?',
];

/* ────────────────────────────────────────────────────────────────────────
 * Market topics — the auto-poster rotation.
 *
 * Each is a self-contained "market pulse" post a workshop / trade page would
 * share. The auto-poster cycles these (skipping recently-used ones) and can
 * fold in a freshly-researched line at runtime. `image` picks the generator.
 * ──────────────────────────────────────────────────────────────────────── */

export interface MarketTopic {
  id: string;
  season?: 'festive' | 'wedding' | 'summer' | 'monsoon' | 'any';
  body: string;
  hashtags: string[];
  tags?: string[];
  image: 'work' | 'product' | 'poster' | 'none';
  /** Prefer an author of this type when posting (falls back to any owner/trader). */
  preferType?: PersonaType;
}

export const MARKET_TOPICS: MarketTopic[] = [
  {
    id: 'festive-demand',
    season: 'festive',
    body: 'Festive season order books are filling fast across Surat embroidery units. If you are planning bulk zari work, lock your slot now — good machines get booked 3–4 weeks ahead.',
    hashtags: ['festiveseason', 'suratembroidery'],
    image: 'work',
    preferType: 'workshop_owner',
  },
  {
    id: 'wedding-bridal',
    season: 'wedding',
    body: 'Wedding-season bridal demand is leaning towards heavy zardozi pallus and lighter blouse work this year. Buyers want statement borders but breathable blouses. Plan your karigar mix accordingly.',
    hashtags: ['bridal', 'zardozi'],
    image: 'work',
    preferType: 'workshop_owner',
  },
  {
    id: 'cotton-price',
    body: 'Cotton and georgette base rates moved this fortnight. Units that stock base fabric early usually ride out the festive price spike better. Talk to your fabric trader before the rush.',
    hashtags: ['fabricmarket', 'rawmaterial'],
    image: 'product',
    preferType: 'trader',
  },
  {
    id: 'machine-tech',
    body: 'More Surat units are moving to higher-head machines for festive capacity. More heads is more output, but only if your thread changes and maintenance keep up. Capacity is a habit, not just a machine.',
    hashtags: ['embroiderymachine', 'capacity'],
    image: 'product',
    preferType: 'workshop_owner',
  },
  {
    id: 'design-trend-pastel',
    body: 'Pastel georgette with minimal thread-and-sequin embroidery keeps trending with designers this season. Less is selling more — clean motifs, lots of negative space, light hand on the sequin.',
    hashtags: ['designtrends', 'embroidery'],
    image: 'work',
  },
  {
    id: 'export-orders',
    body: 'Export enquiries for Indian embroidery are picking up again for the festive and wedding calendar abroad. If you can hold quality on repeat orders, this is a good window to chase export buyers.',
    hashtags: ['exports', 'textiletrade'],
    image: 'poster',
    preferType: 'trader',
  },
  {
    id: 'gst-eway',
    body: 'Quick reminder to traders: keep your e-way bills and HSN codes clean this season. A held truck during the festive rush costs more than the paperwork ever will.',
    hashtags: ['gst', 'compliance'],
    image: 'none',
    preferType: 'trader',
  },
  {
    id: 'karigar-skill',
    body: 'The real bottleneck this season is not machines, it is skilled hands. Units that train helpers into operators now will not be begging for labour in two months. Invest in people early.',
    hashtags: ['karigar', 'skilling'],
    image: 'none',
    preferType: 'workshop_owner',
  },
  {
    id: 'sustainability',
    body: 'Buyers are starting to ask about thread waste and water use, especially export buyers. Small steps — reclaiming thread, cleaner dyeing partners — are becoming a selling point, not just a cost.',
    hashtags: ['sustainability', 'textiles'],
    image: 'poster',
  },
  {
    id: 'sample-discipline',
    body: 'A 5-metre sample run before every bulk job-work order is the cheapest insurance in this trade. It aligns thread, density and colour before 500 metres are on the machine. Make it a rule.',
    hashtags: ['jobwork', 'quality'],
    image: 'work',
    preferType: 'workshop_owner',
  },
  {
    id: 'payment-terms',
    body: 'Healthy job-work runs on clear terms: advance percentage, dispatch window, rework policy — agreed in writing before the machine starts. Trust is good; a one-line confirmation is better.',
    hashtags: ['jobwork', 'business'],
    image: 'none',
    preferType: 'workshop_owner',
  },
  {
    id: 'festive-catalogue',
    season: 'festive',
    body: 'Fresh festive saree catalogues are dropping across the Surat market this week. Mixed georgette shades with embroidered borders are moving fastest at wholesale. Ask your supplier for the new PDF.',
    hashtags: ['saree', 'wholesale'],
    image: 'product',
    preferType: 'trader',
  },
  {
    id: 'summer-light',
    season: 'summer',
    body: 'Summer demand leans to lighter work — chikan-style thread, fine sequin, breathable bases. Heavy zardozi slows down till the wedding calendar returns. Plan your floor mix for the season.',
    hashtags: ['summerwear', 'embroidery'],
    image: 'work',
  },
  {
    id: 'monsoon-logistics',
    season: 'monsoon',
    body: 'Monsoon means longer transport times and damp-sensitive packing. Wrap finished zari well and pad your delivery promises a day or two. Buyers remember a safe, on-time parcel.',
    hashtags: ['logistics', 'dispatch'],
    image: 'none',
    preferType: 'trader',
  },
  {
    id: 'new-buyers',
    body: 'Tip for workshops: a clean profile with real work photos and a clear rate range gets you more serious enquiries than the lowest price ever will. Show your reverse side, show your range.',
    hashtags: ['workshop', 'growth'],
    image: 'work',
    preferType: 'workshop_owner',
  },
];
