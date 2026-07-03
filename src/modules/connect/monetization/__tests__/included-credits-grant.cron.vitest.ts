/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the cron so the transitive
// decorated schema imports (Subscription, and WalletService's ad schemas) do not
// trip vitest's reflect-metadata pipeline. Dependencies are injected as mocks.
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

// The @Cron() decorator must be inert in the unit context (no scheduler).
vi.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

import { IncludedCreditsGrantCron } from '../crons/included-credits-grant.cron';

/**
 * M0.6 - Included-boost-credit grant cron.
 *
 * Verifies the per-cycle grant orchestration (the wallet grant primitive itself
 * is covered by wallet.service.vitest.ts):
 *   - queries only active product:'connect' subs that include boost credits,
 *   - sweeps expired grants (expireGrants) then grants includedBoostCredits with
 *     a cycle-stable idempotency key (so a daily re-run is a no-op) + cycle expiry,
 *   - skips a sub missing its billing period,
 *   - no-ops on an empty candidate set,
 *   - one failing sub does not abort the rest of the sweep.
 */
const userId = '64b2f0000000000000000010';
const subId = '64b2f0000000000000000020';
const periodStart = new Date('2026-05-01T00:00:00.000Z');
const periodEnd = new Date('2026-06-01T00:00:00.000Z');

const findChain = (rows: any[]) => ({ lean: () => ({ exec: () => Promise.resolve(rows) }) });

describe('IncludedCreditsGrantCron (M0.6)', () => {
  let subModel: { find: ReturnType<typeof vi.fn> };
  let wallet: { grant: ReturnType<typeof vi.fn>; expireGrants: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    wallet = {
      grant: vi.fn().mockResolvedValue(undefined),
      expireGrants: vi.fn().mockResolvedValue(0),
    };
  });

  const build = (rows: any[]) => {
    subModel = { find: vi.fn(() => findChain(rows)) };
    return new IncludedCreditsGrantCron(subModel as any, wallet as any);
  };

  it('queries only active connect subs that include boost credits', async () => {
    const cron = build([]);
    await cron.run();
    const filter = subModel.find.mock.calls[0][0];
    expect(filter.status).toBe('active');
    expect(filter.product).toBe('connect');
    expect(filter['appliedEntitlements.connect.includedBoostCredits']).toEqual({ $gt: 0 });
  });

  it('sweeps expired grants then grants includedBoostCredits once per cycle (cycle-stable key)', async () => {
    const cron = build([
      {
        _id: subId,
        userId,
        product: 'connect',
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        appliedEntitlements: { connect: { includedBoostCredits: 500 } },
      },
    ]);

    await cron.run();

    expect(wallet.expireGrants).toHaveBeenCalledWith(userId);
    expect(wallet.grant).toHaveBeenCalledTimes(1);
    const [gUser, gAmount, gOpts] = wallet.grant.mock.calls[0];
    expect(gUser).toBe(userId);
    expect(gAmount).toBe(500);
    expect(gOpts.idempotencyKey).toBe(`grant-${subId}-${periodStart.getTime()}`);
    expect(gOpts.expiresAt).toEqual(periodEnd);
  });

  it('skips a sub missing its billing period (cannot key idempotency safely)', async () => {
    const cron = build([
      {
        _id: subId,
        userId,
        product: 'connect',
        status: 'active',
        appliedEntitlements: { connect: { includedBoostCredits: 500 } },
      },
    ]);

    await cron.run();

    expect(wallet.grant).not.toHaveBeenCalled();
  });

  it('does nothing when there are no eligible subscriptions', async () => {
    const cron = build([]);
    await cron.run();
    expect(wallet.expireGrants).not.toHaveBeenCalled();
    expect(wallet.grant).not.toHaveBeenCalled();
  });

  it('continues granting to other subs when one sub throws', async () => {
    const otherUser = '64b2f0000000000000000099';
    const otherSub = '64b2f0000000000000000098';
    wallet.grant
      .mockRejectedValueOnce(new Error('boom')) // first sub fails
      .mockResolvedValueOnce(undefined); // second sub still attempted
    const cron = build([
      {
        _id: subId,
        userId,
        product: 'connect',
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        appliedEntitlements: { connect: { includedBoostCredits: 500 } },
      },
      {
        _id: otherSub,
        userId: otherUser,
        product: 'connect',
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        appliedEntitlements: { connect: { includedBoostCredits: 300 } },
      },
    ]);

    await cron.run();

    expect(wallet.grant).toHaveBeenCalledTimes(2);
    expect(wallet.grant.mock.calls[1][0]).toBe(otherUser);
  });
});
