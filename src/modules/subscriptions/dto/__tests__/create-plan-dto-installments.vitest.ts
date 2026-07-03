import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanDto } from '../subscription.dto';

/**
 * Upfront-vs-installments pricing rework — CreatePlanDto now accepts three
 * admin-tunable billing levers (and therefore Partial<CreatePlanDto> for PATCH):
 *   - upfrontDiscountPercent : % off the yearly price for a single upfront
 *     payment. Bounded 0..100.
 *   - installmentsEnabled    : whether the 12×0% monthly option is offered.
 *   - installmentMonths      : how many monthly installments (1..24).
 * Locks the validation contract: in-range values pass; out-of-range / wrong
 * type fail.
 */
const baseValidPlan = (extra: Record<string, unknown>) => ({
  name: 'Starter Plan',
  tier: 'starter',
  monthlyPrice: 100,
  yearlyPrice: 1000,
  entitlements: {
    maxWorkspaces: 1,
    maxMembersPerWorkspace: 5,
    maxTotalMembers: 5,
    modules: [],
    features: {},
  },
  ...extra,
});

describe('CreatePlanDto upfront discount + installments', () => {
  it('accepts valid values for all three fields', async () => {
    const dto = plainToInstance(
      CreatePlanDto,
      baseValidPlan({
        upfrontDiscountPercent: 10,
        installmentsEnabled: true,
        installmentMonths: 12,
      }),
    );
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  // ── upfrontDiscountPercent (0..100) ───────────────────────────────────────
  it('accepts upfrontDiscountPercent of 0 (no discount)', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ upfrontDiscountPercent: 0 }));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('accepts upfrontDiscountPercent of 100', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ upfrontDiscountPercent: 100 }));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('rejects upfrontDiscountPercent above 100', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ upfrontDiscountPercent: 101 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'upfrontDiscountPercent')).toBe(true);
  });

  it('rejects a negative upfrontDiscountPercent', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ upfrontDiscountPercent: -1 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'upfrontDiscountPercent')).toBe(true);
  });

  // ── installmentsEnabled (boolean) ─────────────────────────────────────────
  it('accepts a boolean installmentsEnabled', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ installmentsEnabled: false }));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('rejects a non-boolean installmentsEnabled', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ installmentsEnabled: 'yes' }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'installmentsEnabled')).toBe(true);
  });

  // ── installmentMonths (int 1..24) ─────────────────────────────────────────
  it('accepts installmentMonths of 1 and 24', async () => {
    const dto1 = plainToInstance(CreatePlanDto, baseValidPlan({ installmentMonths: 1 }));
    const errors1 = await validate(dto1, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors1).toEqual([]);

    const dto24 = plainToInstance(CreatePlanDto, baseValidPlan({ installmentMonths: 24 }));
    const errors24 = await validate(dto24, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors24).toEqual([]);
  });

  it('rejects installmentMonths of 0', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ installmentMonths: 0 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'installmentMonths')).toBe(true);
  });

  it('rejects installmentMonths above 24', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ installmentMonths: 25 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'installmentMonths')).toBe(true);
  });

  it('rejects a non-integer installmentMonths', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ installmentMonths: 12.5 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'installmentMonths')).toBe(true);
  });
});
