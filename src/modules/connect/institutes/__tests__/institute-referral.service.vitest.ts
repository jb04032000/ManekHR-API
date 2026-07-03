/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (ConnectPageInvite / User) skip vitest's reflect-metadata pipeline.
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
// branch can run without spinning up the SDK.
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { InstituteReferralService } from '../institute-referral.service';

/**
 * Unit coverage for `InstituteReferralService` (Institutes Phase 2, Feature 5:
 * first-touch referral attribution on `connect.profile.created`). Exercises:
 *   - the happy path stamps `User.invitedByCompanyPageId` (first-touch) + claims
 *     the matching invite rows;
 *   - first-touch ONLY: an already-attributed user is NOT overwritten;
 *   - EARLIEST invite wins (the lookup sorts by createdAt ascending);
 *   - a user whose mobile has NO matching invite is left unattributed (no throw);
 *   - the handler NEVER throws (a DB fault is swallowed);
 *   - non-ObjectId / missing-user events are ignored.
 * Models are mocked.
 */

const USER_ID = new Types.ObjectId();
const PAGE_A = new Types.ObjectId();
const PAGE_B = new Types.ObjectId();
const MOBILE = '919876543210';

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

function build() {
  const inviteModel: any = {
    findOne: vi.fn(() => chain(null)),
    updateMany: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }) })),
  };
  const userModel: any = {
    findById: vi.fn(() => chain(null)),
    updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }) })),
  };
  const service = new InstituteReferralService(inviteModel, userModel);
  return { service, inviteModel, userModel };
}

/** Wire a user lookup result onto the model. */
function withUser(f: ReturnType<typeof build>, user: unknown) {
  f.userModel.findById = vi.fn(() => chain(user));
}

/** Wire the earliest-invite lookup result onto the model. */
function withWinner(f: ReturnType<typeof build>, winner: unknown) {
  f.inviteModel.findOne = vi.fn(() => chain(winner));
}

beforeEach(() => vi.clearAllMocks());

describe('InstituteReferralService.onProfileCreated', () => {
  it('stamps invitedByCompanyPageId (first-touch) + claims the matching invites', async () => {
    const f = build();
    withUser(f, { _id: USER_ID, mobile: MOBILE, invitedByCompanyPageId: null });
    withWinner(f, { _id: new Types.ObjectId(), companyPageId: PAGE_A });
    const updateOneExec = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    f.userModel.updateOne = vi.fn(() => ({ exec: updateOneExec }));
    const updateManyExec = vi.fn().mockResolvedValue({ modifiedCount: 2 });
    f.inviteModel.updateMany = vi.fn(() => ({ exec: updateManyExec }));

    await f.service.onProfileCreated({ userId: USER_ID.toHexString() });

    // First-touch stamp: conditional on invitedByCompanyPageId:null + sets PAGE_A.
    const stampFilter = f.userModel.updateOne.mock.calls[0][0];
    const stampUpdate = f.userModel.updateOne.mock.calls[0][1];
    expect(stampFilter._id).toEqual(USER_ID);
    expect(stampFilter.invitedByCompanyPageId).toBeNull();
    expect(stampUpdate.$set.invitedByCompanyPageId).toEqual(PAGE_A);

    // Sibling invites for the mobile flip invited -> claimed.
    const claimFilter = f.inviteModel.updateMany.mock.calls[0][0];
    const claimUpdate = f.inviteModel.updateMany.mock.calls[0][1];
    expect(claimFilter.inviteeMobile).toBe(MOBILE);
    expect(claimFilter.status).toBe('invited');
    expect(claimUpdate.$set.status).toBe('claimed');
    expect(claimUpdate.$set.claimedUserId).toEqual(USER_ID);
    expect(updateManyExec).toHaveBeenCalled();
  });

  it('first-touch ONLY: an already-attributed user is NOT overwritten (no stamp, no claim)', async () => {
    const f = build();
    // The user already has a referral source -> a second profile.created is a no-op.
    withUser(f, { _id: USER_ID, mobile: MOBILE, invitedByCompanyPageId: PAGE_B });

    await f.service.onProfileCreated({ userId: USER_ID.toHexString() });

    expect(f.inviteModel.findOne).not.toHaveBeenCalled();
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.inviteModel.updateMany).not.toHaveBeenCalled();
  });

  it('EARLIEST invite wins: the lookup sorts by createdAt ascending', async () => {
    const f = build();
    withUser(f, { _id: USER_ID, mobile: MOBILE, invitedByCompanyPageId: null });
    // PAGE_A invited first (earliest) -> it is the winner the query returns.
    const sortSpy = vi.fn(() => sortObj);
    const sortObj: any = {
      select: vi.fn(() => sortObj),
      lean: vi.fn(() => sortObj),
      exec: vi.fn().mockResolvedValue({ _id: new Types.ObjectId(), companyPageId: PAGE_A }),
    };
    f.inviteModel.findOne = vi.fn(() => ({ sort: sortSpy }));

    await f.service.onProfileCreated({ userId: USER_ID.toHexString() });

    // The lookup filters invited + non-expired and sorts createdAt:1 (earliest).
    const lookupFilter = f.inviteModel.findOne.mock.calls[0][0];
    expect(lookupFilter.inviteeMobile).toBe(MOBILE);
    expect(lookupFilter.status).toBe('invited');
    expect(lookupFilter.inviteExpiry.$gt).toBeInstanceOf(Date);
    expect(sortSpy).toHaveBeenCalledWith({ createdAt: 1 });
    // The winner page (PAGE_A) is what gets stamped.
    expect(f.userModel.updateOne.mock.calls[0][1].$set.invitedByCompanyPageId).toEqual(PAGE_A);
  });

  it('leaves a user with NO matching invite unattributed (no stamp, no throw)', async () => {
    const f = build();
    withUser(f, { _id: USER_ID, mobile: MOBILE, invitedByCompanyPageId: null });
    withWinner(f, null); // mobile was never invited.

    await expect(
      f.service.onProfileCreated({ userId: USER_ID.toHexString() }),
    ).resolves.toBeUndefined();
    expect(f.userModel.updateOne).not.toHaveBeenCalled();
    expect(f.inviteModel.updateMany).not.toHaveBeenCalled();
  });

  it('does not claim invites when the conditional stamp wins nothing (concurrent race)', async () => {
    const f = build();
    withUser(f, { _id: USER_ID, mobile: MOBILE, invitedByCompanyPageId: null });
    withWinner(f, { _id: new Types.ObjectId(), companyPageId: PAGE_A });
    // The conditional updateOne modifies 0 rows (another run stamped first).
    f.userModel.updateOne = vi.fn(() => ({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    }));

    await f.service.onProfileCreated({ userId: USER_ID.toHexString() });

    expect(f.inviteModel.updateMany).not.toHaveBeenCalled();
  });

  it('NEVER throws: a DB fault during the user lookup is swallowed', async () => {
    const f = build();
    f.userModel.findById = vi.fn(() => {
      throw new Error('mongo down');
    });
    await expect(
      f.service.onProfileCreated({ userId: USER_ID.toHexString() }),
    ).resolves.toBeUndefined();
  });

  it('ignores a missing user (no mobile -> no attribution)', async () => {
    const f = build();
    withUser(f, null);
    await f.service.onProfileCreated({ userId: USER_ID.toHexString() });
    expect(f.inviteModel.findOne).not.toHaveBeenCalled();
  });

  it('ignores an event with an invalid (non-ObjectId) userId (no lookup)', async () => {
    const f = build();
    await f.service.onProfileCreated({ userId: 'not-an-objectid' });
    expect(f.userModel.findById).not.toHaveBeenCalled();
  });
});
