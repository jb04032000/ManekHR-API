/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
/**
 * WalletController unit tests -- TDD.
 *
 * Critical assertion: ownerUserId comes from `req.user.sub` (auth), NOT the body.
 *
 * The insecure direct-credit `POST /topup` endpoint was removed in favour of
 * the gateway-confirm-first flow (`/topup/order` + `/topup/confirm`). These
 * tests cover the read endpoint plus the two checkout endpoints, asserting the
 * controller forwards the authed user id and the DTO to the checkout service.
 */

import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WalletController, TOPUP_ORDER_RATE_LIMIT } from '../wallet.controller';

const AUTH_USER_ID = 'authed-user-123';

function makeReq(sub = AUTH_USER_ID) {
  return { user: { sub } };
}

function makeMockWalletService() {
  return {
    getWallet: vi.fn().mockResolvedValue({ ownerUserId: AUTH_USER_ID, balance: 500, reserved: 50 }),
  };
}

function makeMockCheckout() {
  return {
    createOrder: vi.fn().mockResolvedValue({
      keyId: 'rzp_test_FAKE',
      orderId: 'order_1',
      amount: 50000,
      currency: 'INR',
      walletTopupId: 'topup_1',
    }),
    confirmPayment: vi
      .fn()
      .mockResolvedValue({ ownerUserId: AUTH_USER_ID, balance: 1000, reserved: 50 }),
  };
}

describe('WalletController', () => {
  describe('GET / (getWallet)', () => {
    it('calls walletService.getWallet with userId from auth', async () => {
      const svc = makeMockWalletService();
      const ctrl = new WalletController(svc as any, makeMockCheckout() as any);

      await ctrl.getWallet(makeReq());

      expect(svc.getWallet).toHaveBeenCalledWith(AUTH_USER_ID);
    });

    it('returns the typed wallet view (CN-ADS-15: balance/reserved/grantBalance, not the raw doc)', async () => {
      const svc = makeMockWalletService();
      const ctrl = new WalletController(svc as any, makeMockCheckout() as any);

      const result = await ctrl.getWallet(makeReq());

      // CN-ADS-15: the controller maps to an explicit view instead of returning
      // the raw Mongoose document (which shipped ownerUserId/__v/timestamps).
      // grantBalance is included for the composer's CN-ADS-4 affordability gate;
      // it defaults to 0 when the wallet has none.
      expect(result).toEqual({ balance: 500, reserved: 50, grantBalance: 0 });
    });
  });

  describe('POST /topup/order (createTopupOrder)', () => {
    it('is throttled to 3 orders/min per user (payment-order spam guard)', () => {
      // @nestjs/throttler stores the per-name limit on the method under the
      // `THROTTLER:LIMIT<name>` metadata key. Read the handler off the prototype
      // descriptor (not as an unbound member access) and assert the value.
      const handler = Object.getOwnPropertyDescriptor(
        WalletController.prototype,
        'createTopupOrder',
      )?.value as unknown;
      const limit = Reflect.getMetadata('THROTTLER:LIMIT' + 'ads-wallet-topup-order', handler);
      expect(limit).toBe(3);
      expect(TOPUP_ORDER_RATE_LIMIT).toBe(3);
    });

    it('calls checkout.createOrder with userId from auth and the DTO', async () => {
      const checkout = makeMockCheckout();
      const ctrl = new WalletController(makeMockWalletService() as any, checkout as any);

      await ctrl.createTopupOrder(makeReq(), { amount: 500 });

      expect(checkout.createOrder).toHaveBeenCalledWith(AUTH_USER_ID, { amount: 500 });
    });

    it('returns the order response shape', async () => {
      const checkout = makeMockCheckout();
      const ctrl = new WalletController(makeMockWalletService() as any, checkout as any);

      const result = await ctrl.createTopupOrder(makeReq(), { amount: 500 });

      expect(result).toEqual({
        keyId: 'rzp_test_FAKE',
        orderId: 'order_1',
        amount: 50000,
        currency: 'INR',
        walletTopupId: 'topup_1',
      });
    });
  });

  describe('POST /topup/confirm (confirmTopup)', () => {
    it('calls checkout.confirmPayment with userId from auth and the DTO', async () => {
      const checkout = makeMockCheckout();
      const ctrl = new WalletController(makeMockWalletService() as any, checkout as any);
      const dto = {
        walletTopupId: 'topup_1',
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'sig_1',
      };

      await ctrl.confirmTopup(makeReq(), dto);

      expect(checkout.confirmPayment).toHaveBeenCalledWith(AUTH_USER_ID, dto);
    });

    it('returns the updated wallet doc', async () => {
      const checkout = makeMockCheckout();
      const ctrl = new WalletController(makeMockWalletService() as any, checkout as any);

      const result = await ctrl.confirmTopup(makeReq(), {
        walletTopupId: 'topup_1',
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'sig_1',
      });

      expect(result).toEqual({ ownerUserId: AUTH_USER_ID, balance: 1000, reserved: 50 });
    });
  });
});
