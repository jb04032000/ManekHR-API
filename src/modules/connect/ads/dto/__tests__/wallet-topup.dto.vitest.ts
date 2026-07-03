import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  WalletTopupDto,
  CreateWalletTopupOrderDto,
  ConfirmWalletTopupDto,
} from '../wallet-topup.dto';

/**
 * Unit tests for `WalletTopupDto` validation constraints.
 * Written before the DTO exists (TDD - RED phase), then confirmed GREEN.
 */
describe('WalletTopupDto', () => {
  function validate(plain: object) {
    return validateSync(plainToInstance(WalletTopupDto, plain), {
      whitelist: true,
    });
  }

  it('accepts amount = 100 with no ref', () => {
    const errors = validate({ amount: 100 });
    expect(errors).toHaveLength(0);
  });

  it('accepts amount = 1 (exact minimum)', () => {
    const errors = validate({ amount: 1 });
    expect(errors).toHaveLength(0);
  });

  it('accepts amount with optional ref string', () => {
    const errors = validate({ amount: 500, ref: 'rzp_test_abc123' });
    expect(errors).toHaveLength(0);
  });

  it('rejects amount = 0 (below Min 1)', () => {
    const errors = validate({ amount: 0 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });

  it('rejects amount = -5 (negative)', () => {
    const errors = validate({ amount: -5 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });

  it('rejects missing amount', () => {
    const errors = validate({});
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });

  it('accepts omitted ref (optional)', () => {
    const errors = validate({ amount: 200 });
    expect(errors).toHaveLength(0);
  });

  it('accepts ref = null as omitted via whitelist', () => {
    // whitelist strips unknown, undefined ref treated as absent
    const errors = validate({ amount: 200, ref: undefined });
    expect(errors).toHaveLength(0);
  });

  it('rejects non-number amount (string)', () => {
    const errors = validate({ amount: 'one-hundred' });
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });
});

describe('CreateWalletTopupOrderDto', () => {
  function validate(plain: object) {
    return validateSync(plainToInstance(CreateWalletTopupOrderDto, plain), {
      whitelist: true,
    });
  }

  it('accepts amount = 99 (exact minimum)', () => {
    expect(validate({ amount: 99 })).toHaveLength(0);
  });

  it('accepts amount = 5000', () => {
    expect(validate({ amount: 5000 })).toHaveLength(0);
  });

  it('rejects amount = 98 (below Min 99)', () => {
    const errors = validate({ amount: 98 });
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });

  it('rejects a non-integer amount', () => {
    const errors = validate({ amount: 100.5 });
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });

  it('rejects a missing amount', () => {
    const errors = validate({});
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });
});

describe('ConfirmWalletTopupDto', () => {
  function validate(plain: object) {
    return validateSync(plainToInstance(ConfirmWalletTopupDto, plain), {
      whitelist: true,
    });
  }

  const valid = {
    walletTopupId: '64b000000000000000000001',
    razorpayOrderId: 'order_RZP123',
    razorpayPaymentId: 'pay_RZP999',
    razorpaySignature: 'abc123signature',
  };

  it('accepts a fully populated payload', () => {
    expect(validate(valid)).toHaveLength(0);
  });

  it('rejects an empty walletTopupId', () => {
    const errors = validate({ ...valid, walletTopupId: '' });
    expect(errors.find((e) => e.property === 'walletTopupId')).toBeDefined();
  });

  it('rejects a missing razorpaySignature', () => {
    const { razorpaySignature, ...rest } = valid;
    void razorpaySignature;
    const errors = validate(rest);
    expect(errors.find((e) => e.property === 'razorpaySignature')).toBeDefined();
  });

  it('rejects a missing razorpayPaymentId', () => {
    const { razorpayPaymentId, ...rest } = valid;
    void razorpayPaymentId;
    const errors = validate(rest);
    expect(errors.find((e) => e.property === 'razorpayPaymentId')).toBeDefined();
  });
});
