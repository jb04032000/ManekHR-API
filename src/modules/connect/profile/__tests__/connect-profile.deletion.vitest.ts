/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ConnectProfileService — Scope-1 "delete Connect" reversible soft phase
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A): hide-with-snapshot + recovery un-hide.
 */
import { describe, it, expect, vi } from 'vitest';

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

import { ConnectProfileService } from '../connect-profile.service';

const USER = '6a0a8f515ea9af111dd403bd';

/** Profile model mock that records updateOne calls + serves a queue of findOne reads. */
function mockProfileModel(reads: Array<Record<string, unknown> | null>) {
  const updateOne = vi.fn(() => ({ exec: () => Promise.resolve({ modifiedCount: 1 }) }));
  const updateMany = vi.fn(() => ({ exec: () => Promise.resolve({ modifiedCount: 0 }) }));
  let i = 0;
  const findOne = vi.fn(() => {
    const result = reads[Math.min(i, reads.length - 1)];
    i += 1;
    const chain = {
      select: vi.fn(() => chain),
      lean: vi.fn(() => chain),
      exec: () => Promise.resolve(result),
    };
    return chain;
  });
  return { findOne, updateOne, updateMany } as any;
}

function build(reads: Array<Record<string, unknown> | null>) {
  const profileModel = mockProfileModel(reads);
  const emit = vi.fn(() => true);
  const svc = new ConnectProfileService(
    profileModel,
    { findById: vi.fn() } as any,
    { emit } as any,
    { getAllowances: vi.fn() } as any,
  );
  return { svc, profileModel, emit };
}

describe('ConnectProfileService.hideForConnectDeletion (Scope-1 soft phase)', () => {
  it('snapshots the prior visibility, then hides + de-indexes', async () => {
    // 1st findOne (snapshot read) sees a connections-only profile.
    const { svc, profileModel, emit } = build([
      { visibility: 'connections', preDeletionVisibility: null },
    ]);

    await svc.hideForConnectDeletion(USER);

    // The prior visibility is snapshotted so recovery can restore it exactly.
    const snapshotCall = profileModel.updateOne.mock.calls.find(
      (c: any[]) => c[1]?.$set?.preDeletionVisibility === 'connections',
    );
    expect(snapshotCall).toBeDefined();
    // removeFromConnectForErasure then flips visibility to hidden + revokes consent.
    const hideCall = profileModel.updateOne.mock.calls.find(
      (c: any[]) => c[1]?.$set?.visibility === 'hidden',
    );
    expect(hideCall).toBeDefined();
    // De-index emitted.
    expect(emit).toHaveBeenCalledWith('connect.profile.changed', { userId: USER });
  });

  it('does NOT overwrite an existing snapshot on a re-run (idempotent)', async () => {
    // Already hidden + already snapshotted → no new snapshot write.
    const { svc, profileModel } = build([
      { visibility: 'hidden', preDeletionVisibility: 'public' },
    ]);

    await svc.hideForConnectDeletion(USER);

    const snapshotCall = profileModel.updateOne.mock.calls.find(
      (c: any[]) => c[1]?.$set?.preDeletionVisibility !== undefined,
    );
    expect(snapshotCall).toBeUndefined();
  });
});

describe('ConnectProfileService.onContentTakedown (CN-MOD-1 profile takedown)', () => {
  it('hides + de-indexes a reported profile (profile targetType) without suspending the account', async () => {
    const { svc, profileModel, emit } = build([]);

    await svc.onContentTakedown({
      targetType: 'profile',
      targetId: USER,
      actorId: USER,
    });

    // Visibility flipped to hidden + ERP consent revoked (the shared hide tail).
    const hideCall = profileModel.updateOne.mock.calls.find(
      (c: any[]) => c[1]?.$set?.visibility === 'hidden',
    );
    expect(hideCall).toBeDefined();
    expect(hideCall[1].$set['erpVerificationConsent.status']).toBe('revoked');
    // Search de-index emitted.
    expect(emit).toHaveBeenCalledWith('connect.profile.changed', { userId: USER });
  });

  it('ignores a takedown event for a non-profile target type', async () => {
    const { svc, profileModel } = build([]);

    await svc.onContentTakedown({
      targetType: 'listing',
      targetId: USER,
      actorId: USER,
    });

    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('ConnectProfileService.unhideForConnectRecovery (Scope-1 recovery)', () => {
  it('restores the snapshotted prior visibility, clears it, and re-indexes', async () => {
    const { svc, profileModel, emit } = build([{ preDeletionVisibility: 'connections' }]);

    await svc.unhideForConnectRecovery(USER);

    const restore = profileModel.updateOne.mock.calls[0];
    expect(restore[1].$set.visibility).toBe('connections');
    expect(restore[1].$unset.preDeletionVisibility).toBe('');
    expect(emit).toHaveBeenCalledWith('connect.profile.changed', { userId: USER });
  });

  it('defaults to public when no snapshot was captured', async () => {
    const { svc, profileModel } = build([{ preDeletionVisibility: null }]);

    await svc.unhideForConnectRecovery(USER);

    expect(profileModel.updateOne.mock.calls[0][1].$set.visibility).toBe('public');
  });
});
