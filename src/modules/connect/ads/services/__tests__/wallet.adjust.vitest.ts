/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * WalletService.adjust() -- TDD spec.
 *
 * Covers the admin manual credit/debit to the spendable `balance` bucket:
 *   - credit (+100):  increments balance and writes ONE 'adjustment' ledger row
 *                     carrying recordedBy = adminUserId.
 *   - debit beyond balance: throws BadRequestException and writes NO ledger row
 *                           (balance never goes negative).
 *   - amount 0:       throws BadRequestException (non-zero guard).
 *
 * The @nestjs/mongoose decorators are stubbed BEFORE importing the service so
 * the transitive schema imports do not trip vitest's reflect-metadata pipeline
 * (same approach as wallet-topup-checkout.service.vitest.ts). The wallet is
 * driven by the shared in-memory model mocks and we spy on the PRIVATE
 * writeLedger via the ledger mock's `create` (the single ledger write path).
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
import { WalletService } from '../wallet.service';
import {
  createWalletModelMock,
  createLedgerModelMock,
} from '../../__tests__/helpers/ad-model-mocks';

// Valid 24-char ObjectId hex strings (the service constructs no ObjectId for
// the balance-bucket filter, but real ids keep parity with prod).
const OWNER = '64a000000000000000000001';
const ADMIN = '64a0000000000000000000aa';

function makeWalletSvc() {
  const walletModel = createWalletModelMock();
  const ledgerModel = createLedgerModelMock();
  const wallet = new WalletService(walletModel as any, ledgerModel as any);
  return { wallet, walletModel, ledgerModel };
}

describe('WalletService.adjust()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('credits +100: increments balance and writes one adjustment ledger row with recordedBy', async () => {
    const { wallet, walletModel, ledgerModel } = makeWalletSvc();
    // Seed an existing wallet at 50 so we can prove the increment.
    walletModel._store.set(OWNER, { ownerUserId: OWNER, balance: 50, reserved: 0 });

    const result = await wallet.adjust(OWNER, 100, ADMIN, 'goodwill credit');

    // Balance incremented 50 -> 150.
    expect(result.balance).toBe(150);
    expect(walletModel._store.get(OWNER)?.balance).toBe(150);

    // Exactly one adjustment ledger row, carrying the admin as recordedBy and
    // the authoritative post-state snapshot.
    const adjustments = ledgerModel._rows.filter((r) => r.type === 'adjustment');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].amount).toBe(100);
    expect(adjustments[0].balanceAfter).toBe(150);
    expect(adjustments[0].recordedBy).toBe(ADMIN);
    expect(adjustments[0].note).toBe('goodwill credit');
  });

  it('appends the optional note to the reason on the ledger row', async () => {
    const { wallet, walletModel, ledgerModel } = makeWalletSvc();
    walletModel._store.set(OWNER, { ownerUserId: OWNER, balance: 0, reserved: 0 });

    await wallet.adjust(OWNER, 250, ADMIN, 'manual correction', 'ticket #42');

    const row = ledgerModel._rows.find((r) => r.type === 'adjustment');
    expect(row?.note).toBe('manual correction: ticket #42');
  });

  it('debit beyond balance throws BadRequestException and writes NO ledger row', async () => {
    const { wallet, walletModel, ledgerModel } = makeWalletSvc();
    // Only 30 available; a -100 debit would go negative.
    walletModel._store.set(OWNER, { ownerUserId: OWNER, balance: 30, reserved: 0 });

    await expect(wallet.adjust(OWNER, -100, ADMIN, 'clawback')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Balance untouched, no ledger row written.
    expect(walletModel._store.get(OWNER)?.balance).toBe(30);
    expect(ledgerModel._rows.filter((r) => r.type === 'adjustment')).toHaveLength(0);
  });

  it('debit within balance decrements and writes one adjustment row', async () => {
    const { wallet, walletModel, ledgerModel } = makeWalletSvc();
    walletModel._store.set(OWNER, { ownerUserId: OWNER, balance: 200, reserved: 0 });

    const result = await wallet.adjust(OWNER, -75, ADMIN, 'refund reversal');

    expect(result.balance).toBe(125);
    const adjustments = ledgerModel._rows.filter((r) => r.type === 'adjustment');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].amount).toBe(-75);
    expect(adjustments[0].balanceAfter).toBe(125);
  });

  it('amount 0 throws BadRequestException and writes NO ledger row', async () => {
    const { wallet, walletModel, ledgerModel } = makeWalletSvc();
    walletModel._store.set(OWNER, { ownerUserId: OWNER, balance: 100, reserved: 0 });

    await expect(wallet.adjust(OWNER, 0, ADMIN, 'noop')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(ledgerModel._rows).toHaveLength(0);
    // Balance untouched.
    expect(walletModel._store.get(OWNER)?.balance).toBe(100);
  });

  it('credits into a never-before-seen wallet (upsert) starting from 0', async () => {
    const { wallet, ledgerModel } = makeWalletSvc();
    // No seed: getWallet should upsert an empty wallet, then credit it.

    const result = await wallet.adjust(OWNER, 500, ADMIN, 'first credit');

    expect(result.balance).toBe(500);
    const adjustments = ledgerModel._rows.filter((r) => r.type === 'adjustment');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].balanceAfter).toBe(500);
  });
});
