import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlanEntitlementsDto } from '../subscription.dto';

/**
 * Regression: the admin "Assign Connect package" flow re-sends a stored plan's
 * FULL connect block (Mongoose fills storageMb / overLimitPolicy / overLimitGraceDays
 * defaults at create). With the global pipe's forbidNonWhitelisted on, every one of
 * those fields MUST be whitelisted on PlanConnectEntitlementsDto or the whole
 * assignment 400s. This locks the contract.
 */
const FULL_CONNECT = {
  maxListings: 25,
  leadsPerMonth: -1,
  includedBoostCredits: 0,
  verifiedBadge: false,
  searchPriority: 0,
  maxCompanyPages: 1,
  maxStorefronts: 1,
  maxJobs: 10,
  storageMb: 500,
  overLimitPolicy: 'freeze',
  overLimitGraceDays: 30,
};

const baseEntitlements = (connect: Record<string, unknown>) => ({
  maxWorkspaces: 0,
  maxMembersPerWorkspace: 0,
  maxTotalMembers: 0,
  modules: [],
  features: {},
  moduleAccess: [],
  connect,
});

describe('PlanConnectEntitlementsDto whitelist (admin assign re-send)', () => {
  it('accepts the full stored connect block with no validation errors', async () => {
    const dto = plainToInstance(PlanEntitlementsDto, baseEntitlements(FULL_CONNECT));
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });

  it('still rejects an unknown connect field (whitelist intact)', async () => {
    const dto = plainToInstance(
      PlanEntitlementsDto,
      baseEntitlements({ ...FULL_CONNECT, bogusField: 1 }),
    );
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
