/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * WalletTopupCheckoutService -- TDD spec (RED first).
 *
 * Covers the real gateway-confirm-first flow that REUSES the ERP's
 * RazorpayPlatformService:
 *   - order:      creates a Razorpay order with the correct PAISE amount,
 *                 persists a 'created' AdWalletTopup, returns the order shape.
 *   - confirm (happy):     valid signature -> 'paid', sets razorpayPaymentId,
 *                          credits WalletService.topup exactly once (rupees +
 *                          idempotencyKey), returns the wallet.
 *   - confirm (bad sig):   throws, status 'failed', WalletService.topup NOT called.
 *   - confirm (idempotent): already 'paid' -> returns wallet, no re-credit.
 *   - confirm (not found / not owned): throws NotFound.
 *
 * The @nestjs/mongoose decorators are stubbed BEFORE importing the service so
 * the transitive schema imports do not trip vitest's reflect-metadata pipeline
 * (same approach as wallet.service.vitest.ts).
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

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletTopupCheckoutService } from '../wallet-topup-checkout.service';
import { WalletService } from '../wallet.service';
import {
  createTopupModelMock,
  createWalletModelMock,
  createLedgerModelMock,
} from '../../__tests__/helpers/ad-model-mocks';

// Valid 24-char ObjectId hex strings: the service constructs
// `new Types.ObjectId(ownerUserId)` from the JWT `sub`, which is always a
// real Mongo id in production.
const OWNER = '64a000000000000000000001';
const OTHER = '64a000000000000000000002';

function makeRazorpay(overrides: Partial<Record<string, any>> = {}) {
  return {
    getKeyId: vi.fn().mockReturnValue('rzp_test_FAKEKEYID'),
    createOrder: vi.fn().mockResolvedValue({
      id: 'order_RZP123',
      amount: 50000,
      currency: 'INR',
      status: 'created',
    }),
    verifyCheckoutSignature: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function makeWallet() {
  return {
    topup: vi.fn().mockResolvedValue({ ownerUserId: OWNER, balance: 500, reserved: 0 }),
    getWallet: vi.fn().mockResolvedValue({ ownerUserId: OWNER, balance: 500, reserved: 0 }),
  };
}

function makeAudit() {
  return { logEvent: vi.fn().mockResolvedValue(undefined) };
}

function makeSvc(opts: { razorpay?: any; wallet?: any; audit?: any; posthog?: any } = {}) {
  const topupModel = createTopupModelMock();
  const razorpay = opts.razorpay ?? makeRazorpay();
  const wallet = opts.wallet ?? makeWallet();
  const audit = opts.audit ?? makeAudit();
  const posthog = opts.posthog;
  const svc = new WalletTopupCheckoutService(topupModel as any, razorpay, wallet, audit, posthog);
  return { svc, topupModel, razorpay, wallet, audit, posthog };
}

describe('WalletTopupCheckoutService', () => {
  // ---- createOrder ----------------------------------------------------------

  describe('createOrder', () => {
    it('calls Razorpay with the correct PAISE amount and persists a created intent', async () => {
      const { svc, topupModel, razorpay } = makeSvc();

      await svc.createOrder(OWNER, { amount: 500 });

      // Razorpay charged in paise (500 INR -> 50000 paise).
      expect(razorpay.createOrder).toHaveBeenCalledOnce();
      const arg = razorpay.createOrder.mock.calls[0][0];
      expect(arg.amountPaise).toBe(50000);

      // A 'created' intent was persisted with rupees + paise + order id.
      expect(topupModel._rows).toHaveLength(1);
      const intent = topupModel._rows[0];
      // The service stores ownerUserId as an ObjectId (schema ref 'User'),
      // matching real Mongo; normalize to string for the comparison.
      expect(String(intent.ownerUserId)).toBe(OWNER);
      expect(intent.amountRupees).toBe(500);
      expect(intent.amountPaise).toBe(50000);
      expect(intent.razorpayOrderId).toBe('order_RZP123');
      expect(intent.status).toBe('created');
    });

    it('returns the credit-pack-style order response shape (keyId, orderId, amount paise, currency, walletTopupId)', async () => {
      const { svc } = makeSvc();

      const res = await svc.createOrder(OWNER, { amount: 500 });

      expect(res.keyId).toBe('rzp_test_FAKEKEYID');
      expect(res.orderId).toBe('order_RZP123');
      expect(res.amount).toBe(50000); // paise, for the checkout sheet
      expect(res.currency).toBe('INR');
      expect(typeof res.walletTopupId).toBe('string');
      expect(res.walletTopupId.length).toBeGreaterThan(0);
    });
  });

  // ---- confirmPayment (happy path) ------------------------------------------

  describe('confirmPayment - valid signature', () => {
    it('marks paid, sets razorpayPaymentId, credits the wallet once (rupees + idempotencyKey), returns wallet', async () => {
      const { svc, topupModel, razorpay, wallet, audit } = makeSvc();

      // Seed a created intent (as if createOrder ran).
      const intent = topupModel._seed({
        ownerUserId: OWNER,
        amountRupees: 500,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: 'order_RZP123',
        status: 'created',
      });

      const result = await svc.confirmPayment(OWNER, {
        walletTopupId: intent._id,
        razorpayOrderId: 'order_RZP123',
        razorpayPaymentId: 'pay_RZP999',
        razorpaySignature: 'goodsig',
      });

      // Signature verified via the platform service.
      expect(razorpay.verifyCheckoutSignature).toHaveBeenCalledWith({
        orderId: 'order_RZP123',
        paymentId: 'pay_RZP999',
        signature: 'goodsig',
      });

      // Intent transitioned to paid with the payment id recorded.
      const stored = topupModel._byId(intent._id);
      expect(stored.status).toBe('paid');
      expect(stored.razorpayPaymentId).toBe('pay_RZP999');

      // Wallet credited exactly once, in RUPEES, with an idempotencyKey.
      expect(wallet.topup).toHaveBeenCalledOnce();
      const [uid, amount, meta] = wallet.topup.mock.calls[0];
      expect(uid).toBe(OWNER);
      expect(amount).toBe(500); // rupees, NOT paise
      expect(meta.idempotencyKey).toBeTruthy();

      // Audit fired.
      expect(audit.logEvent).toHaveBeenCalledOnce();

      // Returns the (updated) wallet.
      expect(result.balance).toBe(500);
    });

    it('emits the ads.topup_wallet PostHog event on a successful credit', async () => {
      const posthog = { capture: vi.fn() };
      const { svc, topupModel } = makeSvc({ posthog });
      const intent = topupModel._seed({
        ownerUserId: OWNER,
        amountRupees: 200,
        amountPaise: 20000,
        currency: 'INR',
        razorpayOrderId: 'order_PH',
        status: 'created',
      });

      await svc.confirmPayment(OWNER, {
        walletTopupId: intent._id,
        razorpayOrderId: 'order_PH',
        razorpayPaymentId: 'pay_PH',
        razorpaySignature: 'sig',
      });

      expect(posthog.capture).toHaveBeenCalledOnce();
      const call = posthog.capture.mock.calls[0][0];
      expect(call.distinctId).toBe(OWNER);
      expect(call.event).toBe('ads.topup_wallet');
    });
  });

  // ---- confirmPayment (bad signature) ---------------------------------------

  describe('confirmPayment - invalid signature', () => {
    it('throws BadRequest, marks failed, and does NOT credit the wallet', async () => {
      const razorpay = makeRazorpay({ verifyCheckoutSignature: vi.fn().mockReturnValue(false) });
      const { svc, topupModel, wallet } = makeSvc({ razorpay });
      const intent = topupModel._seed({
        ownerUserId: OWNER,
        amountRupees: 500,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: 'order_BAD',
        status: 'created',
      });

      await expect(
        svc.confirmPayment(OWNER, {
          walletTopupId: intent._id,
          razorpayOrderId: 'order_BAD',
          razorpayPaymentId: 'pay_BAD',
          razorpaySignature: 'forged',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      const stored = topupModel._byId(intent._id);
      expect(stored.status).toBe('failed');
      expect(wallet.topup).not.toHaveBeenCalled();
    });
  });

  // ---- confirmPayment (idempotent / already paid) ---------------------------

  describe('confirmPayment - already paid (idempotent)', () => {
    it('returns the wallet without re-crediting when the intent is already paid', async () => {
      const { svc, topupModel, wallet, razorpay } = makeSvc();
      const intent = topupModel._seed({
        ownerUserId: OWNER,
        amountRupees: 500,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: 'order_DONE',
        razorpayPaymentId: 'pay_DONE',
        status: 'paid',
      });

      const result = await svc.confirmPayment(OWNER, {
        walletTopupId: intent._id,
        razorpayOrderId: 'order_DONE',
        razorpayPaymentId: 'pay_DONE',
        razorpaySignature: 'whatever',
      });

      // No re-credit, no re-verify required for the short-circuit.
      expect(wallet.topup).not.toHaveBeenCalled();
      expect(razorpay.verifyCheckoutSignature).not.toHaveBeenCalled();
      // Wallet view returned.
      expect(wallet.getWallet).toHaveBeenCalledWith(OWNER);
      expect(result.balance).toBe(500);
    });
  });

  // ---- confirmPayment (not found / not owned) -------------------------------

  describe('confirmPayment - not found / not owned', () => {
    it('throws NotFound when the intent does not exist', async () => {
      const { svc } = makeSvc();

      await expect(
        svc.confirmPayment(OWNER, {
          walletTopupId: '64b000000000000000000000',
          razorpayOrderId: 'order_X',
          razorpayPaymentId: 'pay_X',
          razorpaySignature: 'sig',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when the intent is owned by a different user', async () => {
      const { svc, topupModel, wallet } = makeSvc();
      const intent = topupModel._seed({
        ownerUserId: OTHER,
        amountRupees: 500,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: 'order_OWN',
        status: 'created',
      });

      await expect(
        svc.confirmPayment(OWNER, {
          walletTopupId: intent._id,
          razorpayOrderId: 'order_OWN',
          razorpayPaymentId: 'pay_OWN',
          razorpaySignature: 'sig',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(wallet.topup).not.toHaveBeenCalled();
    });
  });

  // ---- B.4: payment-confirmation idempotency (replay / race credits once) ----
  //
  // Protection EXISTS at two layers; these tests wire a REAL WalletService (no
  // vi.fn stub) to in-memory wallet + ledger mocks to prove the wallet is
  // credited exactly once end to end.

  describe('confirmPayment - credits the wallet exactly once (B.4)', () => {
    function makeRealWalletSvc() {
      const walletModel = createWalletModelMock();
      const ledgerModel = createLedgerModelMock();
      const wallet = new WalletService(walletModel as any, ledgerModel as any);
      return { wallet, walletModel, ledgerModel };
    }

    it('a replayed (double-submitted) confirmation credits the wallet once, keyed on the payment id', async () => {
      const { wallet, ledgerModel } = makeRealWalletSvc();
      const { svc, topupModel } = makeSvc({ wallet });
      const intent = topupModel._seed({
        ownerUserId: OWNER,
        amountRupees: 500,
        amountPaise: 50000,
        currency: 'INR',
        razorpayOrderId: 'order_REPLAY',
        status: 'created',
      });
      const dto = {
        walletTopupId: intent._id,
        razorpayOrderId: 'order_REPLAY',
        razorpayPaymentId: 'pay_REPLAY',
        razorpaySignature: 'sig',
      };

      const first = await svc.confirmPayment(OWNER, dto);
      const second = await svc.confirmPayment(OWNER, dto); // replay

      // Balance reflects a single 500 credit.
      expect(first.balance).toBe(500);
      expect(second.balance).toBe(500);

      // Exactly one topup ledger row, and its idempotencyKey is the payment id.
      const topups = ledgerModel._rows.filter((r) => r.type === 'topup');
      expect(topups).toHaveLength(1);
      expect(topups[0].idempotencyKey).toBe('pay_REPLAY');
    });

    it('the wallet payment-id key is the durable backstop if two confirmations both reach the credit (gateway race)', async () => {
      // The confirm-layer status guard collapses a same-intent replay to a
      // no-op. This covers the harder race the code comments promise: a webhook
      // and a client-confirm that BOTH pass the `created` check before either
      // persists `paid`, so both call wallet.topup with the same payment id.
      // The ledger's partial-unique idempotencyKey index credits exactly once.
      const { wallet, ledgerModel } = makeRealWalletSvc();

      await Promise.all([
        wallet.topup(OWNER, 500, { idempotencyKey: 'pay_RACE', ref: 'pay_RACE' }),
        wallet.topup(OWNER, 500, { idempotencyKey: 'pay_RACE', ref: 'pay_RACE' }),
      ]);

      const credited = await wallet.getWallet(OWNER);
      expect(credited.balance).toBe(500); // credited once, not 1000
      expect(ledgerModel._rows.filter((r) => r.type === 'topup')).toHaveLength(1);
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});
