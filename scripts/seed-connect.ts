/**
 * seed:connect — demo content for Zari360 Connect.
 *
 * Builds a believable Surat / Gujarat textile community so the platform never
 * looks empty at launch: a full cast covering every account type the product
 * supports, with profiles, a populated feed (all post kinds), a people network,
 * company pages, storefronts, marketplace listings, jobs, RFQs and inbox
 * threads — all cross-wired so every Connect surface demos with real content.
 *
 * Cast (see scripts/connect-demo/content.ts):
 *   • karigars (workers)      — incl. a deliberately near-empty "day 1" profile
 *   • workshop owners         — one is ERP-linked, so the moat badge lights up
 *   • traders / wholesalers   — company pages + storefronts + listings
 *   • buyers + a designer     — post RFQs, send inquiries
 *   • a staffing recruiter    — posts jobs, places people
 *   • an explorer (student)   — follows, posts, no business surfaces
 *
 * Demo accounts are tagged by the `@connect-demo.zari360.test` email domain and
 * the run is idempotent: it removes the prior demo set first, then rebuilds it.
 * Imagery is self-contained (inline SVG / data URIs) — no external assets.
 *
 *   Run:  npm run seed:connect      (backend)
 *
 * Demo users have no password — sign in with the mobile number + dev mock OTP
 * (123456). Public profiles need no login: open /u/<handle>.
 *
 * Honesty: the web app shows a quiet "sample content" note on Connect surfaces
 * (see crewroster-web SampleContentNote) so this demo data is never mistaken
 * for real community activity.
 */
import mongoose, { Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';

import {
  loadEnv,
  connectMongo,
  getModels,
  purgeDemo,
  DEMO_DOMAIN,
  type DemoModels,
} from './connect-demo/models';
import * as img from './connect-demo/images';
import {
  PERSONAS,
  COMPANY_PAGES,
  STOREFRONTS,
  LISTINGS,
  JOBS,
  RFQS,
  POSTS,
  COMMENTS,
  type Persona,
} from './connect-demo/content';
import { slugify, buildPostMedia, createPost, addEngagement } from './connect-demo/helpers';
// ADR-0004: the consent version stamped on demo consent + entity-link records so
// demo badges still render under the new consent gate.
import { ERP_VERIFY_CONSENT_VERSION } from '../src/modules/connect/profile/erp-verification.constants';

/* ── profile-strength (mirrors ConnectProfileService.computeStrength) ────── */
function computeStrength(p: {
  headline: string;
  bio: string;
  banner: string;
  skills: string[];
  portfolio: unknown[];
  experience: unknown[];
  rateCard?: { dailyWage?: number; pieceRate?: number; monthly?: number };
}): number {
  let s = 0;
  if (p.headline.trim()) s += 15;
  if (p.bio.trim()) s += 15;
  if (p.banner.trim()) s += 10;
  if (p.skills.length >= 3) s += 20;
  if (p.portfolio.length >= 1) s += 20;
  if (p.experience.length >= 1) s += 10;
  const r = p.rateCard;
  if (r && (r.dailyWage || r.pieceRate || r.monthly)) s += 10;
  return s;
}

const yearStart = (y: number): Date => new Date(Date.UTC(y, 3, 1));
const HOUR = 3_600_000;
const DAY = 86_400_000;

function openToDetails(
  openTo: Persona['openTo'],
): Record<string, { detail: string; audience: string }> {
  const d: Record<string, { detail: string; audience: string }> = {};
  if (openTo.work)
    d.work = { detail: 'Available for job-work and daily-wage work', audience: 'all' };
  if (openTo.hiring)
    d.hiring = { detail: 'Hiring karigars and machine operators', audience: 'all' };
  if (openTo.deals) d.deals = { detail: 'Open to bulk and wholesale deals', audience: 'all' };
  if (openTo.customOrders)
    d.customOrders = { detail: 'Taking custom and bridal orders', audience: 'all' };
  return d;
}

/** Worker/owner personas show portfolio work; others don't. */
function portfolioFor(p: Persona): Array<Record<string, unknown>> {
  if (p.sparse) return [];
  if (p.type !== 'karigar' && p.type !== 'workshop_owner') return [];
  const captions =
    p.type === 'karigar'
      ? ['Bridal panel — hand finishing', 'Festive dupatta work']
      : ['Bulk saree pallu order', 'Multi-head zari run'];
  const n = p.type === 'workshop_owner' || p.skills.length >= 4 ? 2 : 1;
  return captions.slice(0, n).map((caption, i) => ({
    image: img.workPhoto(`${p.key}|pf|${i}`, caption),
    caption,
    machineType: i === 0 ? 'Multi-head' : 'Hand',
    workType: p.skills[0] ?? 'Embroidery',
  }));
}

async function seed(): Promise<void> {
  loadEnv();
  const masked = await connectMongo();
  console.log('[seed:connect] Connected to', masked);
  const m: DemoModels = getModels();

  const removed = await purgeDemo(m);
  if (removed > 0) console.log(`[seed:connect] Removed ${removed} prior demo user(s).`);

  /* ── Users ────────────────────────────────────────────────────────────
   * Every demo user carries an explicit lowercase handle (the public slug for
   * /u/<handle>); the deployed users.handle unique index is NOT sparse, so a
   * null handle would collide. The -demo suffix keeps them clear of real users.
   */
  // App-Lock PIN 000000 for every demo account — lets you (and the E2E suite)
  // sign in as any demo persona to post manually. Matches the seeded
  // owner/member test-account convention. Standard bcrypt (cost 12).
  const demoPinHash = bcrypt.hashSync('000000', 12);

  // Password login for demo accounts ONLY — sign in with mobile/email + this
  // password (no OTP needed). Applied solely to the @connect-demo.zari360.test
  // cast this seed builds; real users are never touched. Standard bcrypt (12).
  const demoPasswordHash = bcrypt.hashSync('Demo@1234', 12);

  const userId = new Map<string, Types.ObjectId>();
  const byKey = new Map<string, Persona>();
  for (const p of PERSONAS) byKey.set(p.key, p);

  for (const p of PERSONAS) {
    const u = await m.User.create({
      name: p.name,
      email: `${p.key}${DEMO_DOMAIN}`,
      mobile: p.mobile,
      handle: `${slugify(p.name)}-demo`,
      profilePicture: img.avatar(p.name),
      isDemo: true,
      pinHash: demoPinHash,
      pinSetAt: new Date(),
      passwordHash: demoPasswordHash,
      // Personas have accepted the Connect policy + finished onboarding so a
      // demo session lands straight in the app (no consent gate / redirect).
      connectPolicyAcceptedAt: new Date(),
      isEmailVerified: true,
      isMobileVerified: true,
      connectEnabled: true,
      hasWorkspace: Boolean(p.erpLinked),
    });
    userId.set(p.key, u._id as Types.ObjectId);
  }

  /* ── ERP workspaces (for the derived ERP-linked moat badge) ──────────── */
  const workspaceIdByOwner = new Map<string, Types.ObjectId>();
  for (const p of PERSONAS.filter((x) => x.erpLinked)) {
    const ownerId = userId.get(p.key);
    const ws = await m.Workspace.create({
      name: COMPANY_PAGES.find((c) => c.ownerKey === p.key)?.name ?? `${p.name} Workshop`,
      location: `${p.district}, ${p.state}`,
      ownerId,
    });
    await m.WorkspaceMember.create({
      workspaceId: ws._id,
      userId: ownerId,
      status: 'active',
      joinedAt: yearStart(2009),
    });
    // 6 attendance rows (> the >=5 threshold) with fresh createdAt → genuinely
    // ERP-linked via ErpLinkService (no faked badge).
    const teamMemberId = new Types.ObjectId();
    const attendance = Array.from({ length: 6 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setUTCHours(0, 0, 0, 0);
      return { workspaceId: ws._id, teamMemberId, date, status: 'present' };
    });
    await m.Attendance.insertMany(attendance);
    workspaceIdByOwner.set(p.key, ws._id as Types.ObjectId);
  }

  /* ── Connect profiles ─────────────────────────────────────────────────── */
  for (const p of PERSONAS) {
    const uid = userId.get(p.key);
    if (p.sparse) {
      // Day-1 profile — drives the empty-state / 0%-strength demo.
      await m.ConnectProfile.create({
        userId: uid,
        onboardedAt: new Date(),
        onboardingIntent: p.intent,
        openTo: p.openTo,
        visibility: 'public',
        contactPreference: p.contactPreference,
        district: p.city,
        strength: 0,
      });
      continue;
    }
    const banner = img.banner(p.key);
    const portfolio = portfolioFor(p);
    const experience = (p.experience ?? []).map((e) => ({
      workshop: e.workshop,
      role: e.role,
      from: yearStart(e.fromYear),
      to: e.toYear ? yearStart(e.toYear) : null,
      description: e.description ?? '',
    }));
    const profile = {
      userId: uid,
      headline: p.headline,
      bio: p.bio,
      banner,
      skills: p.skills,
      district: p.city,
      portfolio,
      experience,
      services: (p.services ?? []).map((s) => ({ title: s.title, note: s.note ?? '' })),
      rateCard: p.rateCard ?? {},
      openTo: p.openTo,
      openToDetails: openToDetails(p.openTo),
      contactPreference: p.contactPreference,
      visibility: 'public' as const,
      onboardedAt: new Date(),
      onboardingIntent: p.intent,
      // ADR-0004: the PROFILE ERP badge is consent-gated. An ERP-linked demo
      // persona grants consent so `ErpLinkService.getUserStatus` (which now
      // requires it) still lights the moat badge on their /u/[handle] page.
      ...(p.erpLinked
        ? {
            erpVerificationConsent: {
              status: 'granted' as const,
              grantedAt: new Date(),
              revokedAt: null,
              consentVersion: ERP_VERIFY_CONSENT_VERSION,
            },
          }
        : {}),
    };
    await m.ConnectProfile.create({
      ...profile,
      strength: computeStrength({ ...profile, rateCard: p.rateCard }),
    });
  }

  // A couple of recommendations (need real user ids).
  await m.ConnectProfile.updateOne(
    { userId: userId.get('meera') },
    {
      $push: {
        recommendations: {
          fromUserId: userId.get('rajesh'),
          text: 'Meera did beautiful zari work on our bridal orders. Excellent finishing, always on time.',
          createdAt: yearStart(2025),
        },
      },
    },
  );
  await m.ConnectProfile.updateOne(
    { userId: userId.get('imran') },
    {
      $push: {
        recommendations: {
          fromUserId: userId.get('meera'),
          text: 'Imran’s aari hand work is some of the cleanest I have seen. Reliable for premium pieces.',
          createdAt: yearStart(2025),
        },
      },
    },
  );

  /* ── Company pages ────────────────────────────────────────────────────── */
  const pageId = new Map<string, Types.ObjectId>();
  for (const c of COMPANY_PAGES) {
    const owner = byKey.get(c.ownerKey);
    // ADR-0004: the badge is now consent-gated. A demo ERP-linked page sets a
    // `verified` erpLink (linkedByUserId = the owner) so the badge still renders
    // under the new gate — matching what the real ownership-checked link writes.
    const erpWorkspaceId = c.erpLinked ? (workspaceIdByOwner.get(c.ownerKey) ?? null) : null;
    const page = await m.CompanyPage.create({
      ownerUserId: userId.get(c.ownerKey),
      slug: c.slug,
      name: c.name,
      logo: img.logo(c.name),
      banner: img.banner(c.key),
      about: c.about,
      // Institute pages (kind: 'institute') get the badge + Placements/Alumni tabs.
      kind: c.kind ?? 'business',
      ...(c.institutePanel ? { institutePanel: c.institutePanel } : {}),
      industryPanel: {
        specialization: c.specialization,
        machineCapacity: c.machineCapacity,
        production: c.production,
        languages: c.languages,
      },
      location: { district: owner.district, city: owner.city, state: owner.state },
      erpWorkspaceId,
      erpLink: erpWorkspaceId
        ? {
            status: 'verified',
            linkedByUserId: userId.get(c.ownerKey),
            linkedAt: new Date(),
            consentVersion: ERP_VERIFY_CONSENT_VERSION,
          }
        : null,
      visibility: 'public',
    });
    pageId.set(c.key, page._id as Types.ObjectId);
  }

  /* ── Institute wiring (needs page ids, so runs after the pages loop) ─────
   * Two profile back-links that make the institute Placements / Alumni tabs
   * demo with content (see connect-profile.service getInstitutePlacements /
   * getInstituteAlumni for the gates being satisfied here):
   *   • training[] credentials seeded as CONFIRMED + shareWithInstitute: true
   *     (the DPDP opt-in) — confirmed by the institute page's owner.
   *   • experience.companyPageKey resolved to the employer's CompanyPage id so
   *     a current job renders as a named employer card on Placements.
   */
  for (const p of PERSONAS) {
    const updates: Record<string, unknown> = {};
    if (p.training?.length) {
      updates.training = p.training.map((t) => {
        const inst = COMPANY_PAGES.find((c) => c.key === t.instituteKey);
        if (!inst)
          throw new Error(`training.instituteKey '${t.instituteKey}' not in COMPANY_PAGES`);
        return {
          id: new Types.ObjectId().toHexString(),
          instituteName: inst.name,
          companyPageId: pageId.get(t.instituteKey),
          course: t.course,
          completedAt: t.completedYear ? yearStart(t.completedYear) : null,
          confirmStatus: 'confirmed',
          confirmedAt: new Date(),
          confirmedByUserId: userId.get(inst.ownerKey),
          shareWithInstitute: true,
        };
      });
    }
    for (const e of p.experience ?? []) {
      if (!e.companyPageKey) continue;
      const pid = pageId.get(e.companyPageKey);
      if (!pid)
        throw new Error(`experience.companyPageKey '${e.companyPageKey}' not in COMPANY_PAGES`);
      // Positional-by-filter: only the matching experience entry gains the link.
      await m.ConnectProfile.updateOne(
        { userId: userId.get(p.key) },
        { $set: { 'experience.$[e].companyPageId': pid } },
        { arrayFilters: [{ 'e.workshop': e.workshop }] },
      );
    }
    if (Object.keys(updates).length) {
      await m.ConnectProfile.updateOne({ userId: userId.get(p.key) }, { $set: updates });
    }
  }

  /* ── Storefronts ──────────────────────────────────────────────────────── */
  const storeId = new Map<string, Types.ObjectId>();
  for (const s of STOREFRONTS) {
    const owner = byKey.get(s.ownerKey);
    // ADR-0004: same consent-gated link as company pages above.
    const storeErpWorkspaceId = byKey.get(s.ownerKey)?.erpLinked
      ? (workspaceIdByOwner.get(s.ownerKey) ?? null)
      : null;
    const shop = await m.Storefront.create({
      ownerUserId: userId.get(s.ownerKey),
      slug: s.slug,
      name: s.name,
      logo: img.logo(s.name),
      banner: img.banner(s.key),
      description: s.description,
      categories: s.categories,
      location: { district: owner.district, city: owner.city, state: owner.state },
      companyPageId: s.companyPageKey ? (pageId.get(s.companyPageKey) ?? null) : null,
      erpWorkspaceId: storeErpWorkspaceId,
      erpLink: storeErpWorkspaceId
        ? {
            status: 'verified',
            linkedByUserId: userId.get(s.ownerKey),
            linkedAt: new Date(),
            consentVersion: ERP_VERIFY_CONSENT_VERSION,
          }
        : null,
      visibility: 'public',
      isPrimary: true,
    });
    storeId.set(s.key, shop._id as Types.ObjectId);
  }

  /* ── Listings ─────────────────────────────────────────────────────────── */
  const listingDocs: Array<{ id: Types.ObjectId; ownerKey: string }> = [];
  for (let i = 0; i < LISTINGS.length; i += 1) {
    const l = LISTINGS[i];
    const owner = byKey.get(l.ownerKey);
    const doc = await m.Listing.create({
      ownerUserId: userId.get(l.ownerKey),
      storefrontId: storeId.get(l.storefrontKey),
      title: l.title,
      description: l.description,
      category: l.category,
      priceType: l.priceType,
      priceMin: l.priceMin ?? null,
      priceMax: l.priceMax ?? null,
      unit: l.unit,
      moq: l.moq ?? null,
      leadTimeDays: l.leadTimeDays ?? null,
      location: { district: owner.district, city: owner.city, state: owner.state },
      images: [
        img.productPhoto(l.category, `${l.ownerKey}|listing|${i}`),
        img.productPhoto(l.category, `${l.ownerKey}|listing|${i}|b`),
      ],
      specs: l.specs ?? [],
      tradeTerms: l.tradeTerms ?? {},
      tags: l.tags ?? [],
      status: 'active',
      moderationStatus: 'approved',
      // Denormalized demo flag the FE "Sample" badge + feed/search down-rank read.
      // Every record this seed creates is demo content (mirrors createPost +
      // post.schema). Keep in sync with connect:demo:restamp + migration 0048.
      isDemo: true,
    });
    listingDocs.push({ id: doc._id as Types.ObjectId, ownerKey: l.ownerKey });
  }

  /* ── Jobs ─────────────────────────────────────────────────────────────── */
  const jobDocs: Array<{ id: Types.ObjectId; ownerKey: string }> = [];
  for (const j of JOBS) {
    const owner = byKey.get(j.ownerKey);
    const doc = await m.Job.create({
      companyUserId: userId.get(j.ownerKey),
      companyPageId: j.companyPageKey ? (pageId.get(j.companyPageKey) ?? null) : null,
      title: j.title,
      description: j.description,
      responsibilities: j.responsibilities ?? [],
      category: j.category,
      role: j.role,
      wageType: j.wageType,
      wageMin: j.wageMin,
      wageMax: j.wageMax,
      openings: j.openings,
      location: { district: owner.district, city: owner.city, state: owner.state },
      skills: j.skills ?? [],
      machineType: j.machineType ?? '',
      employmentType: j.employmentType,
      experienceMin: j.experienceMin ?? null,
      shift: j.shift ?? null,
      workingDays: j.workingDays ?? '',
      languages: j.languages ?? [],
      benefits: j.benefits ?? [],
      closesAt: new Date(Date.now() + 30 * DAY),
      status: 'open',
      isDemo: true,
    });
    jobDocs.push({ id: doc._id as Types.ObjectId, ownerKey: j.ownerKey });
  }

  /* ── RFQs ─────────────────────────────────────────────────────────────── */
  const rfqId = new Map<string, Types.ObjectId>();
  for (let i = 0; i < RFQS.length; i += 1) {
    const r = RFQS[i];
    const buyer = byKey.get(r.buyerKey);
    const doc = await m.Rfq.create({
      buyerUserId: userId.get(r.buyerKey),
      title: r.title,
      description: r.description,
      category: r.category,
      quantity: r.quantity,
      unit: r.unit,
      budgetMin: r.budgetMin,
      budgetMax: r.budgetMax,
      neededBy: new Date(Date.now() + (r.neededInDays ?? 21) * DAY),
      location: { district: buyer.district, city: buyer.city, state: buyer.state },
      status: 'open',
      quotesCount: 0,
      isDemo: true,
    });
    rfqId.set(`${r.buyerKey}|${i}`, doc._id as Types.ObjectId);
  }
  const rfqKeys = Array.from(rfqId.keys()); // index-aligned with RFQS

  /* ── Quotes (owners / a karigar respond to RFQs) ──────────────────────── */
  async function quote(
    rfqKey: string,
    sellerKey: string,
    storeKey: string | null,
    price: number,
    lead: number,
    msg: string,
  ) {
    const rid = rfqId.get(rfqKey);
    if (!rid) return;
    await m.Quote.create({
      rfqId: rid,
      sellerUserId: userId.get(sellerKey),
      storefrontId: storeKey ? (storeId.get(storeKey) ?? null) : null,
      price,
      leadTimeDays: lead,
      message: msg,
      status: 'sent',
      isDemo: true,
    });
    const existing = await m.Rfq.findById(rid)
      .select('lowestQuotePrice quotesCount')
      .lean<{ lowestQuotePrice: number | null; quotesCount: number }>();
    const lowest =
      existing?.lowestQuotePrice == null ? price : Math.min(existing.lowestQuotePrice, price);
    await m.Rfq.updateOne(
      { _id: rid },
      { $set: { lowestQuotePrice: lowest }, $inc: { quotesCount: 1 } },
    );
  }
  // RFQS order: [priya bridal blouses, anjali 400m georgette, meera gold zari]
  await quote(
    rfqKeys[0],
    'meera',
    null,
    90000,
    25,
    'I can do fine aari + zardozi bridal blouses. Sample on request before bulk.',
  );
  await quote(
    rfqKeys[1],
    'yusuf',
    'memon-shop',
    19500,
    7,
    'Clean thread + light sequin on georgette, 400 m. Includes a sample run.',
  );
  await quote(
    rfqKeys[2],
    'rajesh',
    'mehta-shop',
    22000,
    6,
    'Includes fine finishing and delivery to Surat. Sample on request.',
  );

  /* ── Network: connections, pending requests, follows ──────────────────── */
  const conns: Array<[string, string]> = [
    ['meera', 'rajesh'],
    ['meera', 'imran'],
    ['rajesh', 'yusuf'],
    ['rajesh', 'bhavna'],
    ['bhavna', 'lakshmi'],
    ['kiran', 'haresh'],
    ['sunita', 'rajesh'],
    ['sunita', 'yusuf'],
    ['priya', 'meera'],
    ['anjali', 'bhavna'],
    ['imran', 'lakshmi'],
    ['rajesh', 'hasmukh'],
    ['meera', 'jigna'],
    ['yusuf', 'firoz'],
    ['rajesh', 'ramesh'],
  ];
  for (const [a, b] of conns) {
    const [userA, userB] = [userId.get(a), userId.get(b)].sort();
    await m.Connection.create({ userA, userB, since: new Date(Date.now() - 60 * DAY) });
  }

  const requests: Array<[string, string, string]> = [
    ['anand', 'rajesh', 'Namaste, I am looking for karigar work. I would like to connect.'],
    ['suresh', 'yusuf', 'Multi-needle operator, 3 years. Any openings at your unit?'],
    [
      'vikram',
      'meera',
      'Textile design student — I really admire your work, would love to connect.',
    ],
    [
      'priya',
      'imran',
      'Boutique owner from Bengaluru, interested in your aari work for bridal pieces.',
    ],
    ['firoz', 'yusuf', 'Punching designer (Wilcom). Happy to digitize for your job-work orders.'],
    ['ramesh', 'bhavna', 'Checking and finishing master. Looking for steady work at your unit.'],
  ];
  for (const [from, to, note] of requests) {
    await m.ConnectionRequest.create({
      fromUserId: userId.get(from),
      toUserId: userId.get(to),
      status: 'pending',
      note,
    });
  }

  const userFollows: Array<[string, string]> = [
    ['anand', 'meera'],
    ['anand', 'imran'],
    ['suresh', 'sunita'],
    ['suresh', 'meera'],
    ['vikram', 'meera'],
    ['vikram', 'imran'],
    ['vikram', 'bhavna'],
    ['vikram', 'anjali'],
    ['priya', 'meera'],
    ['priya', 'imran'],
    ['priya', 'yusuf'],
    ['priya', 'rajesh'],
    ['anjali', 'meera'],
    ['anjali', 'lakshmi'],
    ['anjali', 'bhavna'],
    ['lakshmi', 'meera'],
    ['lakshmi', 'bhavna'],
    ['imran', 'meera'],
    ['meera', 'imran'],
    ['bhavna', 'meera'],
    ['yusuf', 'meera'],
    ['rajesh', 'meera'],
    ['kiran', 'haresh'],
    ['haresh', 'kiran'],
    ['kiran', 'rajesh'],
    ['sunita', 'rajesh'],
    ['sunita', 'yusuf'],
    ['sunita', 'bhavna'],
    ['firoz', 'meera'],
    ['firoz', 'rajesh'],
    ['vikram', 'firoz'],
    ['yusuf', 'firoz'],
    ['hasmukh', 'rajesh'],
    ['hasmukh', 'sunita'],
    ['anand', 'hasmukh'],
    ['suresh', 'hasmukh'],
    ['jigna', 'meera'],
    ['jigna', 'bhavna'],
    ['priya', 'jigna'],
    ['anjali', 'jigna'],
    ['ramesh', 'rajesh'],
    ['suresh', 'ramesh'],
    // ── Chain-expansion service providers: give each followers + following ──
    ['rajesh', 'hetal'],
    ['bhavna', 'hetal'],
    ['yusuf', 'hetal'],
    ['kiran', 'nilesh'],
    ['rajesh', 'mahesh'],
    ['yusuf', 'mahesh'],
    ['bhavna', 'mahesh'],
    ['kiran', 'alpa'],
    ['anjali', 'alpa'],
    ['neha', 'alpa'],
    ['rajesh', 'dilip'],
    ['yusuf', 'naran'],
    ['kiran', 'bharat'],
    ['ashok', 'bharat'],
    ['kiran', 'kruti'],
    ['meera', 'reena'],
    ['priya', 'reena'],
    ['neha', 'reena'],
    ['bhavna', 'daxa'],
    ['kiran', 'ashok'],
    ['priya', 'neha'],
    ['hetal', 'rajesh'],
    ['hetal', 'kiran'],
    ['mahesh', 'rajesh'],
    ['alpa', 'meera'],
    ['alpa', 'kiran'],
    ['reena', 'bhavna'],
    ['reena', 'meera'],
    ['daxa', 'bhavna'],
    ['bharat', 'kiran'],
    ['neha', 'kiran'],
    ['ashok', 'yusuf'],
    ['dilip', 'rajesh'],
    ['naran', 'yusuf'],
    ['kruti', 'kiran'],
    ['nilesh', 'kiran'],
    // Embroidery-material supplier — karigars & units follow him for stock
    ['meera', 'rafiq'],
    ['imran', 'rafiq'],
    ['jigna', 'rafiq'],
    ['lakshmi', 'rafiq'],
    ['rajesh', 'rafiq'],
    ['yusuf', 'rafiq'],
    ['rafiq', 'kiran'],
    ['rafiq', 'rajesh'],
    // Companies, institutes, design students & freelance designers
    ['khushi', 'anita'],
    ['aditya', 'anita'],
    ['khushi', 'manish'],
    ['khushi', 'meera'],
    ['khushi', 'riya'],
    ['aditya', 'saurabh'],
    ['aditya', 'firoz'],
    ['riya', 'manish'],
    ['saurabh', 'manish'],
    ['saurabh', 'kiran'],
    ['anjali', 'riya'],
    ['priya', 'manish'],
    ['neha', 'manish'],
    ['rajesh', 'paresh'],
    ['yusuf', 'paresh'],
    ['manish', 'riya'],
    ['manish', 'saurabh'],
    ['manish', 'rajesh'],
    ['anita', 'manish'],
    ['rohit', 'rajesh'],
    ['suresh', 'rohit'],
    ['anand', 'rohit'],
    ['vikram', 'anita'],
    ['vikram', 'khushi'],
    ['paresh', 'rajesh'],
    ['riya', 'anjali'],
    ['khushi', 'anjali'],
    ['manish', 'kiran'],
  ];
  const followersOfUser = new Map<string, Types.ObjectId[]>();
  for (const [f, t] of userFollows) {
    await m.Follow.create({
      followerId: userId.get(f),
      followeeType: 'user',
      followeeId: userId.get(t),
    });
    (followersOfUser.get(t) ?? followersOfUser.set(t, []).get(t)).push(userId.get(f));
  }

  const pageFollows: Array<[string, string]> = [
    ['meera', 'mehta'],
    ['anand', 'mehta'],
    ['priya', 'mehta'],
    ['vikram', 'devi'],
    ['lakshmi', 'devi'],
    ['anjali', 'devi'],
    ['priya', 'memon'],
    ['suresh', 'memon'],
    ['meera', 'memon'],
    ['haresh', 'kiran-tex'],
    ['anjali', 'kiran-tex'],
    ['vikram', 'kiran-tex'],
    ['firoz', 'memon'],
    ['hasmukh', 'mehta'],
    ['jigna', 'devi'],
    ['ramesh', 'mehta'],
    // New company / institute pages: brand, machine dealer, design schools
    ['kiran', 'vraj'],
    ['priya', 'vraj'],
    ['neha', 'vraj'],
    ['anjali', 'vraj'],
    ['riya', 'vraj'],
    ['saurabh', 'vraj'],
    ['rajesh', 'suremb'],
    ['yusuf', 'suremb'],
    ['bhavna', 'suremb'],
    ['hasmukh', 'suremb'],
    ['khushi', 'sifd'],
    ['aditya', 'sifd'],
    ['vikram', 'sifd'],
    ['riya', 'sifd'],
    ['suresh', 'zariya'],
    ['anand', 'zariya'],
    ['imran', 'zariya'],
  ];
  const followersOfPage = new Map<string, Types.ObjectId[]>();
  for (const [f, pk] of pageFollows) {
    await m.Follow.create({
      followerId: userId.get(f),
      followeeType: 'companyPage',
      followeeId: pageId.get(pk),
    });
    (followersOfPage.get(pk) ?? followersOfPage.set(pk, []).get(pk)).push(userId.get(f));
  }

  /* ── Feed posts (all kinds) + engagement ──────────────────────────────── */
  const allUserIds = PERSONAS.map((p) => userId.get(p.key));
  const postedIds: Types.ObjectId[] = [];
  let firstMeeraPhoto: Types.ObjectId | null = null;
  let meeraTip: Types.ObjectId | null = null;
  let sunitaHiring: Types.ObjectId | null = null;

  for (let i = 0; i < POSTS.length; i += 1) {
    const ps = POSTS[i];
    const author = byKey.get(ps.authorKey);
    const authorUid = userId.get(ps.authorKey);
    const pageKey = ps.asPageKey;
    const companyPageId = pageKey ? (pageId.get(pageKey) ?? null) : null;
    const erpLinked = pageKey
      ? (COMPANY_PAGES.find((c) => c.key === pageKey)?.erpLinked ?? false)
      : Boolean(author.erpLinked);
    const built = buildPostMedia(ps, `${ps.authorKey}|post|${i}`);
    const recipients = pageKey
      ? (followersOfPage.get(pageKey) ?? [])
      : (followersOfUser.get(ps.authorKey) ?? []);
    // Spread posts over the last ~12 days, newest first.
    const when = new Date(Date.now() - i * 14 * HOUR - Math.floor((i % 3) * 90 * 60_000));

    const pid = await createPost(
      m,
      {
        authorId: authorUid,
        companyPageId,
        kind: ps.kind,
        body: ps.body,
        tags: ps.tags ?? [],
        hashtags: ps.hashtags ?? [],
        media: built.media,
        audio: built.audio,
        mediaLayout: built.mediaLayout,
        authorErpLinked: erpLinked,
        authorSkills: author.skills,
        authorDistrict: author.city,
        when,
      },
      recipients,
    );
    postedIds.push(pid);
    if (ps.authorKey === 'meera' && ps.kind === 'photo' && !firstMeeraPhoto) firstMeeraPhoto = pid;
    if (ps.authorKey === 'meera' && ps.kind === 'text' && !meeraTip) meeraTip = pid;
    if (ps.authorKey === 'sunita' && !sunitaHiring) sunitaHiring = pid;

    // Engagement: a few likes + up to 2 comments from other personas.
    const others = allUserIds.filter((u) => String(u) !== String(authorUid));
    const likeCount = 2 + ((i * 7) % 5); // 2..6, deterministic
    const reactors = others
      .slice((i * 3) % Math.max(1, others.length))
      .concat(others)
      .slice(0, likeCount);
    const commentCount = i % 3 === 0 ? 2 : i % 3 === 1 ? 1 : 0;
    const comments = Array.from({ length: commentCount }, (_, k) => ({
      authorId: others[(i * 5 + k * 3) % others.length],
      body: COMMENTS[(i * 4 + k) % COMMENTS.length],
    }));
    await addEngagement(m, pid, reactors, comments);
  }

  /* ── Reposts (a couple, for the repost demo) ──────────────────────────── */
  if (meeraTip) {
    await createPost(
      m,
      {
        authorId: userId.get('vikram'),
        kind: 'text',
        body: '',
        repostOf: meeraTip,
        authorDistrict: 'Gandhinagar',
        when: new Date(Date.now() - 6 * HOUR),
      },
      followersOfUser.get('vikram') ?? [],
    );
    await m.Post.updateOne({ _id: meeraTip }, { $inc: { repostCount: 1 } });
  }
  if (sunitaHiring) {
    await createPost(
      m,
      {
        authorId: userId.get('suresh'),
        kind: 'text',
        body: '',
        repostOf: sunitaHiring,
        authorDistrict: 'Surat',
        when: new Date(Date.now() - 4 * HOUR),
      },
      followersOfUser.get('suresh') ?? [],
    );
    await m.Post.updateOne({ _id: sunitaHiring }, { $inc: { repostCount: 1 } });
  }

  /* ── Job applications ─────────────────────────────────────────────────── */
  const operatorJob = jobDocs[0]; // Rajesh — multi-needle operators
  await m.JobApplication.create({
    jobId: operatorJob.id,
    applicantUserId: userId.get('anand'),
    message: 'I have 2 years on multi-needle machines. Available immediately.',
    status: 'applied',
    isDemo: true,
  });
  const sureshApp = await m.JobApplication.create({
    jobId: operatorJob.id,
    applicantUserId: userId.get('suresh'),
    message: '3 years on Barudan and Tajima. Can join this week. Varachha is easy for me.',
    status: 'shortlisted',
    isDemo: true,
  });
  await m.Job.updateOne({ _id: operatorJob.id }, { $set: { applicationsCount: 2 } });
  // Helper applies to Sunita's placement post
  const sunitaJob = jobDocs.find((j) => j.ownerKey === 'sunita');
  if (sunitaJob) {
    await m.JobApplication.create({
      jobId: sunitaJob.id,
      applicantUserId: userId.get('anand'),
      message: 'Ready to start as helper/trainee. Willing to learn machine work.',
      status: 'applied',
      isDemo: true,
    });
    await m.Job.updateOne({ _id: sunitaJob.id }, { $set: { applicationsCount: 1 } });
  }

  /* ── Inquiries (buyer questions on listings) ──────────────────────────── */
  const mehtaGoldZari = listingDocs.find((l) => l.ownerKey === 'rajesh');
  const meeraInquiry = await m.Inquiry.create({
    listingId: mehtaGoldZari.id,
    buyerUserId: userId.get('meera'),
    sellerUserId: userId.get('rajesh'),
    message: 'Is the gold zari job-work available for 250 m this month?',
    status: 'replied',
  });
  await m.Inquiry.create({
    listingId: mehtaGoldZari.id,
    buyerUserId: userId.get('priya'),
    sellerUserId: userId.get('rajesh'),
    message: 'Can you ship finished zari borders to Bengaluru? Looking for 80 pieces.',
    status: 'sent',
  });

  /* ── Inbox: demo threads across the channels ──────────────────────────── */
  await seedThread(m, {
    a: userId.get('anand'),
    b: userId.get('meera'),
    channelType: 'dm',
    messages: [
      {
        from: userId.get('anand'),
        body: 'Namaste Meera ji, main multi-head operator hoon. Kaam ke liye baat kar sakte hain?',
      },
      { from: userId.get('meera'), body: 'Haan zaroor. Kis type ka kaam dekha hai aapne?' },
      { from: userId.get('anand'), body: 'Bridal lehenga aur saree pallu, 2 saal ka experience.' },
    ],
  });
  await seedThread(m, {
    a: userId.get('meera'),
    b: userId.get('rajesh'),
    channelType: 'inquiry',
    contextEntityType: 'Inquiry',
    contextEntityId: meeraInquiry._id as Types.ObjectId,
    messages: [
      {
        from: userId.get('meera'),
        body: 'Is the gold zari job-work available for 250 m this month?',
      },
      {
        from: userId.get('rajesh'),
        body: 'Yes, 250 m is fine. 4 day turnaround once the fabric reaches us.',
      },
      { from: userId.get('meera'), body: 'Great. Can you send a sample of the border?' },
      {
        from: userId.get('rajesh'),
        kind: 'photo',
        media: [
          {
            url: img.workPhoto('inbox|sample', 'Border sample'),
            mime: 'image/svg+xml',
            width: 900,
            height: 600,
            scanStatus: 'clean',
          },
        ],
      },
    ],
  });
  await seedThread(m, {
    a: userId.get('rajesh'),
    b: userId.get('suresh'),
    channelType: 'application',
    contextEntityType: 'JobApplication',
    contextEntityId: sureshApp._id as Types.ObjectId,
    messages: [
      { from: userId.get('rajesh'), body: 'Aapki application dekhi. Kab se available ho?' },
      {
        from: userId.get('suresh'),
        body: 'Turant available hoon sir. Varachha aaram se pahunch jaata hoon.',
      },
    ],
  });
  await seedThread(m, {
    a: userId.get('priya'),
    b: userId.get('meera'),
    channelType: 'dm',
    messages: [
      {
        from: userId.get('priya'),
        body: 'Hi Meera, I run a bridal boutique in Bengaluru. Do you take small premium batches?',
      },
      {
        from: userId.get('meera'),
        body: 'Yes, I do. Bridal blouses and lehenga panels, fine finishing. Happy to send samples.',
      },
    ],
  });

  /* ── Summary ──────────────────────────────────────────────────────────── */
  const counts = {
    users: PERSONAS.length,
    pages: COMPANY_PAGES.length,
    stores: STOREFRONTS.length,
    listings: LISTINGS.length,
    jobs: JOBS.length,
    rfqs: RFQS.length,
    posts: postedIds.length + 2,
  };
  console.log('\n[seed:connect] Demo world created:');
  console.log(
    `  ${counts.users} people · ${counts.pages} company pages · ${counts.stores} storefronts`,
  );
  console.log(
    `  ${counts.listings} listings · ${counts.jobs} jobs · ${counts.rfqs} RFQs · ${counts.posts} feed posts`,
  );
  console.log('  Network: connections, pending invitations and follows wired across the cast.');
  console.log('  Inbox: 4 threads (DM, inquiry, application) with unread messages + a photo.');
  console.log('\n  Sign in with the mobile number + dev mock OTP 123456:');
  console.log(
    '    Meera (master karigar) 9100000001 · Anand (day-1) 9100000002 · Rajesh (owner, ERP) 9100000003',
  );
  console.log('    …and 9100000004–9100000014 for the rest of the cast.');
  console.log(
    '  Open /connect/feed, /connect/jobs, /connect/marketplace, /connect/rfq, /connect/network.\n',
  );

  await mongoose.disconnect();
  console.log('[seed:connect] Done.');
}

/* ── Inbox thread helper (denormalizes lastMessage + per-party unread) ───── */
interface SeedMsg {
  from: Types.ObjectId;
  body?: string;
  kind?: 'text' | 'photo' | 'voice';
  media?: Array<Record<string, unknown>>;
}
function sortPair(a: Types.ObjectId, b: Types.ObjectId): [Types.ObjectId, Types.ObjectId] {
  return String(a) < String(b) ? [a, b] : [b, a];
}
async function seedThread(
  m: DemoModels,
  opts: {
    a: Types.ObjectId;
    b: Types.ObjectId;
    channelType: 'dm' | 'inquiry' | 'application' | 'quote';
    contextEntityType?: 'Inquiry' | 'JobApplication' | 'Quote' | null;
    contextEntityId?: Types.ObjectId | null;
    messages: SeedMsg[];
  },
): Promise<void> {
  const [lo, hi] = sortPair(opts.a, opts.b);
  const ctxId = opts.contextEntityId ?? null;
  const pairKey =
    opts.channelType === 'dm'
      ? `${String(lo)}:${String(hi)}:dm`
      : `${String(lo)}:${String(hi)}:${opts.channelType}:${String(ctxId)}`;

  const thread = await m.Thread.create({
    pairKey,
    participantIds: [lo, hi],
    channelType: opts.channelType,
    contextEntityType: opts.contextEntityType ?? null,
    contextEntityId: ctxId,
    lastActivityAt: new Date(),
    messageSeq: 0,
    participants: [lo, hi].map((uid) => ({
      userId: uid,
      unreadCount: 0,
      lastReadSeq: 0,
      lastReadMessageId: null,
      archived: false,
      muted: false,
      lastReadAt: null,
    })),
    closed: false,
  });

  const baseTs = Date.now() - opts.messages.length * 90_000;
  let seq = 0;
  let last: {
    messageId: Types.ObjectId;
    senderUserId: Types.ObjectId;
    preview: string;
    kind: string;
    seq: number;
    createdAt: Date;
  } | null = null;
  for (let i = 0; i < opts.messages.length; i += 1) {
    const msg = opts.messages[i];
    seq += 1;
    const createdAt = new Date(baseTs + i * 90_000);
    const kind = msg.kind ?? 'text';
    const created = await m.Message.create({
      threadId: thread._id,
      senderUserId: msg.from,
      kind,
      seq,
      body: msg.body ?? '',
      media: msg.media ?? [],
      clientMsgId: `seed-${String(thread._id)}-${seq}`,
      seenBy: [],
    });
    last = {
      messageId: created._id as Types.ObjectId,
      senderUserId: msg.from,
      preview: (msg.body ?? '').slice(0, 140),
      kind,
      seq,
      createdAt,
    };
  }
  const participants = [lo, hi].map((uid) => ({
    userId: uid,
    unreadCount: opts.messages.filter((msg) => String(msg.from) !== String(uid)).length,
    lastReadSeq: 0,
    lastReadMessageId: null,
    archived: false,
    muted: false,
    lastReadAt: null,
  }));
  await m.Thread.updateOne(
    { _id: thread._id },
    {
      $set: {
        messageSeq: seq,
        lastMessage: last,
        lastActivityAt: last?.createdAt ?? new Date(),
        participants,
      },
    },
  );
}

seed().catch((err) => {
  console.error('[seed:connect] Error:', err);
  process.exit(1);
});
