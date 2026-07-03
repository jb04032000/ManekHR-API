import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanDto } from '../subscription.dto';

/**
 * Phase-2 ERP pricing rework — `trialDurationDays` + `isDefault` are now
 * accepted on CreatePlanDto (and therefore Partial<CreatePlanDto> for PATCH).
 * Locks the validation contract: valid int trial ≥0 + boolean isDefault pass;
 * negative trial / non-int fail.
 */
const baseValidPlan = (extra: Record<string, unknown>) => ({
  name: 'Free Plan',
  tier: 'free',
  monthlyPrice: 0,
  yearlyPrice: 0,
  entitlements: {
    maxWorkspaces: 1,
    maxMembersPerWorkspace: 5,
    maxTotalMembers: 5,
    modules: [],
    features: {},
  },
  ...extra,
});

describe('CreatePlanDto trialDurationDays + isDefault (Phase 2)', () => {
  it('accepts a valid trialDurationDays (int ≥0) and boolean isDefault', async () => {
    const dto = plainToInstance(
      CreatePlanDto,
      baseValidPlan({ trialDurationDays: 14, isDefault: true }),
    );
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('accepts trialDurationDays of 0 (no trial)', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ trialDurationDays: 0 }));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('rejects a negative trialDurationDays', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ trialDurationDays: -1 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'trialDurationDays')).toBe(true);
  });

  it('rejects a non-integer trialDurationDays', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ trialDurationDays: 1.5 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'trialDurationDays')).toBe(true);
  });

  it('rejects a non-boolean isDefault', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ isDefault: 'yes' }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'isDefault')).toBe(true);
  });
});
