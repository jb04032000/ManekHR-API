import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanDto } from '../subscription.dto';

/**
 * Optional/configurable subscription-plan GST (Task 3). The catalogue
 * CreatePlanDto (and therefore Partial<CreatePlanDto> for PATCH) now accepts
 * `gstEnabled`, `gstRatePercent`, and `isPriceTaxInclusive` so the admin
 * catalogue form can set them — previously the forbidNonWhitelisted pipe
 * stripped them. Locks the validation contract.
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

describe('CreatePlanDto GST fields (Task 3)', () => {
  it('accepts gstEnabled + gstRatePercent + isPriceTaxInclusive together', async () => {
    const dto = plainToInstance(
      CreatePlanDto,
      baseValidPlan({
        gstEnabled: false,
        gstRatePercent: 12,
        isPriceTaxInclusive: true,
      }),
    );
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('accepts gstRatePercent at the bounds 0 and 50', async () => {
    const dto0 = plainToInstance(CreatePlanDto, baseValidPlan({ gstRatePercent: 0 }));
    const errors0 = await validate(dto0, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors0).toEqual([]);

    const dto50 = plainToInstance(CreatePlanDto, baseValidPlan({ gstRatePercent: 50 }));
    const errors50 = await validate(dto50, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors50).toEqual([]);
  });

  it('rejects a gstRatePercent above 50', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ gstRatePercent: 51 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'gstRatePercent')).toBe(true);
  });

  it('rejects a negative gstRatePercent', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ gstRatePercent: -1 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'gstRatePercent')).toBe(true);
  });

  it('rejects a non-integer gstRatePercent', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ gstRatePercent: 18.5 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'gstRatePercent')).toBe(true);
  });

  it('rejects a non-boolean gstEnabled', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ gstEnabled: 'yes' }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'gstEnabled')).toBe(true);
  });

  it('rejects a non-boolean isPriceTaxInclusive', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ isPriceTaxInclusive: 'no' }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'isPriceTaxInclusive')).toBe(true);
  });
});
