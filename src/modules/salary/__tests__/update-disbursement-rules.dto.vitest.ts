import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateDisbursementRulesDto } from '../dto/update-disbursement-rules.dto';

/**
 * advancePayoutDay validation contract (Phase 1b — two-step disburse).
 *
 * The advance batch is distributed on a fixed day-of-month (e.g. 25), separate
 * from salaryDate. The DTO accepts 1-28 (mirrors salaryDate/advanceRequestDay so
 * every month has the day) and rejects out-of-range values. The global pipe runs
 * whitelist + forbidNonWhitelisted, so a newly-added field MUST be declared on
 * the DTO or the whole request 400s.
 * Links: update-disbursement-rules.dto.ts, payroll-config.schema.ts disbursementRules,
 * salary.service.ts updateDisbursementRules.
 */
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

describe('UpdateDisbursementRulesDto - advancePayoutDay', () => {
  it('ACCEPTS a valid advancePayoutDay (25)', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, { advancePayoutDay: 25 });
    const errors = await validate(dto, PIPE_OPTS);
    expect(errors).toHaveLength(0);
  });

  it('REJECTS advancePayoutDay = 0 (below min)', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, { advancePayoutDay: 0 });
    const errors = await validate(dto, PIPE_OPTS);
    const offending = errors.find((e) => e.property === 'advancePayoutDay');
    expect(offending).toBeDefined();
    expect(offending?.constraints ?? {}).toHaveProperty('min');
  });

  it('REJECTS advancePayoutDay = 40 (above max)', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, { advancePayoutDay: 40 });
    const errors = await validate(dto, PIPE_OPTS);
    const offending = errors.find((e) => e.property === 'advancePayoutDay');
    expect(offending).toBeDefined();
    expect(offending?.constraints ?? {}).toHaveProperty('max');
  });

  it('still ACCEPTS a body with no advancePayoutDay (optional)', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, { salaryDate: 1 });
    const errors = await validate(dto, PIPE_OPTS);
    expect(errors).toHaveLength(0);
  });
});
