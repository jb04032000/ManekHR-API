/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (User / ConnectReferral) skip vitest's reflect-metadata pipeline.
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

// Sentry-nestjs swallows errors with no transport; stub it so the defensive catch
// branches run without spinning up the SDK.
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { ReferralService } from '../services/referral.service';

/**
 * Unit coverage for `ReferralService.getOrCreateMyCode` (Phase 4a, Task 7
 * collision retry) and `attachReferralAtSignup` (Phase 4a, Task 8). Exercises:
 *   - getOrCreateMyCode returns the existing code; generates + retries on E11000;
 *   - attach: disabled config -> no-op; unknown code -> no-op; self-referral
 *     (own code + shared mobile/email) -> no-op; already-referred -> no-op;
 *     disposable email -> no-op; happy path creates a pending row + stamps
 *     referredByUserId; never throws on a DB fault.
 * Models + the config service are mocked.
 */

const REFEREE_ID = new Types.ObjectId();
const REFERRER_ID = new Types.ObjectId();
const CODE = 'RAJEAB23';

/** Fluent chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

const ENABLED_CFG = {
  enabled: true,
  referrerCredits: 50,
  refereeCredits: 50,
  holdbackDays: 7,
  perReferrerCap: 0,
  monthlyPerReferrerCap: 0,
  annualCreditCeilingPerUser: 19000,
  totalBudgetCap: 0,
  dailyVelocityPerReferrer: 10,
};

function build(cfg: any = ENABLED_CFG) {
  const configService: any = { getConfig: vi.fn().mockResolvedValue(cfg) };
  const userModel: any = {
    findById: vi.fn(() => chain(null)),
    findOne: vi.fn(() => chain(null)),
    updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
  };
  const referralModel: any = {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    findOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
  };
  // Phase 4b added two constructor deps; this 4a spec never exercises them, but
  // they are required positionally, so pass inert mocks.
  const wallet: any = { creditReferral: vi.fn(), adjust: vi.fn() };
  const audit: any = { logEvent: vi.fn() };
  // ConnectProfile model (ordering safety-net): default = referee has NO profile,
  // so the happy path stays a plain `pending` create (no immediate qualify).
  const profileModel: any = {
    exists: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(null) })),
  };
  const service = new ReferralService(
    configService,
    userModel,
    referralModel,
    wallet,
    audit,
    profileModel,
  );
  return { service, configService, userModel, referralModel, profileModel };
}

beforeEach(() => vi.clearAllMocks());

describe('ReferralService.getOrCreateMyCode', () => {
  it('returns the existing referralCode without writing', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() =>
      chain({ name: 'Rajesh', handle: null, referralCode: 'EXISTING9' }),
    );
    const code = await f.service.getOrCreateMyCode(REFERRER_ID.toHexString());
    expect(code).toBe('EXISTING9');
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
  });

  it('generates + persists a new code when none exists', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() =>
      chain({ name: 'Rajesh Patel', handle: null, referralCode: null }),
    );
    const code = await f.service.getOrCreateMyCode(REFERRER_ID.toHexString());
    expect(code).toMatch(/^[A-Z2-9]{6,10}$/);
    expect(f.userModel.updateOne).toHaveBeenCalledTimes(1);
    // Conditional set guards against an existing code (first-code-wins on self).
    const setUpdate = f.userModel.updateOne.mock.calls[0][1];
    expect(setUpdate.$set.referralCode).toBe(code);
  });

  it('retries on a unique-index collision (E11000) then succeeds', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() => chain({ name: 'Rajesh', handle: null, referralCode: null }));
    // First updateOne throws E11000 (code taken by someone else); second succeeds.
    let calls = 0;
    f.userModel.updateOne = vi.fn(() => ({
      // First call rejects with a typed E11000 Error; second resolves.
      exec: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          const e = new Error('E11000 duplicate key') as Error & { code: number };
          e.code = 11000;
          return Promise.reject(e);
        }
        return Promise.resolve({ modifiedCount: 1 });
      }),
    }));
    const code = await f.service.getOrCreateMyCode(REFERRER_ID.toHexString());
    expect(code).toMatch(/^[A-Z2-9]{6,10}$/);
    expect(f.userModel.updateOne).toHaveBeenCalledTimes(2);
  });

  it('returns the PERSISTED code (not the generated one) when the conditional updateOne loses the race (modifiedCount === 0)', async () => {
    const f = build();
    const PERSISTED_CODE = 'WINNER99';

    // Initial findById: user has no code yet (both concurrent callers see null).
    // Second findById (re-read after losing race): returns the winner's persisted code.
    let findByIdCallCount = 0;
    f.userModel.findById = vi.fn(() => {
      findByIdCallCount += 1;
      if (findByIdCallCount === 1) {
        // First call: no code yet (the race has not been decided).
        return chain({ name: 'Priya', handle: null, referralCode: null });
      }
      // Second call (re-read after modifiedCount === 0): winner's code is stored.
      return chain({ referralCode: PERSISTED_CODE });
    });

    // updateOne succeeds structurally but wins nothing (another writer got there first).
    f.userModel.updateOne = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    }));

    const code = await f.service.getOrCreateMyCode(REFERRER_ID.toHexString());

    // Must return what the DB actually holds, not the locally-generated string.
    expect(code).toBe(PERSISTED_CODE);
    // Exactly one updateOne attempt (the race-losing one); no E11000 retry loop.
    expect(f.userModel.updateOne).toHaveBeenCalledTimes(1);
    // Two findById calls: initial read + re-read after losing the race.
    expect(f.userModel.findById).toHaveBeenCalledTimes(2);
  });
});

describe('ReferralService.attachReferralAtSignup', () => {
  it('is a no-op when the feature is disabled', async () => {
    const f = build({ ...ENABLED_CFG, enabled: false });
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.findOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op when no code is supplied', async () => {
    const f = build();
    await f.service.attachReferralAtSignup({ refereeUserId: REFEREE_ID.toHexString(), code: '' });
    expect(f.configService.getConfig).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown code', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() => chain(null)); // code resolves to nobody.
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op when the referrer account is inactive (banned/deactivated)', async () => {
    const f = build();
    // Code resolves to a real OTHER user, but that referrer is deactivated.
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com', isActive: false }),
    );
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    // Bailed before loading the referee / stamping / creating a row.
    expect(f.userModel.findById).not.toHaveBeenCalled();
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op for self-referral (the code is the referee own code)', async () => {
    const f = build();
    // The resolved referrer IS the referee.
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFEREE_ID, mobile: '91999', email: 'a@b.com' }),
    );
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.findById).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op for self-referral by shared mobile', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '919876543210', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '919876543210', email: 'e@y.com', referredByUserId: null }),
    );
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op when the referee is already referred (first-code-wins)', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'e@y.com', referredByUserId: new Types.ObjectId() }),
    );
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op when the referee email is disposable', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'burner@mailinator.com', referredByUserId: null }),
    );
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('is a no-op when the referrer hit the daily velocity cap', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'e@y.com', referredByUserId: null }),
    );
    f.referralModel.countDocuments = vi.fn().mockResolvedValue(10); // == cap (10).
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('happy path: stamps referredByUserId once + creates a pending row', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'e@y.com', referredByUserId: null }),
    );
    const stampExec = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    f.userModel.updateOne = vi.fn(() => ({ exec: stampExec }));

    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: 'rajeab23', // lower-case input is normalised to upper.
      signupContext: { ipHash: 'h', refereeMobileSnapshot: '92222' },
    });

    // First-code-wins stamp: conditional on referredByUserId:null.
    const stampFilter = f.userModel.updateOne.mock.calls[0][0];
    const stampUpdate = f.userModel.updateOne.mock.calls[0][1];
    expect(stampFilter.referredByUserId).toBeNull();
    expect(stampUpdate.$set.referredByUserId).toEqual(REFERRER_ID);

    // Pending row created with the normalised code + carried signupContext.
    expect(f.referralModel.create).toHaveBeenCalledTimes(1);
    const created = f.referralModel.create.mock.calls[0][0];
    expect(created.referrerUserId).toEqual(REFERRER_ID);
    expect(created.refereeUserId).toEqual(REFEREE_ID);
    expect(created.codeUsed).toBe('RAJEAB23');
    expect(created.status).toBe('pending');
    expect(created.signupContext).toEqual({ ipHash: 'h', refereeMobileSnapshot: '92222' });
  });

  it('referee already has a Connect profile at attach time -> row qualifies immediately (event/attach ordering race)', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'e@y.com', referredByUserId: null }),
    );
    f.userModel.updateOne = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));

    // The referee ALREADY has a profile (they activated Connect before the
    // fire-and-forget attribution ran -> the profile-created event fired before
    // this row existed, so the normal event-driven qualify missed it).
    f.profileModel.exists = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    }));
    // The freshly-created `pending` row the attach path then qualifies in place.
    const save = vi.fn().mockResolvedValue(undefined);
    const pendingRow: any = {
      status: 'pending',
      referrerCreditAmount: 0,
      refereeCreditAmount: 0,
      qualifiedAt: undefined,
      save,
    };
    f.referralModel.findOne = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue(pendingRow),
    }));

    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });

    // The pending row was created AND immediately promoted to qualified with
    // amounts snapshotted from the live config (no waiting for the cron/event).
    expect(f.referralModel.create).toHaveBeenCalledTimes(1);
    expect(f.profileModel.exists).toHaveBeenCalledTimes(1);
    // Looked up the just-created PENDING row to qualify it.
    const qualifyFilter = f.referralModel.findOne.mock.calls[0][0];
    expect(qualifyFilter.refereeUserId).toBe(REFEREE_ID.toHexString());
    expect(qualifyFilter.status).toBe('pending');
    expect(pendingRow.status).toBe('qualified');
    expect(pendingRow.qualifiedAt).toBeInstanceOf(Date);
    expect(pendingRow.referrerCreditAmount).toBe(50); // snapshot from ENABLED_CFG.
    expect(pendingRow.refereeCreditAmount).toBe(50);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('referee has NO profile yet -> row stays pending (normal flow, event will qualify later)', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'e@y.com', referredByUserId: null }),
    );
    f.userModel.updateOne = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
    // Default profileModel.exists -> null (no profile). The attach path must NOT
    // qualify (no profile = not activated yet) -> it never even looks up the row.
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });

    expect(f.referralModel.create).toHaveBeenCalledTimes(1);
    expect(f.profileModel.exists).toHaveBeenCalledTimes(1);
    // No profile -> no qualify lookup happened (row left `pending`).
    expect(f.referralModel.findOne).not.toHaveBeenCalled();
  });

  it('does not create a row when the conditional stamp wins nothing (race)', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() =>
      chain({ _id: REFERRER_ID, mobile: '91111', email: 'r@x.com' }),
    );
    f.userModel.findById = vi.fn(() =>
      chain({ mobile: '92222', email: 'e@y.com', referredByUserId: null }),
    );
    f.userModel.updateOne = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }), // another run stamped first.
    }));
    await f.service.attachReferralAtSignup({
      refereeUserId: REFEREE_ID.toHexString(),
      code: CODE,
    });
    expect(f.referralModel.create).not.toHaveBeenCalled();
  });

  it('NEVER throws: a DB fault during attribution is swallowed', async () => {
    const f = build();
    f.userModel.findOne = vi.fn(() => {
      throw new Error('mongo down');
    });
    await expect(
      f.service.attachReferralAtSignup({ refereeUserId: REFEREE_ID.toHexString(), code: CODE }),
    ).resolves.toBeUndefined();
  });
});
