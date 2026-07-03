/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose, { Schema as MongooseSchema, Model } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  createTestMongoose,
  stopTestMongoose,
  type TestMongo,
} from '../../../../test-utils/mongo-memory';
import { CreatePlanDto } from '../../dto/subscription.dto';

/**
 * Admin-editable plan-card copy — persistence + DTO contract for the per-plan
 * marketing CARD CONTENT (`marketing.tagline` + `marketing.featureHighlights`),
 * each a 4-locale LocalizedText ({ en, 'gu-en', 'hi-en', gu }).
 *
 * These fields drive the public ERP pricing card (ErpPricingTable) and the
 * in-app plans hub (PlanCard) via the FE `pickLocalized` resolver, falling back
 * to the static i18n copy when blank. This locks two guarantees:
 *   1. the marketing subdoc round-trips both fields with ALL four locales intact, and
 *   2. CreatePlanDto whitelists `marketing.tagline` + `.featureHighlights` so the
 *      global forbidNonWhitelisted pipe does NOT strip them on create/update.
 *
 * The round-trip uses a LOCAL mongoose schema that mirrors the real
 * LocalizedTextField + PlanMarketing subdoc (mirrors the repo workaround in
 * start-trial-supersede-objectid.integration.vitest.ts) — the full Plan schema
 * cannot be imported under the SWC test transform because many of its @Props use
 * inferred (untyped) decorators. The DTO test below exercises the REAL
 * PlanMarketingDto/LocalizedTextDto so the validation contract is covered for real.
 *
 * Cross-module link: web admin/plans editor sends marketing.tagline/.featureHighlights;
 * web ErpPricingTable + PlanCard render them with a static fallback.
 */

// One bullet / tagline expressed in all four supported locales.
const tagline4 = {
  en: 'For small teams getting organized',
  'gu-en': 'Nani teams mate je vyavasthit thava mange',
  'hi-en': 'Chhoti teams ke liye jo vyavasthit hona chahti hain',
  gu: 'નાની ટીમો માટે જે વ્યવસ્થિત થવા માગે',
};
const feature4 = {
  en: 'Staff records & profiles',
  'gu-en': 'Staff na record ane profile',
  'hi-en': 'Staff ke record aur profile',
  gu: 'સ્ટાફના રેકોર્ડ અને પ્રોફાઇલ',
};

// Local mirror of the real LocalizedTextField (plan.schema.ts): en required, the
// three other locales optional. Keep in sync with that subdoc.
const LocalizedTextField = new MongooseSchema(
  {
    en: { type: String, required: true },
    'gu-en': { type: String, default: null },
    'hi-en': { type: String, default: null },
    gu: { type: String, default: null },
  },
  { _id: false },
);

// Local mirror of the relevant slice of PlanMarketing (plan.schema.ts).
const PlanMarketing = new MongooseSchema(
  {
    tagline: { type: LocalizedTextField },
    featureHighlights: { type: [LocalizedTextField], default: [] },
  },
  { _id: false },
);

const PlanLocalSchema = new MongooseSchema({
  name: { type: String, required: true },
  marketing: { type: PlanMarketing, default: () => ({}) },
});

describe('Plan marketing card content (tagline + featureHighlights)', () => {
  let mongo: TestMongo;
  let model: Model<any>;

  beforeAll(async () => {
    mongo = await createTestMongoose();
    // Define-or-reuse so a re-run in the same process does not throw OverwriteModelError.
    model = (() => {
      try {
        return mongoose.model('PlanMarketingTest');
      } catch {
        return mongoose.model('PlanMarketingTest', PlanLocalSchema);
      }
    })();
    // 60s — mongodb-memory-server may download the binary on a fresh machine / CI.
  }, 60_000);

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  it('persists and reads back marketing.tagline + featureHighlights with all four locales', async () => {
    const created = await model.create({
      name: 'Free',
      marketing: {
        tagline: tagline4,
        featureHighlights: [feature4, { en: 'Daily attendance' }],
      },
    });

    // Re-read from the DB (not the in-memory create result) so we prove the
    // round-trip, not just object identity.
    const read = await model.findById(created._id).lean<any>().exec();

    expect(read.marketing.tagline).toMatchObject(tagline4);
    // First bullet keeps all four locales; second keeps en only (others optional).
    expect(read.marketing.featureHighlights[0]).toMatchObject(feature4);
    expect(read.marketing.featureHighlights[1].en).toBe('Daily attendance');
    expect(read.marketing.featureHighlights).toHaveLength(2);
  });

  it('CreatePlanDto whitelists marketing.tagline + featureHighlights (not stripped by forbidNonWhitelisted)', async () => {
    const dto = plainToInstance(CreatePlanDto, {
      name: 'Free',
      tier: 'free',
      monthlyPrice: 0,
      yearlyPrice: 0,
      entitlements: {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
        modules: [],
        features: {},
      },
      marketing: {
        tagline: tagline4,
        featureHighlights: [feature4],
      },
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
    // The nested 4-locale objects survive the class-transformer @Type mapping.
    expect((dto.marketing as any).tagline).toMatchObject(tagline4);
    expect((dto.marketing as any).featureHighlights[0]).toMatchObject(feature4);
  });

  it('rejects a tagline missing the required canonical en locale', async () => {
    const dto = plainToInstance(CreatePlanDto, {
      name: 'Free',
      tier: 'free',
      monthlyPrice: 0,
      yearlyPrice: 0,
      entitlements: {
        maxWorkspaces: 1,
        maxMembersPerWorkspace: 5,
        maxTotalMembers: 5,
        modules: [],
        features: {},
      },
      // en is required on LocalizedTextDto; a tagline with only gu must fail.
      marketing: { tagline: { gu: 'ગુજરાતી' } as any },
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
