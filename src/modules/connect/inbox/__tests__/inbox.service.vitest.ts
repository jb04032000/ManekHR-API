/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports skip vitest's reflect-metadata pipeline.
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

import { Types } from 'mongoose';
import { InboxService } from '../inbox.service';

const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const THREAD = new Types.ObjectId();

/** A `{ exec }` wrapper resolving `val`. */
const exec = (val: unknown) => ({ exec: vi.fn().mockResolvedValue(val) });
/** A `.select().lean().exec()` chain resolving `val`. */
const selLean = (val: unknown) => ({
  select: vi.fn(() => ({ lean: vi.fn(() => exec(val)) })),
});

const dmThread = () => ({
  _id: THREAD,
  channelType: 'dm',
  closed: false,
  participantIds: [ME, OTHER],
  participants: [
    { userId: ME, unreadCount: 0, muted: false },
    { userId: OTHER, unreadCount: 0, muted: false },
  ],
  toObject() {
    return { ...this };
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function build(rl?: { allowed: boolean }, spam?: any) {
  const threadModel: any = {
    findOne: vi.fn(() => exec(null)),
    findById: vi.fn(() => exec(dmThread())),
    findOneAndUpdate: vi.fn(() => exec({ ...dmThread(), messageSeq: 1 })),
    updateOne: vi.fn(() => exec({})),
    create: vi.fn((doc: any) => Promise.resolve({ _id: THREAD, ...doc })),
    aggregate: vi.fn(() => exec([{ total: 7 }])),
  };
  const messageModel: any = {
    findOne: vi.fn(() => exec(null)),
    create: vi.fn((doc: any) =>
      Promise.resolve({ _id: new Types.ObjectId(), createdAt: new Date(), ...doc }),
    ),
    find: vi.fn(() => ({ sort: vi.fn(() => ({ limit: vi.fn(() => exec([])) })) })),
    // I5b cold-contact check: null => recipient has NOT replied yet (cold).
    exists: vi.fn(() => exec(null)),
  };
  const blockModel: any = {
    findOne: vi.fn(() => selLean(null)),
    updateOne: vi.fn(() => exec({})),
    deleteOne: vi.fn(() => exec({})),
  };
  const reportModel: any = {
    create: vi.fn().mockResolvedValue({}),
    countDocuments: vi.fn(() => exec(0)),
  };
  const userModel: any = {
    findById: vi.fn(() => selLean({ _id: OTHER, name: 'Meera' })),
    find: vi.fn(() => selLean([])),
  };
  // Context hydration models (inquiry -> listing product card). Default empty:
  // DM-thread tests never hit them (hydrateContexts short-circuits on no context).
  const inquiryModel: any = { find: vi.fn(() => selLean([])) };
  const listingModel: any = { find: vi.fn(() => selLean([])) };
  const eventEmitter: any = { emit: vi.fn() };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const posthog: any = { capture: vi.fn() };
  const notifications: any = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const gateway: any = { emitMessage: vi.fn(), emitThreadUpdated: vi.fn(), emitRead: vi.fn() };
  // I5: the limiter / allowances / spam guard are appended only when a test opts
  // in. Passing `undefined` for them is identical to the original 9-arg
  // construction (all @Optional -> skipped), so every pre-I5 case is unchanged.
  const limiter: any = rl
    ? { tryConsumeInitiation: vi.fn().mockResolvedValue(rl.allowed) }
    : undefined;
  const allowances: any = rl
    ? { getAllowances: vi.fn().mockResolvedValue({ verifiedBadge: false }) }
    : undefined;
  const spamGuard: any = spam ?? undefined;
  const service = new InboxService(
    threadModel,
    messageModel,
    blockModel,
    reportModel,
    userModel,
    inquiryModel,
    listingModel,
    audit,
    posthog,
    notifications,
    gateway,
    limiter,
    allowances,
    spamGuard,
    eventEmitter,
    // Shared media-ownership guard stub. getServerAudioDurationByUrl => null so a
    // text/photo send (no audio) skips the server-duration override cleanly.
    {
      assertOwnedMedia: () => Promise.resolve(),
      getServerAudioDurationByUrl: () => Promise.resolve(null),
    } as any,
    // PrivateMediaService is @Optional() in prod; omitted here (decoration is a
    // passthrough without it), so the message returns keep their plain shape.
  );
  return {
    service,
    threadModel,
    messageModel,
    blockModel,
    reportModel,
    userModel,
    audit,
    notifications,
    gateway,
    limiter,
    allowances,
    spamGuard,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('InboxService.findOrCreateDmThread', () => {
  it('blocks messaging yourself', async () => {
    const f = build();
    await expect(
      f.service.findOrCreateDmThread(ME.toHexString(), ME.toHexString()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns the existing thread (idempotent) without creating a new one', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER }));
    f.threadModel.findOne = vi.fn(() => exec({ _id: THREAD, pairKey: 'x' }));
    const t = await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(String(t._id)).toBe(String(THREAD));
    expect(f.threadModel.create).not.toHaveBeenCalled();
  });

  it('refuses when the two users have a block between them', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER }));
    f.blockModel.findOne = vi.fn(() => selLean({ _id: new Types.ObjectId() }));
    await expect(
      f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Demo isolation — a real user may not START a DM with a sample account, and
  // vice-versa. The recipient (1st findById) is demo; the initiator (2nd) real.
  it('blocks a real user from starting a DM with a demo account', async () => {
    const f = build();
    f.userModel.findById = vi
      .fn()
      .mockReturnValueOnce(selLean({ _id: OTHER, isDemo: true })) // recipient = demo
      .mockReturnValueOnce(selLean({ _id: ME })); // me = real
    f.threadModel.findOne = vi.fn(() => exec(null)); // no existing thread => cold start
    await expect(
      f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.threadModel.create).not.toHaveBeenCalled();
  });

  it('blocks a demo account (by demo email) from starting a DM with a real user', async () => {
    const f = build();
    f.userModel.findById = vi
      .fn()
      .mockReturnValueOnce(selLean({ _id: OTHER })) // recipient = real
      .mockReturnValueOnce(selLean({ _id: ME, email: 'seed@connect-demo.zari360.test' })); // me = demo
    f.threadModel.findOne = vi.fn(() => exec(null));
    await expect(
      f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a DM between two demo accounts', async () => {
    const f = build();
    f.userModel.findById = vi
      .fn()
      .mockReturnValueOnce(selLean({ _id: OTHER, isDemo: true }))
      .mockReturnValueOnce(selLean({ _id: ME, isDemo: true }));
    f.threadModel.findOne = vi.fn(() => exec(null));
    const t = await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(t).toBeTruthy();
  });

  it('does not sever an EXISTING demo-real thread (gate is start-only)', async () => {
    const f = build();
    // Even if somehow a cross thread exists, resuming it returns early before the gate.
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER, isDemo: true }));
    f.threadModel.findOne = vi.fn(() => exec({ _id: THREAD, pairKey: 'x' }));
    const t = await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(String(t._id)).toBe(String(THREAD));
  });
});

describe('InboxService.findOrCreateDmThread rate-limit (I5)', () => {
  it('throws 429 when the cold-initiation bucket is empty', async () => {
    const f = build({ allowed: false });
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER }));
    f.threadModel.findOne = vi.fn(() => exec(null)); // brand-new thread
    const err = await f.service
      .findOrCreateDmThread(ME.toHexString(), OTHER.toHexString())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(f.threadModel.create).not.toHaveBeenCalled();
    expect(f.limiter.tryConsumeInitiation).toHaveBeenCalledTimes(1);
  });

  it('creates the thread when the bucket has tokens', async () => {
    const f = build({ allowed: true });
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER }));
    f.threadModel.findOne = vi.fn(() => exec(null));
    await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(f.limiter.tryConsumeInitiation).toHaveBeenCalledTimes(1);
    expect(f.threadModel.create).toHaveBeenCalledTimes(1);
  });

  it('does not consume a token when resuming an existing thread', async () => {
    const f = build({ allowed: false });
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER }));
    f.threadModel.findOne = vi.fn(() => exec({ _id: THREAD, pairKey: 'x' }));
    const t = await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(String(t._id)).toBe(String(THREAD));
    expect(f.limiter.tryConsumeInitiation).not.toHaveBeenCalled();
  });
});

describe('InboxService.findOrCreateDmThread — recipient visibility gate', () => {
  // Build a service wired with the ConnectProfile + Connection models the cold-DM
  // gate reads. Positional construction must reach connectProfileModel (arg 23) and
  // connectionModel (arg 25), so the in-between optional models (17-22, 24) are
  // passed as `undefined` (they are untouched on the DM path). Owner rule: a `public`
  // recipient is reachable by anyone; a `connections`/`hidden` recipient only by a
  // first-degree connection.
  function buildWithGate(opts: { visibility: string; connected: boolean }) {
    const threadModel: any = {
      // null on BOTH reads (findOrCreateDmThread + upsertThread) => cold new thread.
      findOne: vi.fn(() => exec(null)),
      create: vi.fn((doc: any) => Promise.resolve({ _id: THREAD, ...doc })),
    };
    const userModel: any = { findById: vi.fn(() => selLean({ _id: OTHER })) };
    const blockModel: any = { findOne: vi.fn(() => selLean(null)) };
    const connectProfileModel: any = {
      findOne: vi.fn(() => selLean({ visibility: opts.visibility })),
    };
    const connectionModel: any = {
      findOne: vi.fn(() => selLean(opts.connected ? { _id: new Types.ObjectId() } : null)),
    };
    const audit: any = { logEvent: vi.fn() };
    const service = new InboxService(
      threadModel, // 1
      {} as any, // 2 message
      blockModel, // 3
      {} as any, // 4 report
      userModel, // 5
      {} as any, // 6 inquiry
      {} as any, // 7 listing
      audit, // 8
      undefined, // 9 posthog
      undefined, // 10 notifications
      undefined, // 11 gateway
      undefined, // 12 rateLimiter (absent => assertCanInitiate no-ops)
      undefined, // 13 allowances
      undefined, // 14 spamGuard
      undefined, // 15 eventEmitter
      undefined as any, // 16 media
      undefined, // 17 privateMedia
      undefined, // 18 jobApplication
      undefined, // 19 job
      undefined, // 20 companyPage
      undefined, // 21 quote
      undefined, // 22 rfq
      connectProfileModel, // 23
      undefined, // 24 candidateRequest
      connectionModel, // 25
    );
    return { service, threadModel, connectProfileModel, connectionModel };
  }

  it('allows a cold DM to a PUBLIC recipient without requiring a connection', async () => {
    const f = buildWithGate({ visibility: 'public', connected: false });
    await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(f.threadModel.create).toHaveBeenCalledTimes(1);
    // `public` short-circuits before the connection lookup.
    expect(f.connectionModel.findOne).not.toHaveBeenCalled();
  });

  it('blocks a cold DM to a CONNECTIONS-only recipient when not connected', async () => {
    const f = buildWithGate({ visibility: 'connections', connected: false });
    await expect(
      f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.threadModel.create).not.toHaveBeenCalled();
  });

  it('allows a cold DM to a non-public recipient when first-degree connected', async () => {
    const f = buildWithGate({ visibility: 'connections', connected: true });
    await f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString());
    expect(f.threadModel.create).toHaveBeenCalledTimes(1);
  });

  it('blocks a cold DM to a HIDDEN recipient when not connected', async () => {
    const f = buildWithGate({ visibility: 'hidden', connected: false });
    await expect(
      f.service.findOrCreateDmThread(ME.toHexString(), OTHER.toHexString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.threadModel.create).not.toHaveBeenCalled();
  });
});

describe('InboxService spam scoring (I5b)', () => {
  const spamMock = (over: Record<string, any> = {}) => ({
    recordAndCountDuplicateBody: vi.fn().mockResolvedValue(1),
    getInitiationCount: vi.fn().mockResolvedValue(0),
    isQuarantined: vi.fn().mockResolvedValue(false),
    quarantine: vi.fn().mockResolvedValue(undefined),
    recordInitiation: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  it('auto-quarantines a high-scoring cold first contact (link + repeated + fan-out)', async () => {
    const spam = spamMock({
      recordAndCountDuplicateBody: vi.fn().mockResolvedValue(5),
      getInitiationCount: vi.fn().mockResolvedValue(20),
    });
    const f = build({ allowed: true }, spam);
    f.messageModel.exists = vi.fn(() => exec(null)); // recipient hasn't replied
    await f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), {
      clientMsgId: 's1',
      body: 'great deal http://spam.example buy now',
    });
    await flush();
    expect(spam.quarantine).toHaveBeenCalledWith(ME.toHexString());
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'message_spam_quarantine' }),
    );
  });

  it('does not score once the recipient has already replied', async () => {
    const spam = spamMock();
    const f = build({ allowed: true }, spam);
    f.messageModel.exists = vi.fn(() => exec({ _id: new Types.ObjectId() })); // replied
    await f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), {
      clientMsgId: 's2',
      body: 'http://spam.example',
    });
    await flush();
    expect(spam.recordAndCountDuplicateBody).not.toHaveBeenCalled();
    expect(spam.quarantine).not.toHaveBeenCalled();
  });

  it('blocks a quarantined sender from starting a new cold thread (429)', async () => {
    const spam = spamMock({ isQuarantined: vi.fn().mockResolvedValue(true) });
    const f = build({ allowed: true }, spam);
    f.userModel.findById = vi.fn(() => selLean({ _id: OTHER }));
    f.threadModel.findOne = vi.fn(() => exec(null));
    const err = await f.service
      .findOrCreateDmThread(ME.toHexString(), OTHER.toHexString())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(f.threadModel.create).not.toHaveBeenCalled();
  });
});

describe('InboxService.sendMessage', () => {
  const dto = { clientMsgId: 'c1', body: 'Salaam' };

  it('allocates a seq + increments the recipient unread + writes the message', async () => {
    const f = build();
    const msg = await f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), dto);

    // seq came from the atomic findOneAndUpdate (which also $inc-s unread).
    expect(f.threadModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const updateArg = f.threadModel.findOneAndUpdate.mock.calls[0][1];
    expect(updateArg.$inc.messageSeq).toBe(1);
    expect(updateArg.$inc['participants.$.unreadCount']).toBe(1);
    expect(f.messageModel.create).toHaveBeenCalledTimes(1);
    expect(f.messageModel.create.mock.calls[0][0].seq).toBe(1);
    expect(msg.body).toBe('Salaam');
    // lastMessage denormalized after insert.
    expect(f.threadModel.updateOne).toHaveBeenCalled();
    // realtime delivered to both participants (sender devices + recipient).
    expect(f.gateway.emitMessage).toHaveBeenCalledTimes(1);
    expect(f.gateway.emitMessage.mock.calls[0][1].seq).toBe(1);
  });

  it('is idempotent: a repeat clientMsgId returns the existing message, no new write', async () => {
    const f = build();
    const existing = { _id: new Types.ObjectId(), body: 'Salaam' };
    f.messageModel.findOne = vi.fn(() => exec(existing));
    const msg = await f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), dto);
    expect(msg).toBe(existing);
    expect(f.threadModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.messageModel.create).not.toHaveBeenCalled();
  });

  it('rejects an empty text message', async () => {
    const f = build();
    await expect(
      f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), {
        clientMsgId: 'c2',
        body: '   ',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to send when blocked', async () => {
    const f = build();
    f.blockModel.findOne = vi.fn(() => selLean({ _id: new Types.ObjectId() }));
    await expect(
      f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), dto as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to reply to a system thread', async () => {
    const f = build();
    f.threadModel.findById = vi.fn(() => exec({ ...dmThread(), channelType: 'system' }));
    await expect(
      f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), dto as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('notifies the recipient (unmuted)', async () => {
    const f = build();
    await f.service.sendMessage(ME.toHexString(), THREAD.toHexString(), dto);
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);
    expect(f.notifications.dispatch.mock.calls[0][0].category).toBe('connect.message_received');
  });
});

describe('InboxService read state + safety', () => {
  it('markRead issues a monotonic, participant-scoped update', async () => {
    const f = build();
    await f.service.markRead(ME.toHexString(), THREAD.toHexString(), 5);
    expect(f.threadModel.updateOne).toHaveBeenCalledTimes(1);
    const filter = f.threadModel.updateOne.mock.calls[0][0];
    expect(filter.participants.$elemMatch.lastReadSeq.$lt).toBe(5);
  });

  it('getUnreadBadge returns the aggregated total', async () => {
    const f = build();
    const res = await f.service.getUnreadBadge(ME.toHexString());
    expect(res.total).toBe(7);
  });

  it('blockUser rejects self-block', async () => {
    const f = build();
    await expect(f.service.blockUser(ME.toHexString(), ME.toHexString())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('blockUser upserts a block row', async () => {
    const f = build();
    await f.service.blockUser(ME.toHexString(), OTHER.toHexString());
    expect(f.blockModel.updateOne).toHaveBeenCalledTimes(1);
    expect(f.blockModel.updateOne.mock.calls[0][2]).toEqual({ upsert: true });
  });
});

// hydrateContexts is private; we call it directly and inject the read-only context
// models on the built service (the build() positional constructor stops before
// them). These guard the application / quote subject-card data + the leak/batching
// invariants the web ContextCard depends on. See inbox.service.ts ThreadContext.
describe('InboxService.hydrateContexts (context cards)', () => {
  const EMPLOYER = new Types.ObjectId();
  const APPLICANT = new Types.ObjectId();
  const BUYER = new Types.ObjectId();
  const ctxThread = (id: Types.ObjectId, type: string, entityId: Types.ObjectId) => ({
    _id: id,
    contextEntityType: type,
    contextEntityId: entityId,
  });

  it('hydrates a job-application thread into a job card (applicant view: no snapshot)', async () => {
    const svc = build().service as any;
    const appId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.jobApplicationModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: appId,
            jobId,
            applicantUserId: APPLICANT,
            status: 'shortlisted',
            viewedAt: new Date(),
          },
        ]),
      ),
    };
    svc.jobModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: jobId,
            title: 'Aari karigar',
            wageType: 'monthly',
            wageMin: 18000,
            wageMax: 24000,
            location: { district: 'Surat' },
            status: 'open',
            companyPageId: null,
            companyUserId: EMPLOYER,
            skills: [],
          },
        ]),
      ),
    };
    svc.companyPageModel = { find: vi.fn(() => selLean([])) };

    // Viewer is the APPLICANT -> employer snapshot must be null (leak guard).
    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'JobApplication', appId)],
      String(APPLICANT),
    );
    expect(map.get(String(tid))).toMatchObject({
      kind: 'application',
      jobId: String(jobId),
      title: 'Aari karigar',
      status: 'shortlisted',
      viewed: true,
      jobStatus: 'open',
      viewerRole: 'applicant',
      applicant: null,
    });
  });

  it('attaches an EMPLOYER-only applicant snapshot (matched skills + past applicant)', async () => {
    const svc = build().service as any;
    const appId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.jobApplicationModel = {
      // call 1: the page's applications; call 2: prior apps (>1 => past applicant).
      find: vi
        .fn()
        .mockReturnValueOnce(
          selLean([{ _id: appId, jobId, applicantUserId: APPLICANT, status: 'applied' }]),
        )
        .mockReturnValueOnce(
          selLean([{ applicantUserId: APPLICANT }, { applicantUserId: APPLICANT }]),
        ),
    };
    svc.jobModel = {
      // call 1: jobs by id; call 2: this employer's jobs (for past-applicant).
      find: vi
        .fn()
        .mockReturnValueOnce(
          selLean([
            {
              _id: jobId,
              title: 'Zari work',
              status: 'open',
              companyPageId: null,
              companyUserId: EMPLOYER,
              skills: ['Zari', 'Aari', 'Sequins'],
            },
          ]),
        )
        .mockReturnValueOnce(selLean([{ _id: jobId }])),
    };
    svc.companyPageModel = { find: vi.fn(() => selLean([])) };
    svc.connectProfileModel = {
      find: vi.fn(() =>
        selLean([
          {
            userId: APPLICANT,
            headline: 'Zari karigar, 8 yrs',
            skills: ['zari', 'sequins'],
            district: 'Surat',
          },
        ]),
      ),
    };

    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'JobApplication', appId)],
      String(EMPLOYER),
    );
    const ctx = map.get(String(tid));
    expect(ctx.viewerRole).toBe('employer');
    expect(ctx.applicant).toMatchObject({
      headline: 'Zari karigar, 8 yrs',
      district: 'Surat',
      jobSkillCount: 3,
      pastApplicant: true,
    });
    // Matched skills keep the JOB's original casing, matched case-insensitively.
    expect(ctx.applicant.matchedSkills).toEqual(['Zari', 'Sequins']);
  });

  it('hydrates a quote thread into an RFQ card with viewer role (buyer)', async () => {
    const svc = build().service as any;
    const quoteId = new Types.ObjectId();
    const rfqId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.quoteModel = {
      find: vi.fn(() =>
        selLean([{ _id: quoteId, rfqId, price: 92000, sampleUrls: ['s.jpg'], status: 'sent' }]),
      ),
    };
    svc.rfqModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: rfqId,
            title: 'Cotton poplin 2000m',
            quantity: 2000,
            unit: 'metre',
            budgetMin: 80000,
            budgetMax: 100000,
            location: { district: 'Ahmedabad' },
            status: 'open',
            buyerUserId: BUYER,
          },
        ]),
      ),
    };

    const map = await svc.hydrateContexts([ctxThread(tid, 'Quote', quoteId)], String(BUYER));
    expect(map.get(String(tid))).toMatchObject({
      kind: 'quote',
      rfqId: String(rfqId),
      title: 'Cotton poplin 2000m',
      sampleImage: 's.jpg',
      price: 92000,
      quantity: 2000,
      unit: 'metre',
      budgetMin: 80000,
      district: 'Ahmedabad',
      status: 'sent',
      rfqStatus: 'open',
      viewerRole: 'buyer',
    });
  });

  it('marks the quote viewer as supplier when they are not the RFQ buyer', async () => {
    const svc = build().service as any;
    const quoteId = new Types.ObjectId();
    const rfqId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.quoteModel = {
      find: vi.fn(() => selLean([{ _id: quoteId, rfqId, price: 50000, status: 'sent' }])),
    };
    svc.rfqModel = {
      find: vi.fn(() => selLean([{ _id: rfqId, title: 'R', status: 'open', buyerUserId: BUYER }])),
    };
    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'Quote', quoteId)],
      String(new Types.ObjectId()),
    );
    expect(map.get(String(tid)).viewerRole).toBe('supplier');
  });

  it('omits an application thread whose parent job was deleted (lean fallback)', async () => {
    const svc = build().service as any;
    const appId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.jobApplicationModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: appId,
            jobId: new Types.ObjectId(),
            applicantUserId: APPLICANT,
            status: 'applied',
          },
        ]),
      ),
    };
    svc.jobModel = { find: vi.fn(() => selLean([])) }; // job gone
    svc.companyPageModel = { find: vi.fn(() => selLean([])) };

    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'JobApplication', appId)],
      String(EMPLOYER),
    );
    expect(map.has(String(tid))).toBe(false);
  });

  it('leak guard: the application projection excludes resume / voice media', async () => {
    const svc = build().service as any;
    const selectSpy = vi.fn(() => ({ lean: vi.fn(() => exec([])) }));
    svc.jobApplicationModel = { find: vi.fn(() => ({ select: selectSpy })) };
    svc.jobModel = { find: vi.fn(() => selLean([])) };
    svc.companyPageModel = { find: vi.fn(() => selLean([])) };

    await svc.hydrateContexts(
      [ctxThread(new Types.ObjectId(), 'JobApplication', new Types.ObjectId())],
      String(EMPLOYER),
    );
    const projection = String(selectSpy.mock.calls[0][0]);
    expect(projection).not.toMatch(/resume|voice/i);
  });

  it('batches: N application threads over M jobs issue a fixed number of finds', async () => {
    const svc = build().service as any;
    const jobId = new Types.ObjectId();
    const a1 = new Types.ObjectId();
    const a2 = new Types.ObjectId();
    svc.jobApplicationModel = {
      find: vi.fn(() =>
        selLean([
          { _id: a1, jobId, applicantUserId: APPLICANT, status: 'applied' },
          { _id: a2, jobId, applicantUserId: APPLICANT, status: 'applied' },
        ]),
      ),
    };
    svc.jobModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: jobId,
            title: 'J',
            status: 'open',
            companyPageId: null,
            companyUserId: EMPLOYER,
            skills: [],
          },
        ]),
      ),
    };
    svc.companyPageModel = { find: vi.fn(() => selLean([])) };

    // Applicant view (meId != employer) -> snapshot block skipped, so exactly the
    // two base finds run regardless of thread count.
    await svc.hydrateContexts(
      [
        ctxThread(new Types.ObjectId(), 'JobApplication', a1),
        ctxThread(new Types.ObjectId(), 'JobApplication', a2),
      ],
      String(APPLICANT),
    );
    expect(svc.jobApplicationModel.find).toHaveBeenCalledTimes(1);
    expect(svc.jobModel.find).toHaveBeenCalledTimes(1);
    expect(svc.companyPageModel.find).not.toHaveBeenCalled();
  });

  it('hydrates a candidate_request thread into an institute hire-lead card', async () => {
    const svc = build().service as any;
    const leadId = new Types.ObjectId();
    const pageId = new Types.ObjectId();
    const fromUserId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.candidateRequestModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: leadId,
            companyPageId: pageId,
            fromUserId,
            status: 'viewed',
            message: 'We need 5 aari karigars in Surat',
          },
        ]),
      ),
    };
    svc.companyPageModel = {
      find: vi.fn(() =>
        selLean([
          { _id: pageId, name: 'Surat Zari Academy', slug: 'surat-zari', logo: 'logo.jpg' },
        ]),
      ),
    };
    svc.userModel = { find: vi.fn(() => selLean([{ _id: fromUserId, name: 'Patel Textiles' }])) };

    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'CandidateRequest', leadId)],
      String(EMPLOYER),
    );
    expect(map.get(String(tid))).toMatchObject({
      kind: 'candidate_request',
      candidateRequestId: String(leadId),
      pageId: String(pageId),
      pageName: 'Surat Zari Academy',
      pageSlug: 'surat-zari',
      pageLogo: 'logo.jpg',
      fromUserName: 'Patel Textiles',
      status: 'viewed',
      messageSnippet: 'We need 5 aari karigars in Surat',
    });
  });

  it('omits a candidate_request thread whose CandidateRequest is missing (lean fallback)', async () => {
    const svc = build().service as any;
    const tid = new Types.ObjectId();
    svc.candidateRequestModel = { find: vi.fn(() => selLean([])) }; // lead gone
    svc.companyPageModel = { find: vi.fn(() => selLean([])) };

    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'CandidateRequest', new Types.ObjectId())],
      String(EMPLOYER),
    );
    expect(map.has(String(tid))).toBe(false);
  });

  it('omits a candidate_request thread whose institute page was deleted (lean fallback)', async () => {
    const svc = build().service as any;
    const leadId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.candidateRequestModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: leadId,
            companyPageId: new Types.ObjectId(),
            fromUserId: new Types.ObjectId(),
            status: 'sent',
            message: '',
          },
        ]),
      ),
    };
    svc.companyPageModel = { find: vi.fn(() => selLean([])) }; // page gone
    svc.userModel = { find: vi.fn(() => selLean([])) };

    const map = await svc.hydrateContexts(
      [ctxThread(tid, 'CandidateRequest', leadId)],
      String(EMPLOYER),
    );
    expect(map.has(String(tid))).toBe(false);
  });

  it('regression: still hydrates an inquiry thread into a product card', async () => {
    const svc = build().service as any;
    const inquiryId = new Types.ObjectId();
    const listingId = new Types.ObjectId();
    const tid = new Types.ObjectId();
    svc.inquiryModel = {
      find: vi.fn(() => selLean([{ _id: inquiryId, listingId, status: 'viewed' }])),
    };
    svc.listingModel = {
      find: vi.fn(() =>
        selLean([
          {
            _id: listingId,
            title: 'Zari saree',
            images: ['cover.jpg'],
            priceType: 'fixed',
            priceMin: 1450,
            priceMax: null,
            unit: 'piece',
            moq: 10,
          },
        ]),
      ),
    };

    const map = await svc.hydrateContexts([ctxThread(tid, 'Inquiry', inquiryId)], String(EMPLOYER));
    expect(map.get(String(tid))).toMatchObject({
      kind: 'inquiry',
      listingId: String(listingId),
      title: 'Zari saree',
      coverImage: 'cover.jpg',
      priceMin: 1450,
      unit: 'piece',
      moq: 10,
      status: 'viewed',
    });
  });
});

// buildPersonTimeline merges all of a pair's non-system threads into one
// createdAt-sorted stream: one context-card item per context thread + each
// thread's messages. hydrateContexts is stubbed here (it has its own tests).
describe('InboxService.buildPersonTimeline (unified per-person view)', () => {
  const leanExec = (val: unknown) => ({ lean: () => exec(val) });

  it('merges threads into one createdAt-sorted timeline with one card per context', async () => {
    const svc = build().service as any;
    const dmId = new Types.ObjectId();
    const appId = new Types.ObjectId();
    const t1 = '2026-06-14T09:05:00.000Z'; // application thread created
    const t2 = '2026-06-14T09:10:00.000Z'; // dm message sent (later)

    svc.threadModel.find = vi.fn(() =>
      leanExec([
        {
          _id: dmId,
          channelType: 'dm',
          contextEntityType: null,
          contextEntityId: null,
          createdAt: new Date('2026-06-14T08:00:00.000Z'),
          lastActivityAt: new Date(t2),
        },
        {
          _id: appId,
          channelType: 'application',
          contextEntityType: 'JobApplication',
          contextEntityId: appId,
          createdAt: new Date(t1),
          lastActivityAt: new Date(t1),
        },
      ]),
    );
    // Stub hydration: only the application thread resolves a card. (await on a
    // plain Map is fine; non-async keeps eslint's require-await happy.)
    svc.hydrateContexts = vi.fn(() =>
      Promise.resolve(
        new Map([[String(appId), { kind: 'application', jobId: 'J', title: 'Aari karigar' }]]),
      ),
    );
    // dm has one message ("hi"); the application thread has none yet.
    svc.messageModel.find = vi.fn((q: any) =>
      String(q.threadId) === String(dmId)
        ? {
            sort: () => ({
              limit: () =>
                exec([
                  {
                    _id: new Types.ObjectId(),
                    threadId: dmId,
                    seq: 1,
                    kind: 'text',
                    body: 'hi',
                    senderUserId: ME,
                    media: [],
                    createdAt: new Date(t2),
                  },
                ]),
            }),
          }
        : { sort: () => ({ limit: () => exec([]) }) },
    );

    const res = await svc.buildPersonTimeline(ME.toHexString(), OTHER.toHexString());

    // Sorted by createdAt: application card (t1) before the dm message (t2).
    expect(res.items.map((i: any) => i.type)).toEqual(['context', 'message']);
    expect(res.items[0]).toMatchObject({ type: 'context', threadId: String(appId) });
    expect(res.items[1]).toMatchObject({ type: 'message', threadId: String(dmId) });
    expect(res.items[1].message.body).toBe('hi');
    // Per-thread cursors for both threads; dm newest seq = 1.
    expect(res.threads.find((c: any) => c.threadId === String(dmId)).newestSeq).toBe(1);
  });

  it("exposes the other party's lastReadSeq per thread (read receipts)", async () => {
    const svc = build().service as any;
    const dmId = new Types.ObjectId();
    svc.threadModel.find = vi.fn(() =>
      leanExec([
        {
          _id: dmId,
          channelType: 'dm',
          contextEntityType: null,
          contextEntityId: null,
          createdAt: new Date('2026-06-14T08:00:00.000Z'),
          lastActivityAt: new Date('2026-06-14T09:10:00.000Z'),
          // ME read up to 9; OTHER only up to 4 -> my seq-5 message is unread by them.
          participants: [
            { userId: ME, unreadCount: 0, lastReadSeq: 9 },
            { userId: OTHER, unreadCount: 0, lastReadSeq: 4 },
          ],
        },
      ]),
    );
    svc.hydrateContexts = vi.fn(() => Promise.resolve(new Map()));
    svc.messageModel.find = vi.fn(() => ({
      sort: () => ({
        limit: () =>
          exec([
            {
              _id: new Types.ObjectId(),
              threadId: dmId,
              seq: 5,
              kind: 'text',
              body: 'hi',
              senderUserId: ME,
              media: [],
              createdAt: new Date('2026-06-14T09:10:00.000Z'),
            },
          ]),
      }),
    }));

    const res = await svc.buildPersonTimeline(ME.toHexString(), OTHER.toHexString());
    const cursor = res.threads.find((c: any) => c.threadId === String(dmId));
    expect(cursor.otherLastReadSeq).toBe(4); // the OTHER party's watermark, not mine (9)
  });

  it('returns an empty timeline when the pair shares no threads', async () => {
    const svc = build().service as any;
    svc.threadModel.find = vi.fn(() => leanExec([]));
    const res = await svc.buildPersonTimeline(ME.toHexString(), OTHER.toHexString());
    expect(res.items).toEqual([]);
    expect(res.threads).toEqual([]);
  });
});
