import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanDto } from '../subscription.dto';

/**
 * Admin-configurable Trial Plan — `isTrialPlan` is accepted on CreatePlanDto
 * (and therefore Partial<CreatePlanDto> for PATCH). With forbidNonWhitelisted
 * ON, the field MUST be whitelisted here or it gets stripped before reaching
 * the service. Locks the contract: boolean passes, non-boolean fails.
 */
const baseValidPlan = (extra: Record<string, unknown>) => ({
  name: 'Trial Plan',
  tier: 'growth',
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

describe('CreatePlanDto isTrialPlan', () => {
  it('accepts a boolean isTrialPlan and survives forbidNonWhitelisted', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ isTrialPlan: true }));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
    expect(dto.isTrialPlan).toBe(true);
  });

  it('is optional (absent is valid)', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({}));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('rejects a non-boolean isTrialPlan', async () => {
    const dto = plainToInstance(CreatePlanDto, baseValidPlan({ isTrialPlan: 'yes' }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'isTrialPlan')).toBe(true);
  });
});
