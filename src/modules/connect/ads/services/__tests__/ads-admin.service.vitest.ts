/**
 * AdsAdminService -- TDD spec.
 *
 * RED phase: write failing assertions BEFORE any implementation.
 * Model mocks simulate Mongoose Model methods (find, findById, findOneAndUpdate, aggregate)
 * and save spies on loaded documents. WalletService.release and AuditService.logEvent
 * are replaced with vi.fn() spies.
 */

// Mock @nestjs/mongoose to noop decorators: importing AdsAdminService now pulls
// in NotificationsService -> the Notification schema, whose @Prop decorators
// trip vitest's reflect-metadata pipeline (union-typed fields). The service is
// constructed positionally with plain object mocks here, so the real decorators
// are not needed. (Same pattern as boost.service.listing.vitest.ts.)
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdsAdminService } from '../ads-admin.service';
import { AppModule } from '../../../../../common/enums/modules.enum';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObjectId() {
  return new Types.ObjectId();
}

/** Minimal mongoose-document stand-in with a save spy. */
function makeDoc<T extends Record<string, unknown>>(
  fields: T,
): T & { save: ReturnType<typeof vi.fn> } {
  return { ...fields, save: vi.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function buildService() {
  const campaignId = makeObjectId();
  const creativeId = makeObjectId();
  const placementId = makeObjectId();
  const adminUserId = makeObjectId().toHexString();
  const ownerUserId = makeObjectId().toHexString();

  const pendingCreative = makeDoc({
    _id: creativeId,
    reviewStatus: 'pending',
    reviewedBy: undefined,
    rejectionReason: undefined,
    campaignId,
    postRef: makeObjectId(),
    kind: 'promoted_post',
  });

  const activeCampaign = makeDoc({
    _id: campaignId,
    status: 'pending_review',
    ownerUserId,
    kind: 'boost_listing',
    objective: 'reach',
    totalBudget: 500,
    budgetSpent: 120,
    // 7-day flight so durationDays resolves to a stable 7 in the activation event.
    startAt: new Date('2026-06-01T00:00:00.000Z'),
    endAt: new Date('2026-06-08T00:00:00.000Z'),
    billingEvent: 'cpm',
  });

  const fullySpentCampaign = makeDoc({
    _id: campaignId,
    status: 'pending_review',
    ownerUserId,
    objective: 'reach',
    totalBudget: 500,
    budgetSpent: 500,
    billingEvent: 'cpm',
  });

  const placement = makeDoc({
    _id: placementId,
    key: 'feed_promoted_post',
    surface: 'feed',
    floorCpm: 5,
    enabled: true,
  });

  const creativeModel = {
    find: vi.fn(),
    findById: vi.fn(),
  };

  const campaignModel = {
    findById: vi.fn(),
    aggregate: vi.fn(),
  };

  const placementModel = {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };

  const walletService = {
    release: vi.fn().mockResolvedValue(undefined),
    // debit() is the serving-spend charge path the take-down now uses to consume
    // the withheld review fee out of `reserved` (M2). Stubbed here too so the
    // 5-arg construction path exercises the same wallet surface.
    debit: vi.fn().mockResolvedValue(undefined),
  };

  const auditService = {
    logEvent: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AdsAdminService(
    creativeModel as any,
    campaignModel as any,
    placementModel as any,
    walletService as any,
    auditService as any,
  );

  return {
    service,
    creativeModel,
    campaignModel,
    placementModel,
    walletService,
    auditService,
    pendingCreative,
    activeCampaign,
    fullySpentCampaign,
    placement,
    campaignId,
    creativeId,
    placementId,
    adminUserId,
    ownerUserId,
  };
}

// ---------------------------------------------------------------------------
// approve()
// ---------------------------------------------------------------------------

describe('AdsAdminService.approve()', () => {
  it('sets reviewStatus to approved and reviewedBy on the creative', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId);

    expect(f.pendingCreative.reviewStatus).toBe('approved');
    expect(f.pendingCreative.reviewedBy?.toString()).toBe(f.adminUserId);
  });

  it('sets campaign status to active', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId);

    expect(f.activeCampaign.status).toBe('active');
  });

  it('calls save() on both creative and campaign', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId);

    expect(f.pendingCreative.save).toHaveBeenCalledOnce();
    expect(f.activeCampaign.save).toHaveBeenCalledOnce();
  });

  it('calls AuditService.logEvent with AppModule.ADS and action creative_approved', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId);

    expect(f.auditService.logEvent).toHaveBeenCalledOnce();
    const call = f.auditService.logEvent.mock.calls[0][0];
    expect(call.module).toBe(AppModule.ADS);
    expect(call.action).toBe('creative_approved');
    expect(call.actorId).toBe(f.adminUserId);
  });

  it('throws NotFoundException when creative does not exist', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(null);

    await expect(f.service.approve(f.creativeId.toHexString(), f.adminUserId)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('stores the optional note in the audit meta', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId, 'looks good');

    const call = f.auditService.logEvent.mock.calls[0][0];
    expect(call.meta?.note).toBe('looks good');
  });
});

// ---------------------------------------------------------------------------
// reject()
// ---------------------------------------------------------------------------

describe('AdsAdminService.reject()', () => {
  it('sets reviewStatus to rejected and stores rejectionReason', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'inappropriate content');

    expect(f.pendingCreative.reviewStatus).toBe('rejected');
    expect(f.pendingCreative.rejectionReason).toBe('inappropriate content');
    expect(f.pendingCreative.reviewedBy?.toString()).toBe(f.adminUserId);
  });

  it('sets campaign status to rejected', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'reason');

    expect(f.activeCampaign.status).toBe('rejected');
  });

  it('refunds unspent MINUS the default review fee (500-120-25=355)', async () => {
    // No pricingConfig injected -> the service falls back to the shipped default
    // fee (25). Refund = max(0, unspent - fee) = (500-120) - 25 = 355.
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'reason');

    expect(f.walletService.release).toHaveBeenCalledOnce();
    const [uid, amount, cid] = f.walletService.release.mock.calls[0];
    expect(uid).toBe(String(f.activeCampaign.ownerUserId));
    expect(amount).toBe(355); // (500 - 120) - 25 fee
    expect(cid).toBe(String(f.activeCampaign._id));
  });

  it('does NOT call wallet.release when campaign is fully spent (500/500)', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.fullySpentCampaign);

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'reason');

    expect(f.walletService.release).not.toHaveBeenCalled();
  });

  it('calls AuditService.logEvent with action creative_rejected', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'reason');

    expect(f.auditService.logEvent).toHaveBeenCalledOnce();
    const call = f.auditService.logEvent.mock.calls[0][0];
    expect(call.module).toBe(AppModule.ADS);
    expect(call.action).toBe('creative_rejected');
    expect(call.actorId).toBe(f.adminUserId);
    expect(call.reason).toBe('reason');
  });

  it('throws NotFoundException when creative does not exist', async () => {
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(null);

    await expect(
      f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'reason'),
    ).rejects.toThrow(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// listPending()
// ---------------------------------------------------------------------------

describe('AdsAdminService.listPending()', () => {
  it('returns pending creatives enriched with campaign objective, totalBudget, ownerUserId', async () => {
    const f = buildService();

    // find returns a lean result via exec()
    f.creativeModel.find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([
            {
              _id: f.creativeId,
              reviewStatus: 'pending',
              campaignId: f.campaignId,
              postRef: f.pendingCreative.postRef,
              kind: 'promoted_post',
            },
          ]),
      }),
    });

    f.campaignModel.findById.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve({
            _id: f.campaignId,
            objective: 'reach',
            totalBudget: 500,
            ownerUserId: f.ownerUserId,
          }),
      }),
    });

    const result = await f.service.listPending();

    expect(result).toHaveLength(1);
    expect(result[0].reviewStatus).toBe('pending');
    expect(result[0].campaign).toBeDefined();
    expect(result[0].campaign?.objective).toBe('reach');
    expect(result[0].campaign?.totalBudget).toBe(500);
    expect(result[0].campaign?.ownerUserId?.toString()).toBe(String(f.ownerUserId));
  });

  it('returns empty array when no pending creatives', async () => {
    const f = buildService();

    f.creativeModel.find.mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve([]) }),
    });

    const result = await f.service.listPending();

    expect(result).toHaveLength(0);
  });

  it('enriches a promoted_listing creative with the listing title', async () => {
    const f = buildService();
    const listingModel = { findById: vi.fn() };
    const service = new AdsAdminService(
      f.creativeModel as any,
      f.campaignModel as any,
      f.placementModel as any,
      f.walletService as any,
      f.auditService as any,
      undefined,
      listingModel as any,
    );
    const listingRef = makeObjectId();

    f.creativeModel.find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([
            {
              _id: f.creativeId,
              reviewStatus: 'pending',
              campaignId: f.campaignId,
              kind: 'promoted_listing',
              listingRef,
            },
          ]),
      }),
    });
    f.campaignModel.findById.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve({
            _id: f.campaignId,
            objective: 'reach',
            totalBudget: 500,
            ownerUserId: f.ownerUserId,
          }),
      }),
    });
    listingModel.findById.mockReturnValue({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve({ title: 'Pure Zari Sarees' }) }),
      }),
    });

    const result = await service.listPending();

    expect(result[0].kind).toBe('promoted_listing');
    expect(result[0].listingTitle).toBe('Pure Zari Sarees');
    expect(listingModel.findById).toHaveBeenCalledWith(listingRef);
  });

  it('leaves listingTitle null for a promoted_post creative (no listing lookup)', async () => {
    const f = buildService();
    const listingModel = { findById: vi.fn() };
    const service = new AdsAdminService(
      f.creativeModel as any,
      f.campaignModel as any,
      f.placementModel as any,
      f.walletService as any,
      f.auditService as any,
      undefined,
      listingModel as any,
    );

    f.creativeModel.find.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve([
            {
              _id: f.creativeId,
              reviewStatus: 'pending',
              campaignId: f.campaignId,
              kind: 'promoted_post',
              postRef: makeObjectId(),
            },
          ]),
      }),
    });
    f.campaignModel.findById.mockReturnValue({
      lean: () => ({
        exec: () =>
          Promise.resolve({
            _id: f.campaignId,
            objective: 'reach',
            totalBudget: 500,
            ownerUserId: f.ownerUserId,
          }),
      }),
    });

    const result = await service.listPending();

    expect(result[0].listingTitle).toBeNull();
    expect(listingModel.findById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updatePlacement()
// ---------------------------------------------------------------------------

describe('AdsAdminService.updatePlacement()', () => {
  it('updates floorCpm and enabled, calls audit placement_updated', async () => {
    const f = buildService();
    const updatedPlacement = { ...f.placement, floorCpm: 10, enabled: false };

    f.placementModel.findOneAndUpdate.mockResolvedValue(updatedPlacement);

    const result = await f.service.updatePlacement(
      'feed_promoted_post',
      { floorCpm: 10, enabled: false },
      f.adminUserId,
    );

    expect(f.placementModel.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'feed_promoted_post' },
      { $set: { floorCpm: 10, enabled: false } },
      { new: true },
    );
    expect(result.floorCpm).toBe(10);
    expect(result.enabled).toBe(false);

    expect(f.auditService.logEvent).toHaveBeenCalledOnce();
    const call = f.auditService.logEvent.mock.calls[0][0];
    expect(call.module).toBe(AppModule.ADS);
    expect(call.action).toBe('placement_updated');
    expect(call.actorId).toBe(f.adminUserId);
  });

  it('throws NotFoundException when placement key does not exist', async () => {
    const f = buildService();
    f.placementModel.findOneAndUpdate.mockResolvedValue(null);

    await expect(
      f.service.updatePlacement('nonexistent', { floorCpm: 5, enabled: true }, f.adminUserId),
    ).rejects.toThrow(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// getRevenue()
// ---------------------------------------------------------------------------

describe('AdsAdminService.getRevenue()', () => {
  it('returns summed budgetSpent as revenue', async () => {
    const f = buildService();
    f.campaignModel.aggregate.mockResolvedValue([{ _id: null, revenue: 1234.56 }]);

    const result = await f.service.getRevenue();

    expect(result.revenue).toBe(1234.56);
  });

  it('returns revenue 0 when aggregate result is empty', async () => {
    const f = buildService();
    f.campaignModel.aggregate.mockResolvedValue([]);

    const result = await f.service.getRevenue();

    expect(result.revenue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PostHog emit -- T34
// ---------------------------------------------------------------------------

describe('AdsAdminService -- PostHog emit (T34)', () => {
  function buildServiceWithPosthog() {
    const f = buildService();
    const mockPosthog = { capture: vi.fn() };
    // Rebuild the service instance with the 6th positional arg = mockPosthog.
    const service = new AdsAdminService(
      f.creativeModel as any,
      f.campaignModel as any,
      f.placementModel as any,
      f.walletService as any,
      f.auditService as any,
      mockPosthog as any,
    );
    return { ...f, service, mockPosthog };
  }

  it('approve() emits ads.creative_approved with creativeId and campaignId; distinctId is adminUserId', async () => {
    const f = buildServiceWithPosthog();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId);

    // approve() now emits two events: ads.creative_approved (admin action) and
    // connect.boost.activated (owner funnel). Assert the creative_approved one.
    const approvedCall = f.mockPosthog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'ads.creative_approved',
    )?.[0];
    expect(approvedCall).toBeDefined();
    expect(approvedCall.distinctId).toBe(f.adminUserId);
    expect(approvedCall.properties.creativeId).toBe(f.creativeId.toHexString());
    expect(approvedCall.properties.campaignId).toBe(String(f.campaignId));
  });

  it('approve() emits connect.boost.activated to the owner with mapped kind, budgetBucket, durationDays', async () => {
    const f = buildServiceWithPosthog();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.approve(f.creativeId.toHexString(), f.adminUserId);

    const activatedCall = f.mockPosthog.capture.mock.calls.find(
      (c: any[]) => c[0].event === 'connect.boost.activated',
    )?.[0];
    expect(activatedCall).toBeDefined();
    // distinctId = the campaign owner (advertiser), not the admin reviewer.
    expect(activatedCall.distinctId).toBe(String(f.ownerUserId));
    // kind mapped from 'boost_listing' -> 'listing' (FE BoostSubject vocab).
    expect(activatedCall.properties.kind).toBe('listing');
    // budget is bucketed, never the exact amount (500 -> '300-599').
    expect(typeof activatedCall.properties.budgetBucket).toBe('string');
    expect(activatedCall.properties.budgetBucket).toBe('300-599');
    // 7-day flight rounds to 7 whole days.
    expect(typeof activatedCall.properties.durationDays).toBe('number');
    expect(activatedCall.properties.durationDays).toBe(7);
  });

  it('reject() emits ads.creative_rejected with creativeId, campaignId, and reason; distinctId is adminUserId', async () => {
    const f = buildServiceWithPosthog();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'policy violation');

    expect(f.mockPosthog.capture).toHaveBeenCalledOnce();
    const call = f.mockPosthog.capture.mock.calls[0][0];
    expect(call.distinctId).toBe(f.adminUserId);
    expect(call.event).toBe('ads.creative_rejected');
    expect(call.properties.creativeId).toBe(f.creativeId.toHexString());
    expect(call.properties.campaignId).toBe(String(f.campaignId));
    expect(call.properties.reason).toBe('policy violation');
  });

  it('existing tests still pass: posthog is undefined when not provided (5-arg construction)', async () => {
    // The original buildService() uses 5 positional args - posthog is undefined.
    const f = buildService();
    f.creativeModel.findById.mockResolvedValue(f.pendingCreative);
    f.campaignModel.findById.mockResolvedValue(f.activeCampaign);
    // Should resolve without error.
    await expect(
      f.service.approve(f.creativeId.toHexString(), f.adminUserId),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Take-down (publish-then-moderate): fee math + moderationReason + unlink + notify
// ---------------------------------------------------------------------------

/**
 * Full take-down fixture: wires the pricing config (live review fee), the
 * notifications service, the source models (listing/job/rfq), and the ad-set
 * model so the take-down path can refund net of the fee, unlink the source, and
 * notify the advertiser. The campaign is LIVE (active) by default, mirroring a
 * publish-then-moderate boost.
 */
function buildTakedownService(opts: { fee?: number; sourceKind?: 'listing' | 'job' | 'rfq' } = {}) {
  const fee = opts.fee ?? 25;
  const campaignId = makeObjectId();
  const creativeId = makeObjectId();
  const adminUserId = makeObjectId().toHexString();
  const ownerUserId = makeObjectId().toHexString();
  const listingId = makeObjectId();
  const jobId = makeObjectId();
  const rfqId = makeObjectId();

  const creative = makeDoc({
    _id: creativeId,
    reviewStatus: 'approved',
    rejectionReason: undefined,
    reviewedBy: undefined,
    campaignId,
    kind: 'promoted_listing',
  });

  const campaign = makeDoc({
    _id: campaignId,
    status: 'active',
    moderationReason: null as string | null,
    ownerUserId,
    kind: 'boost_listing',
    objective: 'reach',
    totalBudget: 500,
    budgetSpent: 120,
    sourceListingId: opts.sourceKind === 'listing' ? listingId : null,
    sourceJobId: opts.sourceKind === 'job' ? jobId : null,
    sourceRfqId: opts.sourceKind === 'rfq' ? rfqId : null,
    sourceProfileUserId: null,
    billingEvent: 'cpm',
  });

  const listingDoc = makeDoc({ _id: listingId, boostCampaignId: campaignId });
  const jobDoc = makeDoc({ _id: jobId, boostCampaignId: campaignId });
  const rfqDoc = makeDoc({ _id: rfqId, boostCampaignId: campaignId });

  const creativeModel = { find: vi.fn(), findById: vi.fn(), findOne: vi.fn() };
  const campaignModel = { findById: vi.fn(), find: vi.fn(), aggregate: vi.fn() };
  const placementModel = { find: vi.fn(), findOneAndUpdate: vi.fn() };
  const walletService = {
    release: vi.fn().mockResolvedValue(undefined),
    // M2 -- the take-down charges the withheld fee out of `reserved` via debit().
    debit: vi.fn().mockResolvedValue(undefined),
  };
  const auditService = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const listingModel = { findById: vi.fn().mockResolvedValue(listingDoc) };
  const jobModel = { findById: vi.fn().mockResolvedValue(jobDoc) };
  const rfqModel = { findById: vi.fn().mockResolvedValue(rfqDoc) };
  const adSetModel = { findOne: vi.fn() };
  const pricingConfig = { getConfig: vi.fn().mockResolvedValue({ moderationReviewFee: fee }) };
  const notifications = { dispatch: vi.fn().mockResolvedValue(undefined) };

  creativeModel.findById.mockResolvedValue(creative);
  campaignModel.findById.mockResolvedValue(campaign);

  const service = new AdsAdminService(
    creativeModel as any,
    campaignModel as any,
    placementModel as any,
    walletService as any,
    auditService as any,
    undefined, // posthog
    listingModel as any,
    jobModel as any,
    rfqModel as any,
    adSetModel as any,
    pricingConfig as any,
    notifications as any,
  );

  return {
    service,
    creative,
    campaign,
    creativeModel,
    campaignModel,
    walletService,
    auditService,
    listingModel,
    jobModel,
    rfqModel,
    listingDoc,
    jobDoc,
    rfqDoc,
    adSetModel,
    pricingConfig,
    notifications,
    creativeId,
    campaignId,
    adminUserId,
    ownerUserId,
  };
}

describe('AdsAdminService.reject() -- take-down (publish-then-moderate)', () => {
  it('refunds unspent minus the live admin fee (500-120-25=355) and withholds the fee', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    expect(f.walletService.release).toHaveBeenCalledOnce();
    const [, amount] = f.walletService.release.mock.calls[0];
    expect(amount).toBe(355); // (500 - 120) - 25
    // The withheld fee is recorded in the audit meta.
    const auditMeta = f.auditService.logEvent.mock.calls[0][0].meta;
    expect(auditMeta.reviewFeeWithheld).toBe(25);
  });

  it('M2: drains reserved on an active take-down -- charges the fee out of reserved AND releases the refund', async () => {
    // unspent = 500 - 120 = 380; fee = 25 -> debit 25 from reserved (the fee
    // becomes real) + release 355 to balance. reserved nets to 0 (no drift).
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    // Fee charged out of reserved via the serving-spend debit path.
    expect(f.walletService.debit).toHaveBeenCalledOnce();
    const [debUid, debAmount, debCid, debKey] = f.walletService.debit.mock.calls[0];
    expect(debUid).toBe(String(f.campaign.ownerUserId));
    expect(debAmount).toBe(25);
    expect(debCid).toBe(String(f.campaign._id));
    // Deterministic key so a retried take-down charges the fee exactly once.
    expect(debKey).toBe(`takedown-fee:${String(f.campaign._id)}`);

    // Remaining refund released to balance.
    expect(f.walletService.release).toHaveBeenCalledOnce();
    const [, relAmount] = f.walletService.release.mock.calls[0];
    expect(relAmount).toBe(355);

    // debit(25) + release(355) = 380 unspent fully drained from reserved.
    expect(debAmount + relAmount).toBe(380);
  });

  it('refund floors at 0 when the fee exceeds the unspent budget (fee >= unspent)', async () => {
    // unspent = 500 - 480 = 20; fee = 25 -> refund = max(0, 20-25) = 0, no release.
    // The whole unspent (20) is charged out of reserved as the (capped) fee, so
    // reserved still nets to 0.
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });
    f.campaign.budgetSpent = 480;

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    expect(f.walletService.release).not.toHaveBeenCalled();
    // The capped fee is charged out of reserved (min(20, 25) = 20).
    expect(f.walletService.debit).toHaveBeenCalledOnce();
    expect(f.walletService.debit.mock.calls[0][1]).toBe(20);
    // Withheld fee is capped at the unspent (min(20, 25) = 20).
    const auditMeta = f.auditService.logEvent.mock.calls[0][0].meta;
    expect(auditMeta.reviewFeeWithheld).toBe(20);
  });

  it('sets campaign.status=rejected and campaign.moderationReason=reason', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'off-policy');

    expect(f.campaign.status).toBe('rejected');
    expect(f.campaign.moderationReason).toBe('off-policy');
  });

  it('unlinks the source listing (boostCampaignId -> null) so the advertiser can relaunch', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    expect(f.listingModel.findById).toHaveBeenCalledWith(f.campaign.sourceListingId);
    expect(f.listingDoc.boostCampaignId).toBeNull();
    expect(f.listingDoc.save).toHaveBeenCalledOnce();
  });

  it('unlinks the source job when the boost is a job boost', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'job' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    expect(f.jobDoc.boostCampaignId).toBeNull();
    expect(f.jobDoc.save).toHaveBeenCalledOnce();
    // Only the job is touched (no source listing on a job boost).
    expect(f.listingModel.findById).not.toHaveBeenCalled();
  });

  it('unlinks the source RFQ when the boost is an RFQ boost', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'rfq' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    expect(f.rfqDoc.boostCampaignId).toBeNull();
    expect(f.rfqDoc.save).toHaveBeenCalledOnce();
  });

  it('does not touch any source model for a profile boost (no source doc)', async () => {
    const f = buildTakedownService({ fee: 25 }); // sourceKind undefined -> profile-like
    f.campaign.kind = 'boost_open_to_work';

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam');

    expect(f.listingModel.findById).not.toHaveBeenCalled();
    expect(f.jobModel.findById).not.toHaveBeenCalled();
    expect(f.rfqModel.findById).not.toHaveBeenCalled();
  });

  it('notifies the advertiser of the take-down with the reason', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });

    await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'misleading claim');

    expect(f.notifications.dispatch).toHaveBeenCalledOnce();
    const payload = f.notifications.dispatch.mock.calls[0][0];
    expect(payload.recipientId).toBe(f.campaign.ownerUserId);
    expect(payload.category).toBe('connect.boost_taken_down');
    expect(payload.message).toContain('misleading claim');
    expect(payload.entityId).toBe(String(f.campaign._id));
  });

  it('a notification failure never breaks the take-down (best-effort)', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });
    f.notifications.dispatch.mockRejectedValueOnce(new Error('bell down'));

    await expect(
      f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam'),
    ).resolves.toBeDefined();
    // The take-down still completed: status flipped + refund issued.
    expect(f.campaign.status).toBe('rejected');
    expect(f.walletService.release).toHaveBeenCalledOnce();
  });

  it('M3: an unlink failure never breaks the take-down (best-effort)', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });
    // Make the source unlink throw a transient DB error.
    f.listingModel.findById.mockRejectedValueOnce(new Error('db blip'));

    await expect(
      f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'spam'),
    ).resolves.toBeDefined();
    // The take-down still completed: status flipped + refund issued + notified.
    expect(f.campaign.status).toBe('rejected');
    expect(f.walletService.release).toHaveBeenCalledOnce();
    expect(f.notifications.dispatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Take-down -- M1 (paused) + H1 (idempotent terminal) edge cases
// ---------------------------------------------------------------------------

describe('AdsAdminService.reject() -- paused take-down (M1) does not double-refund', () => {
  it('does NOT call wallet.release or wallet.debit on a PAUSED campaign, still rejects + reason + notifies', async () => {
    // pause() already released the unspent on pause, so reserved is ~0. Taking a
    // paused boost down must NOT release/debit again (would over-release/throw).
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });
    f.campaign.status = 'paused';

    await expect(
      f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'paused-then-down'),
    ).resolves.toBeDefined();

    // No second budget move on a paused take-down.
    expect(f.walletService.release).not.toHaveBeenCalled();
    expect(f.walletService.debit).not.toHaveBeenCalled();

    // But the boost is still taken down: status + reason + creative + notify.
    expect(f.campaign.status).toBe('rejected');
    expect(f.campaign.moderationReason).toBe('paused-then-down');
    expect(f.creative.reviewStatus).toBe('rejected');
    expect(f.notifications.dispatch).toHaveBeenCalledOnce();

    // No fee withheld on a paused take-down (money already returned on pause).
    const auditMeta = f.auditService.logEvent.mock.calls[0][0].meta;
    expect(auditMeta.reviewFeeWithheld).toBe(0);
  });
});

describe('AdsAdminService.reject() -- idempotent terminal take-down (H1)', () => {
  it('is a no-op on an already-COMPLETED campaign (no mutation, no budget, no unlink, no notify)', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });
    f.campaign.status = 'completed';

    const result = await f.service.reject(f.creativeId.toHexString(), f.adminUserId, 'late');

    // Returns the existing terminal status; nothing changed.
    expect(result.status).toBe('completed');
    expect(f.creative.save).not.toHaveBeenCalled();
    expect(f.creative.reviewStatus).toBe('approved'); // untouched
    expect(f.campaign.save).not.toHaveBeenCalled();
    expect(f.campaign.moderationReason).toBeNull();
    expect(f.walletService.release).not.toHaveBeenCalled();
    expect(f.walletService.debit).not.toHaveBeenCalled();
    expect(f.listingModel.findById).not.toHaveBeenCalled();
    expect(f.notifications.dispatch).not.toHaveBeenCalled();
    expect(f.auditService.logEvent).not.toHaveBeenCalled();
  });

  it('is a no-op on an already-REJECTED campaign (re-take-down does nothing)', async () => {
    const f = buildTakedownService({ fee: 25, sourceKind: 'listing' });
    f.campaign.status = 'rejected';
    f.campaign.moderationReason = 'first reason';

    const result = await f.service.reject(
      f.creativeId.toHexString(),
      f.adminUserId,
      'second reason',
    );

    expect(result.status).toBe('rejected');
    expect(f.creative.save).not.toHaveBeenCalled();
    expect(f.campaign.save).not.toHaveBeenCalled();
    // Original reason is preserved (not overwritten by the second take-down).
    expect(f.campaign.moderationReason).toBe('first reason');
    expect(f.walletService.release).not.toHaveBeenCalled();
    expect(f.walletService.debit).not.toHaveBeenCalled();
    expect(f.notifications.dispatch).not.toHaveBeenCalled();
    expect(f.auditService.logEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listLive()
// ---------------------------------------------------------------------------

describe('AdsAdminService.listLive()', () => {
  function leanExec<T>(value: T) {
    return { lean: () => ({ exec: () => Promise.resolve(value) }) };
  }
  function selectLeanExec<T>(value: T) {
    return { select: () => ({ lean: () => ({ exec: () => Promise.resolve(value) }) }) };
  }

  it('returns live rows in the listPending shape (real _id, nested campaign, title, creative kind) PLUS spotlight', async () => {
    // C1 -- the FE consumes a live boost with the SAME shape as a pending one
    // (AdminLiveBoost extends AdminPendingCreative): _id = the CREATIVE id, a
    // nested campaign summary, per-kind title fields, kind = the creative kind
    // (promoted_*), plus a spotlight boolean.
    const f = buildTakedownService({ sourceKind: 'listing' });
    const campaignId = makeObjectId();
    const creativeId = makeObjectId();
    const listingRef = makeObjectId();

    f.campaignModel.find.mockReturnValue({
      sort: () =>
        leanExec([
          {
            _id: campaignId,
            status: 'active',
            kind: 'boost_listing', // CAMPAIGN kind -- must NOT leak into the row's kind
            ownerUserId: f.ownerUserId,
            objective: 'reach',
            totalBudget: 500,
            budgetSpent: 120,
          },
        ]),
    });
    f.creativeModel.findOne.mockReturnValue(
      leanExec({ _id: creativeId, campaignId, kind: 'promoted_listing', listingRef }),
    );
    // enrichCreative re-reads the campaign for the nested summary (lean chain).
    f.campaignModel.findById.mockReturnValue(
      leanExec({
        _id: campaignId,
        objective: 'reach',
        totalBudget: 500,
        ownerUserId: f.ownerUserId,
      }),
    );
    f.listingModel.findById.mockReturnValue(selectLeanExec({ title: 'Pure Zari Sarees' }));
    f.adSetModel.findOne.mockReturnValue(
      selectLeanExec({ placements: ['marketplace_rail', 'feed_sponsored', 'spotlight_rail'] }),
    );

    const result = await f.service.listLive();

    expect(result).toHaveLength(1);
    // _id is the CREATIVE id (the FE reject() target), not the campaign id.
    expect(String(result[0]._id)).toBe(String(creativeId));
    // kind is the CREATIVE kind (promoted_*), matching listPending.
    expect(result[0].kind).toBe('promoted_listing');
    // Nested campaign summary, exactly like a pending row.
    expect(result[0].campaign).toBeDefined();
    expect(result[0].campaign?.objective).toBe('reach');
    expect(result[0].campaign?.totalBudget).toBe(500);
    expect(result[0].campaign?.ownerUserId?.toString()).toBe(String(f.ownerUserId));
    // Per-kind title field (listing boost -> listingTitle), not a flat `title`.
    expect(result[0].listingTitle).toBe('Pure Zari Sarees');
    // The extra boolean.
    expect(result[0].spotlight).toBe(true);
    // The status filter must be exactly active|paused.
    const filterArg = f.campaignModel.find.mock.calls[0][0];
    expect(filterArg.status.$in).toEqual(['active', 'paused']);
  });

  it('spotlight is false when the ad set has no spotlight_rail placement; only active/paused are listed', async () => {
    const f = buildTakedownService({ sourceKind: 'job' });
    const campaignId = makeObjectId();
    const creativeId = makeObjectId();
    const jobRef = makeObjectId();

    f.campaignModel.find.mockReturnValue({
      sort: () =>
        leanExec([
          {
            _id: campaignId,
            status: 'paused',
            kind: 'boost_job',
            ownerUserId: f.ownerUserId,
            objective: 'applications',
            totalBudget: 300,
            budgetSpent: 0,
          },
        ]),
    });
    f.creativeModel.findOne.mockReturnValue(
      leanExec({ _id: creativeId, campaignId, kind: 'promoted_job', jobRef }),
    );
    f.campaignModel.findById.mockReturnValue(
      leanExec({
        _id: campaignId,
        objective: 'applications',
        totalBudget: 300,
        ownerUserId: f.ownerUserId,
      }),
    );
    f.jobModel.findById.mockReturnValue(selectLeanExec({ title: 'Loom operator' }));
    f.adSetModel.findOne.mockReturnValue(selectLeanExec({ placements: ['feed_sponsored'] }));

    const result = await f.service.listLive();

    expect(result[0].kind).toBe('promoted_job');
    expect(result[0].jobTitle).toBe('Loom operator');
    expect(result[0].spotlight).toBe(false);
    // The query selects only active/paused campaigns.
    const filterArg = f.campaignModel.find.mock.calls[0][0];
    expect(filterArg.status.$in).toEqual(['active', 'paused']);
  });

  it('returns an empty array when there are no live campaigns', async () => {
    const f = buildTakedownService();
    f.campaignModel.find.mockReturnValue({ sort: () => leanExec([]) });

    const result = await f.service.listLive();

    expect(result).toEqual([]);
  });
});
