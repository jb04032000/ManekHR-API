/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing WalletService so that the
// transitive schema imports do not trip vitest's reflect-metadata pipeline.
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
import { createWalletModelMock, createLedgerModelMock } from './helpers/ad-model-mocks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = 'user-test-001';
const CAMPAIGN = 'camp-abc';

function makeSvc() {
  const walletModel = createWalletModelMock();
  const ledgerModel = createLedgerModelMock();
  const svc = new WalletService(walletModel as any, ledgerModel as any);
  return { svc, walletModel, ledgerModel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletService', () => {
  // ---- getWallet -----------------------------------------------------------

  describe('getWallet', () => {
    it('returns an existing wallet without modifying it', async () => {
      const { svc, walletModel } = makeSvc();
      // Pre-seed a wallet with known state.
      walletModel._store.set(WS, {
        ownerUserId: WS,
        balance: 500,
        reserved: 100,
        lastTopUpAt: null,
      });

      const wallet = await svc.getWallet(WS);

      expect(wallet.ownerUserId).toBe(WS);
      expect(wallet.balance).toBe(500);
      expect(wallet.reserved).toBe(100);
    });

    it('upserts an empty wallet (balance 0, reserved 0) when none exists', async () => {
      const { svc, ledgerModel } = makeSvc();

      const wallet = await svc.getWallet('new-workspace');

      expect(wallet.balance).toBe(0);
      expect(wallet.reserved).toBe(0);
      // getWallet must NOT write a ledger row.
      expect(ledgerModel._rows).toHaveLength(0);
    });
  });

  // ---- topup ---------------------------------------------------------------

  describe('topup', () => {
    it('credits balance and writes a topup ledger row with correct post-state', async () => {
      const { svc, ledgerModel } = makeSvc();

      const wallet = await svc.topup(WS, 1000);

      expect(wallet.balance).toBe(1000);
      expect(wallet.reserved).toBe(0);
      expect(ledgerModel._rows).toHaveLength(1);

      const row = ledgerModel._rows[0];
      expect(row.type).toBe('topup');
      expect(row.amount).toBe(1000);
      expect(row.balanceAfter).toBe(1000);
      expect(row.reservedAfter).toBe(0);
      expect(row.ownerUserId).toBe(WS);
    });

    it('accumulates balance across multiple top-ups', async () => {
      const { svc, ledgerModel } = makeSvc();

      await svc.topup(WS, 500);
      const wallet = await svc.topup(WS, 300);

      expect(wallet.balance).toBe(800);
      expect(ledgerModel._rows).toHaveLength(2);
      expect(ledgerModel._rows[1].balanceAfter).toBe(800);
    });

    it('throws BadRequestException for amount <= 0 (zero)', async () => {
      const { svc, ledgerModel } = makeSvc();

      await expect(svc.topup(WS, 0)).rejects.toBeInstanceOf(BadRequestException);
      expect(ledgerModel._rows).toHaveLength(0);
    });

    it('throws BadRequestException for amount <= 0 (negative)', async () => {
      const { svc, ledgerModel } = makeSvc();

      await expect(svc.topup(WS, -50)).rejects.toBeInstanceOf(BadRequestException);
      expect(ledgerModel._rows).toHaveLength(0);
    });

    it('passes through meta fields (ref, recordedBy, note) into the ledger row', async () => {
      const { svc, ledgerModel } = makeSvc();
      const meta = { ref: 'INV-001', recordedBy: 'user-admin', note: 'Manual top-up' };

      await svc.topup(WS, 200, meta);

      const row = ledgerModel._rows[0];
      expect(row.ref).toBe('INV-001');
      expect(row.recordedBy).toBe('user-admin');
      expect(row.note).toBe('Manual top-up');
    });
  });

  // ---- reserve -------------------------------------------------------------

  describe('reserve', () => {
    it('moves amount from balance to reserved when balance is sufficient', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 1000);

      const ok = await svc.reserve(WS, 500, CAMPAIGN);

      expect(ok).toBe(true);
      const wallet = await svc.getWallet(WS);
      expect(wallet.balance).toBe(500);
      expect(wallet.reserved).toBe(500);

      // Should have two ledger rows: topup + reserve.
      expect(ledgerModel._rows).toHaveLength(2);
      const reserveRow = ledgerModel._rows.find((r) => r.type === 'reserve');
      expect(reserveRow).toBeDefined();
      expect(reserveRow?.amount).toBe(-500);
      expect(reserveRow?.balanceAfter).toBe(500);
      expect(reserveRow?.reservedAfter).toBe(500);
      expect(reserveRow?.campaignId).toBe(CAMPAIGN);
    });

    it('returns false and writes NO ledger row when balance is insufficient', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 100);
      // Clear the topup ledger row to make the assertion cleaner.
      ledgerModel._rows.length = 0;

      const ok = await svc.reserve(WS, 500, CAMPAIGN);

      expect(ok).toBe(false);
      const wallet = await svc.getWallet(WS);
      expect(wallet.balance).toBe(100);
      expect(wallet.reserved).toBe(0);
      // No reserve row written.
      expect(ledgerModel._rows).toHaveLength(0);
    });

    it('allows exact full-balance reserve', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 300);

      const ok = await svc.reserve(WS, 300, CAMPAIGN);

      expect(ok).toBe(true);
      const wallet = await svc.getWallet(WS);
      expect(wallet.balance).toBe(0);
      expect(wallet.reserved).toBe(300);
    });
  });

  // ---- debit ---------------------------------------------------------------

  describe('debit', () => {
    it('decrements reserved and writes a debit ledger row', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 1000);
      await svc.reserve(WS, 500, CAMPAIGN);
      ledgerModel._rows.length = 0; // reset for clean assertion

      await svc.debit(WS, 120, CAMPAIGN, 'tok-001');

      const wallet = await svc.getWallet(WS);
      expect(wallet.reserved).toBe(380);
      expect(ledgerModel._rows).toHaveLength(1);
      const row = ledgerModel._rows[0];
      expect(row.type).toBe('debit');
      expect(row.amount).toBe(-120);
      expect(row.idempotencyKey).toBe('tok-001');
      expect(row.campaignId).toBe(CAMPAIGN);
    });

    it('is idempotent: second call with same token charges exactly once', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 1000);
      await svc.reserve(WS, 500, CAMPAIGN);
      ledgerModel._rows.length = 0;

      // First charge.
      await svc.debit(WS, 120, CAMPAIGN, 'tok-dupe');
      const walletAfterFirst = await svc.getWallet(WS);
      const reservedAfterFirst = walletAfterFirst.reserved;

      // Second charge with same token -- must be a no-op.
      await svc.debit(WS, 120, CAMPAIGN, 'tok-dupe');
      const walletAfterSecond = await svc.getWallet(WS);

      expect(walletAfterSecond.reserved).toBe(reservedAfterFirst);
      // Still exactly one debit row.
      expect(ledgerModel._rows.filter((r) => r.type === 'debit')).toHaveLength(1);
    });
  });

  // ---- release -------------------------------------------------------------

  describe('release', () => {
    it('moves amount back from reserved to balance and writes a release row', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 1000);
      await svc.reserve(WS, 500, CAMPAIGN);
      ledgerModel._rows.length = 0;

      await svc.release(WS, 300, CAMPAIGN);

      const wallet = await svc.getWallet(WS);
      expect(wallet.reserved).toBe(200);
      // topup(1000) -> balance=1000; reserve(500) -> balance=500; release(300) -> balance=800
      expect(wallet.balance).toBe(800);

      expect(ledgerModel._rows).toHaveLength(1);
      const row = ledgerModel._rows[0];
      expect(row.type).toBe('release');
      expect(row.amount).toBe(300);
      expect(row.balanceAfter).toBe(800);
      expect(row.reservedAfter).toBe(200);
      expect(row.campaignId).toBe(CAMPAIGN);
    });

    it('throws BadRequestException when releasing more than reserved', async () => {
      const { svc, walletModel, ledgerModel } = makeSvc();
      // Seed reserved=100 directly.
      walletModel._store.set(WS, { ownerUserId: WS, balance: 0, reserved: 100 });

      await expect(svc.release(WS, 500, CAMPAIGN)).rejects.toBeInstanceOf(BadRequestException);

      // reserved must be unchanged.
      const wallet = await svc.getWallet(WS);
      expect(wallet.reserved).toBe(100);
      // No release ledger row written.
      expect(ledgerModel._rows).toHaveLength(0);
    });
  });

  // ---- money-safety guards --------------------------------------------------

  describe('money-safety guards', () => {
    describe('debit - insufficient reserved', () => {
      it('throws BadRequestException when debit exceeds reserved', async () => {
        const { svc, walletModel, ledgerModel } = makeSvc();
        // Seed reserved=100 directly.
        walletModel._store.set(WS, { ownerUserId: WS, balance: 200, reserved: 100 });

        await expect(svc.debit(WS, 500, CAMPAIGN, 'tokX')).rejects.toBeInstanceOf(
          BadRequestException,
        );

        // reserved must be unchanged.
        const wallet = await svc.getWallet(WS);
        expect(wallet.reserved).toBe(100);
        // No debit ledger row written.
        expect(ledgerModel._rows.filter((r) => r.type === 'debit')).toHaveLength(0);
      });
    });

    describe('amount <= 0 guards', () => {
      it('reserve(ws, 0) throws BadRequestException', async () => {
        const { svc, ledgerModel } = makeSvc();
        await svc.topup(WS, 1000);
        ledgerModel._rows.length = 0;

        await expect(svc.reserve(WS, 0, CAMPAIGN)).rejects.toBeInstanceOf(BadRequestException);
        expect(ledgerModel._rows).toHaveLength(0);
      });

      it('reserve(ws, -5) throws BadRequestException', async () => {
        const { svc, ledgerModel } = makeSvc();
        await svc.topup(WS, 1000);
        ledgerModel._rows.length = 0;

        await expect(svc.reserve(WS, -5, CAMPAIGN)).rejects.toBeInstanceOf(BadRequestException);
        expect(ledgerModel._rows).toHaveLength(0);
      });

      it('debit(ws, 0) throws BadRequestException', async () => {
        const { svc, walletModel, ledgerModel } = makeSvc();
        walletModel._store.set(WS, { ownerUserId: WS, balance: 500, reserved: 500 });

        await expect(svc.debit(WS, 0, CAMPAIGN, 'k0')).rejects.toBeInstanceOf(BadRequestException);
        expect(ledgerModel._rows).toHaveLength(0);
      });

      it('debit(ws, -5) throws BadRequestException', async () => {
        const { svc, walletModel, ledgerModel } = makeSvc();
        walletModel._store.set(WS, { ownerUserId: WS, balance: 500, reserved: 500 });

        await expect(svc.debit(WS, -5, CAMPAIGN, 'kneg')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(ledgerModel._rows).toHaveLength(0);
      });

      it('release(ws, 0) throws BadRequestException', async () => {
        const { svc, walletModel, ledgerModel } = makeSvc();
        walletModel._store.set(WS, { ownerUserId: WS, balance: 0, reserved: 500 });

        await expect(svc.release(WS, 0, CAMPAIGN)).rejects.toBeInstanceOf(BadRequestException);
        expect(ledgerModel._rows).toHaveLength(0);
      });

      it('release(ws, -5) throws BadRequestException', async () => {
        const { svc, walletModel, ledgerModel } = makeSvc();
        walletModel._store.set(WS, { ownerUserId: WS, balance: 0, reserved: 500 });

        await expect(svc.release(WS, -5, CAMPAIGN)).rejects.toBeInstanceOf(BadRequestException);
        expect(ledgerModel._rows).toHaveLength(0);
      });
    });

    describe('claim-first idempotency: duplicate debit charges exactly once', () => {
      it('a second same-key debit no-ops at the claim insert -- reserved unchanged, one debit row', async () => {
        const { svc, ledgerModel } = makeSvc();
        await svc.topup(WS, 1000);
        await svc.reserve(WS, 500, CAMPAIGN);
        ledgerModel._rows.length = 0;

        // First debit succeeds: claim 'tok1' inserted, reserved 500 -> 380.
        await svc.debit(WS, 120, CAMPAIGN, 'tok1');
        const walletAfterFirst = await svc.getWallet(WS);
        expect(walletAfterFirst.reserved).toBe(380);
        expect(ledgerModel._rows.filter((r) => r.type === 'debit')).toHaveLength(1);

        // Second call with the same token: the claim insert hits the unique
        // idempotencyKey index (11000) and no-ops BEFORE the decrement, so the
        // reserved balance is never touched a second time.
        await svc.debit(WS, 120, CAMPAIGN, 'tok1');

        const walletAfterSecond = await svc.getWallet(WS);
        expect(walletAfterSecond.reserved).toBe(380);

        const debitRows = ledgerModel._rows.filter((r) => r.type === 'debit');
        expect(debitRows).toHaveLength(1);
        expect(debitRows[0].idempotencyKey).toBe('tok1');
        // Finalized snapshot reflects the post-decrement reserved.
        expect(debitRows[0].reservedAfter).toBe(380);
      });
    });

    // A.3 -- charge-once is intrinsic to debit() and holds under concurrency,
    // independent of any upstream `charged` gating.
    describe('concurrency: parallel debits', () => {
      it('N parallel debits with the SAME key decrement reserved exactly once', async () => {
        const { svc, ledgerModel } = makeSvc();
        await svc.topup(WS, 2000);
        await svc.reserve(WS, 1000, CAMPAIGN);
        ledgerModel._rows.length = 0;

        // Fire 8 concurrent charges for the same business event (same key).
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => svc.debit(WS, 120, CAMPAIGN, 'same-event')),
        );

        // None reject: one wins the claim and charges, the rest no-op.
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

        const wallet = await svc.getWallet(WS);
        expect(wallet.reserved).toBe(880); // 1000 - 120, charged once
        expect(ledgerModel._rows.filter((r) => r.type === 'debit')).toHaveLength(1);
      });

      it('N parallel debits with DIFFERENT keys decrement reserved N times', async () => {
        const { svc, ledgerModel } = makeSvc();
        await svc.topup(WS, 2000);
        await svc.reserve(WS, 1000, CAMPAIGN);
        ledgerModel._rows.length = 0;

        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) => svc.debit(WS, 100, CAMPAIGN, `event-${i}`)),
        );

        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

        const wallet = await svc.getWallet(WS);
        expect(wallet.reserved).toBe(500); // 1000 - 5*100, charged five times
        expect(ledgerModel._rows.filter((r) => r.type === 'debit')).toHaveLength(5);
      });

      it('insufficient reserved still rejects cleanly and leaves no claim row', async () => {
        const { svc, walletModel, ledgerModel } = makeSvc();
        walletModel._store.set(WS, { ownerUserId: WS, balance: 200, reserved: 100 });

        await expect(svc.debit(WS, 500, CAMPAIGN, 'too-big')).rejects.toBeInstanceOf(
          BadRequestException,
        );

        const wallet = await svc.getWallet(WS);
        expect(wallet.reserved).toBe(100); // untouched
        // The claim was released on insufficiency -- the key is NOT poisoned, so
        // a legitimate retry after a corrective reserve can still go through.
        expect(ledgerModel._rows.filter((r) => r.type === 'debit')).toHaveLength(0);
      });
    });
  });

  // ---- ledger sign convention sanity check ---------------------------------

  describe('ledger sign convention', () => {
    it('topup row has positive amount, reserve row has negative amount', async () => {
      const { svc, ledgerModel } = makeSvc();

      await svc.topup(WS, 800);
      await svc.reserve(WS, 200, CAMPAIGN);

      const topupRow = ledgerModel._rows.find((r) => r.type === 'topup');
      const reserveRow = ledgerModel._rows.find((r) => r.type === 'reserve');

      expect(topupRow?.amount).toBeGreaterThan(0);
      expect(reserveRow?.amount).toBeLessThan(0);
    });
  });

  // ---- topup idempotency (gateway-confirm dedup) ---------------------------

  describe('topup with idempotencyKey', () => {
    it('credits once and writes a topup row carrying the idempotencyKey', async () => {
      const { svc, ledgerModel } = makeSvc();

      const wallet = await svc.topup(WS, 500, { idempotencyKey: 'pay_ABC', ref: 'pay_ABC' });

      expect(wallet.balance).toBe(500);
      const rows = ledgerModel._rows.filter((r) => r.type === 'topup');
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotencyKey).toBe('pay_ABC');
    });

    it('is idempotent: a second topup with the same key does NOT re-credit', async () => {
      const { svc, ledgerModel } = makeSvc();

      await svc.topup(WS, 500, { idempotencyKey: 'pay_DUP' });
      const after = await svc.topup(WS, 500, { idempotencyKey: 'pay_DUP' });

      // Balance credited exactly once.
      expect(after.balance).toBe(500);
      // Exactly one topup ledger row for the key.
      const rows = ledgerModel._rows.filter((r) => r.type === 'topup');
      expect(rows).toHaveLength(1);
    });

    it('reverts the balance increment if the ledger insert loses the unique race', async () => {
      const { svc, ledgerModel } = makeSvc();

      // First credit lands a row for the key.
      await svc.topup(WS, 500, { idempotencyKey: 'pay_RACE' });
      expect((await svc.getWallet(WS)).balance).toBe(500);

      // Simulate a racing sibling that MISSED the fast-path read: force the
      // dedup findOne to return null so the second call proceeds to $inc, then
      // ledger.create throws 11000 (row already exists) and the balance is
      // reverted back to 500.
      const findOneSpy = vi.spyOn(ledgerModel, 'findOne').mockResolvedValueOnce(null);
      const reverted = await svc.topup(WS, 500, { idempotencyKey: 'pay_RACE' });
      findOneSpy.mockRestore();

      expect(reverted.balance).toBe(500);
      const rows = ledgerModel._rows.filter((r) => r.type === 'topup');
      expect(rows).toHaveLength(1);
    });
  });

  // ---- PostHog emit -- ads.wallet_topped_up (T34) --------------------------

  describe('PostHog emit (T34)', () => {
    it('emits ads.wallet_topped_up with amount and balanceAfter when posthog provided', async () => {
      const walletModel = createWalletModelMock();
      const ledgerModel = createLedgerModelMock();
      const mockPosthog = { capture: vi.fn() };

      const svc = new WalletService(walletModel as any, ledgerModel as any, mockPosthog as any);
      const wallet = await svc.topup(WS, 1000);

      expect(mockPosthog.capture).toHaveBeenCalledOnce();
      const call = mockPosthog.capture.mock.calls[0][0];
      expect(call.distinctId).toBe(WS);
      expect(call.event).toBe('ads.wallet_topped_up');
      expect(call.properties.amount).toBe(1000);
      expect(call.properties.balanceAfter).toBe(wallet.balance);
    });

    it('does NOT emit when posthog is undefined (existing tests use 2-arg construction)', async () => {
      const walletModel = createWalletModelMock();
      const ledgerModel = createLedgerModelMock();
      // Positional construction with no 3rd arg - posthog is undefined.
      const svc = new WalletService(walletModel as any, ledgerModel as any);
      await expect(svc.topup(WS, 500)).resolves.toBeDefined();
    });

    it('does NOT emit when topup throws (amount <= 0)', async () => {
      const walletModel = createWalletModelMock();
      const ledgerModel = createLedgerModelMock();
      const mockPosthog = { capture: vi.fn() };

      const svc = new WalletService(walletModel as any, ledgerModel as any, mockPosthog as any);
      await expect(svc.topup(WS, 0)).rejects.toBeDefined();
      expect(mockPosthog.capture).not.toHaveBeenCalled();
    });
  });

  // ---- M0.6: grant / expireGrants / grant-first reserve --------------------
  //
  // Option A: a separate, expiring `grantBalance` bucket sits alongside the
  // purchased `balance`. Granted (plan-allowance) credits are spent before
  // purchased credits and expire each cycle; purchased credits persist.

  describe('grant (M0.6 included boost credits)', () => {
    const FUTURE = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    it('credits grantBalance, leaves purchased balance untouched, writes a grant row', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 200); // purchased balance
      ledgerModel._rows.length = 0;
      const expiresAt = FUTURE();

      await svc.grant(WS, 500, { idempotencyKey: 'grant-sub1-c1', expiresAt });

      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(500);
      expect(w.balance).toBe(200); // purchased pool untouched
      expect(w.grantExpiresAt).toEqual(expiresAt);

      const row = ledgerModel._rows.find((r) => r.type === 'grant');
      expect(row?.amount).toBe(500);
      expect((row as any)?.grantBalanceAfter).toBe(500);
      expect(row?.idempotencyKey).toBe('grant-sub1-c1');
    });

    it('is idempotent: a second grant with the same key does NOT re-credit', async () => {
      const { svc, ledgerModel } = makeSvc();
      const expiresAt = FUTURE();
      await svc.grant(WS, 500, { idempotencyKey: 'grant-dup', expiresAt });
      await svc.grant(WS, 500, { idempotencyKey: 'grant-dup', expiresAt });

      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(500); // credited exactly once
      expect(ledgerModel._rows.filter((r) => r.type === 'grant')).toHaveLength(1);
    });

    it('reverts the grant increment if the ledger insert loses the unique race', async () => {
      const { svc, ledgerModel } = makeSvc();
      const expiresAt = FUTURE();
      await svc.grant(WS, 500, { idempotencyKey: 'grant-race', expiresAt });
      expect((await svc.getWallet(WS)).grantBalance).toBe(500);

      // Force the dedup findOne to miss so the second call proceeds to $inc,
      // then ledger.create throws 11000 and the grant increment is reverted.
      const findOneSpy = vi.spyOn(ledgerModel, 'findOne').mockResolvedValueOnce(null);
      const reverted = await svc.grant(WS, 500, { idempotencyKey: 'grant-race', expiresAt });
      findOneSpy.mockRestore();

      expect(reverted.grantBalance).toBe(500);
      expect(ledgerModel._rows.filter((r) => r.type === 'grant')).toHaveLength(1);
    });

    it('throws BadRequestException for a non-positive amount', async () => {
      const { svc } = makeSvc();
      await expect(svc.grant(WS, 0, {})).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('expireGrants (M0.6 cycle reset)', () => {
    it('zeroes an expired grantBalance and writes a grant_expire row', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 200); // purchased balance persists
      await svc.grant(WS, 120, {
        idempotencyKey: 'g-past',
        expiresAt: new Date(Date.now() - 1000),
      });
      ledgerModel._rows.length = 0;

      const expired = await svc.expireGrants(WS);

      expect(expired).toBe(120);
      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(0); // expiring grant cleared
      expect(w.balance).toBe(200); // purchased balance untouched

      const row = ledgerModel._rows.find((r) => r.type === 'grant_expire');
      expect(row?.amount).toBe(-120);
      expect((row as any)?.grantBalanceAfter).toBe(0);
    });

    it('is a no-op when the grant has not yet expired', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.grant(WS, 120, {
        idempotencyKey: 'g-future',
        expiresAt: new Date(Date.now() + 60_000),
      });
      ledgerModel._rows.length = 0;

      const expired = await svc.expireGrants(WS);

      expect(expired).toBe(0);
      expect((await svc.getWallet(WS)).grantBalance).toBe(120); // still there
      expect(ledgerModel._rows.filter((r) => r.type === 'grant_expire')).toHaveLength(0);
    });

    it('is a no-op when there is no grant balance', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 100);
      expect(await svc.expireGrants(WS)).toBe(0);
    });
  });

  describe('reserve grant-first (M0.6)', () => {
    const FUTURE = () => new Date(Date.now() + 60_000);

    it('draws grantBalance before purchased balance when reserving across both', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 200); // purchased 200
      await svc.grant(WS, 300, { idempotencyKey: 'gr1', expiresAt: FUTURE() }); // grant 300

      const ok = await svc.reserve(WS, 350, CAMPAIGN); // 300 grant + 50 purchased

      expect(ok).toBe(true);
      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(0); // grant consumed first
      expect(w.balance).toBe(150); // only 50 taken from purchased
      expect(w.reserved).toBe(350);
    });

    it('leaves purchased balance fully intact when the grant covers the reserve', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 200);
      await svc.grant(WS, 500, { idempotencyKey: 'gr2', expiresAt: FUTURE() });

      const ok = await svc.reserve(WS, 400, CAMPAIGN);

      expect(ok).toBe(true);
      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(100); // 500 - 400
      expect(w.balance).toBe(200); // untouched
      expect(w.reserved).toBe(400);
    });

    it('returns false (no reserve row) when grant + purchased combined is insufficient', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 100);
      await svc.grant(WS, 100, { idempotencyKey: 'gr3', expiresAt: FUTURE() });
      ledgerModel._rows.length = 0;

      const ok = await svc.reserve(WS, 500, CAMPAIGN); // need 500, have 200

      expect(ok).toBe(false);
      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(100);
      expect(w.balance).toBe(100);
      expect(w.reserved).toBe(0);
      expect(ledgerModel._rows.filter((r) => r.type === 'reserve')).toHaveLength(0);
    });

    it('records grantBalanceAfter on the reserve ledger row', async () => {
      const { svc, ledgerModel } = makeSvc();
      await svc.topup(WS, 200);
      await svc.grant(WS, 300, { idempotencyKey: 'gr4', expiresAt: FUTURE() });
      ledgerModel._rows.length = 0;

      await svc.reserve(WS, 100, CAMPAIGN); // 100 from grant -> grantBalance 200

      const row = ledgerModel._rows.find((r) => r.type === 'reserve');
      expect((row as any)?.grantBalanceAfter).toBe(200);
      expect(row?.amount).toBe(-100);
    });
  });

  // ---- CN-ADS-1: reserveDetailed split + split-aware release ---------------

  describe('reserveDetailed (CN-ADS-1)', () => {
    const FUTURE = () => new Date(Date.now() + 60_000);

    it('returns the grant/purchased split of the reserve', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 200);
      await svc.grant(WS, 300, { idempotencyKey: 'd1', expiresAt: FUTURE() });

      const res = await svc.reserveDetailed(WS, 350, CAMPAIGN); // 300 grant + 50 purchased

      expect(res.ok).toBe(true);
      expect(res.fromGrant).toBe(300);
      expect(res.fromBalance).toBe(50);
    });

    it('returns ok:false with a zero split when combined capacity is insufficient', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 100);
      const res = await svc.reserveDetailed(WS, 500, CAMPAIGN);
      expect(res).toEqual({ ok: false, fromGrant: 0, fromBalance: 0 });
    });
  });

  describe('release with split (CN-ADS-1)', () => {
    const FUTURE = () => new Date(Date.now() + 60_000);

    it('restores grant credits to grantBalance and purchased to balance', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 200);
      await svc.grant(WS, 300, { idempotencyKey: 'r1', expiresAt: FUTURE() });
      const split = await svc.reserveDetailed(WS, 350, CAMPAIGN); // 300 grant + 50 balance
      // After reserve: grant 0, balance 150, reserved 350.

      await svc.release(WS, 350, CAMPAIGN, {
        fromGrant: split.fromGrant,
        fromBalance: split.fromBalance,
      });

      const w = await svc.getWallet(WS);
      // Grant credits went BACK to grantBalance (not silently to permanent balance).
      expect(w.grantBalance).toBe(300);
      expect(w.balance).toBe(200);
      expect(w.reserved).toBe(0);
    });

    it('without a split, still credits the whole amount to balance (back-compat)', async () => {
      const { svc } = makeSvc();
      await svc.topup(WS, 200);
      await svc.grant(WS, 300, { idempotencyKey: 'r2', expiresAt: FUTURE() });
      await svc.reserve(WS, 350, CAMPAIGN); // grant 0, balance 150, reserved 350

      await svc.release(WS, 350, CAMPAIGN); // no split -> all to balance

      const w = await svc.getWallet(WS);
      expect(w.grantBalance).toBe(0);
      expect(w.balance).toBe(500); // 150 + 350 all to balance (legacy behaviour)
      expect(w.reserved).toBe(0);
    });
  });

  // ---- CN-PURGE-1: forfeitReserve ------------------------------------------

  describe('forfeitReserve (CN-PURGE-1 forfeit)', () => {
    it('decrements reserved with NO credit back and writes a forfeit ledger row', async () => {
      const { svc, walletModel, ledgerModel } = makeSvc();
      walletModel._store.set(WS, {
        ownerUserId: WS,
        balance: 100,
        grantBalance: 50,
        reserved: 400,
      });
      ledgerModel._rows.length = 0;

      await svc.forfeitReserve(WS, 400, CAMPAIGN, 'account purge');

      const w = await svc.getWallet(WS);
      expect(w.reserved).toBe(0); // hold freed
      expect(w.balance).toBe(100); // UNCHANGED — no credit back
      expect(w.grantBalance).toBe(50); // UNCHANGED
      const row = ledgerModel._rows.find((r) => r.type === 'forfeit');
      expect(row).toBeDefined();
      expect(row?.amount).toBe(-400);
      expect(row?.reservedAfter).toBe(0);
      expect(row?.balanceAfter).toBe(100);
    });

    it('is idempotent — a second forfeit (reserved already freed) is a no-op', async () => {
      const { svc, walletModel, ledgerModel } = makeSvc();
      walletModel._store.set(WS, { ownerUserId: WS, balance: 0, reserved: 0 });
      ledgerModel._rows.length = 0;

      await svc.forfeitReserve(WS, 400, CAMPAIGN, 'account purge');

      // No decrement possible (reserved 0 < 400) -> no ledger row, no throw.
      expect(ledgerModel._rows.filter((r) => r.type === 'forfeit')).toHaveLength(0);
    });
  });
});
