/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * WalletService.creditReferral() -- TDD spec (Connect referral money path).
 *
 * Covers the referral reward credit into the permanent spendable `balance`:
 *   - happy path: increments balance by +amount, writes ONE 'referral' ledger
 *     row carrying the idempotencyKey, returns { ledgerId, balanceAfter }.
 *   - idempotency: a second call with the SAME idempotencyKey does NOT
 *     re-credit and returns the prior row (credited exactly once).
 *   - amount <= 0 throws BadRequestException and writes NO ledger row.
 *
 * The @nestjs/mongoose decorators are stubbed BEFORE importing the service so
 * the transitive schema imports do not trip vitest's reflect-metadata pipeline
 * (same approach as wallet.adjust.vitest.ts). The wallet uses the shared
 * in-memory mock; the ledger uses a local mock that mirrors the shared one but
 * assigns an `_id` on create so the returned `ledgerId` is meaningful.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { BadRequestException } from '@nestjs/common';
import { WalletService } from '../services/wallet.service';
import { createWalletModelMock } from './helpers/ad-model-mocks';

const USER = '64a000000000000000000001';

/**
 * Local ledger mock: same partial-unique idempotencyKey semantics as the shared
 * helper, but assigns a stable `_id` on create so creditReferral can return a
 * real `ledgerId`. Kept local so the shared helper stays untouched.
 */
function createLedgerModelMockWithId() {
  const rows: Array<Record<string, any>> = [];
  let seq = 0;
  return {
    _rows: rows,
    findOne(filter: Record<string, any>) {
      const match = rows.find((r) => {
        for (const [k, v] of Object.entries(filter)) {
          if (r[k] !== v) return false;
        }
        return true;
      });
      return Promise.resolve(match ?? null);
    },
    create(doc: Record<string, any>) {
      if (doc.idempotencyKey !== undefined) {
        const existing = rows.find((r) => r.idempotencyKey === doc.idempotencyKey);
        if (existing) {
          const err = new Error('E11000 duplicate key') as Error & { code: number };
          err.code = 11000;
          return Promise.reject(err);
        }
      }
      seq += 1;
      const row = { _id: `64c0000000000000000000${String(seq).padStart(2, '0')}`, ...doc };
      rows.push(row);
      return Promise.resolve(row);
    },
  };
}

function makeSvc() {
  const walletModel = createWalletModelMock();
  const ledgerModel = createLedgerModelMockWithId();
  const svc = new WalletService(walletModel as any, ledgerModel as any);
  return { svc, walletModel, ledgerModel };
}

describe('WalletService.creditReferral()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('credits +50 into balance, writes a referral ledger row with the key, and returns { ledgerId, balanceAfter }', async () => {
    const { svc, walletModel, ledgerModel } = makeSvc();
    // Seed an existing wallet at 100 to prove the increment.
    walletModel._store.set(USER, { ownerUserId: USER, balance: 100, reserved: 0 });

    const result = await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R1:referrer',
      referralId: 'R1',
      recordedBy: 'sys',
    });

    // Balance incremented 100 -> 150.
    expect(walletModel._store.get(USER)?.balance).toBe(150);
    expect(result.balanceAfter).toBe(150);
    expect(result.ledgerId).toBeTruthy();

    // Exactly one referral ledger row with the idempotency key + post-state.
    const referralRows = ledgerModel._rows.filter((r) => r.type === 'referral');
    expect(referralRows).toHaveLength(1);
    expect(referralRows[0].amount).toBe(50);
    expect(referralRows[0].balanceAfter).toBe(150);
    expect(referralRows[0].idempotencyKey).toBe('referral:R1:referrer');
    expect(referralRows[0].recordedBy).toBe('sys');
    expect(referralRows[0].note).toBe('referral:R1');
    expect(referralRows[0].ownerUserId).toBe(USER);
    // The returned ledgerId matches the written row.
    expect(result.ledgerId).toBe(referralRows[0]._id);
  });

  it('credits into a never-before-seen wallet (upsert) starting from 0', async () => {
    const { svc, walletModel, ledgerModel } = makeSvc();

    const result = await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R2:referee',
      referralId: 'R2',
    });

    expect(result.balanceAfter).toBe(50);
    expect(walletModel._store.get(USER)?.balance).toBe(50);
    expect(ledgerModel._rows.filter((r) => r.type === 'referral')).toHaveLength(1);
  });

  it('is idempotent: a second call with the same key does NOT re-credit and returns the prior row', async () => {
    const { svc, walletModel, ledgerModel } = makeSvc();
    walletModel._store.set(USER, { ownerUserId: USER, balance: 0, reserved: 0 });

    const first = await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R1:referrer',
      referralId: 'R1',
      recordedBy: 'sys',
    });
    expect(walletModel._store.get(USER)?.balance).toBe(50);

    // Second call with the SAME key: no second balance change, same row back.
    const second = await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R1:referrer',
      referralId: 'R1',
      recordedBy: 'sys',
    });

    // Balance credited exactly once.
    expect(walletModel._store.get(USER)?.balance).toBe(50);
    expect(second.balanceAfter).toBe(50);
    // Same ledger row id is returned.
    expect(second.ledgerId).toBe(first.ledgerId);
    // Exactly one referral ledger row exists for the key.
    expect(ledgerModel._rows.filter((r) => r.type === 'referral')).toHaveLength(1);
  });

  it('reverts the balance increment if the ledger insert loses the unique race', async () => {
    const { svc, walletModel, ledgerModel } = makeSvc();
    walletModel._store.set(USER, { ownerUserId: USER, balance: 0, reserved: 0 });

    // First credit lands a row for the key.
    const first = await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R3:referrer',
      referralId: 'R3',
    });
    expect(walletModel._store.get(USER)?.balance).toBe(50);

    // Simulate a racing sibling that MISSED the fast-path read: force the dedup
    // findOne to return null once so the second call proceeds to $inc, then
    // ledger.create throws 11000 (row already exists) and the balance is
    // reverted back to 50 and the winning row is returned.
    const findOneSpy = vi.spyOn(ledgerModel, 'findOne').mockResolvedValueOnce(null);
    const reverted = await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R3:referrer',
      referralId: 'R3',
    });
    findOneSpy.mockRestore();

    expect(walletModel._store.get(USER)?.balance).toBe(50); // credited exactly once
    expect(reverted.ledgerId).toBe(first.ledgerId);
    expect(reverted.balanceAfter).toBe(50);
    expect(ledgerModel._rows.filter((r) => r.type === 'referral')).toHaveLength(1);
  });

  it('throws BadRequestException for amount = 0 and writes NO ledger row', async () => {
    const { svc, walletModel, ledgerModel } = makeSvc();
    walletModel._store.set(USER, { ownerUserId: USER, balance: 100, reserved: 0 });

    await expect(
      svc.creditReferral(USER, 0, { idempotencyKey: 'referral:R4:referrer' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(ledgerModel._rows).toHaveLength(0);
    expect(walletModel._store.get(USER)?.balance).toBe(100); // untouched
  });

  it('throws BadRequestException for a negative amount and writes NO ledger row', async () => {
    const { svc, walletModel, ledgerModel } = makeSvc();
    walletModel._store.set(USER, { ownerUserId: USER, balance: 100, reserved: 0 });

    await expect(
      svc.creditReferral(USER, -25, { idempotencyKey: 'referral:R5:referrer' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(ledgerModel._rows).toHaveLength(0);
    expect(walletModel._store.get(USER)?.balance).toBe(100);
  });

  it('emits ads.referral_credit on a successful credit when posthog is provided', async () => {
    const walletModel = createWalletModelMock();
    const ledgerModel = createLedgerModelMockWithId();
    const mockPosthog = { capture: vi.fn() };
    const svc = new WalletService(walletModel as any, ledgerModel as any, mockPosthog as any);

    await svc.creditReferral(USER, 50, {
      idempotencyKey: 'referral:R6:referrer',
      referralId: 'R6',
    });

    expect(mockPosthog.capture).toHaveBeenCalledOnce();
    const call = mockPosthog.capture.mock.calls[0][0];
    expect(call.event).toBe('ads.referral_credit');
    expect(call.distinctId).toBe(USER);
    expect(call.properties.amount).toBe(50);
    expect(call.properties.balanceAfter).toBe(50);
  });
});
