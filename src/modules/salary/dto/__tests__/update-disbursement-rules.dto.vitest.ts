import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateDisbursementRulesDto } from '../update-disbursement-rules.dto';

const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

describe('UpdateDisbursementRulesDto - advanceRequestPolicy', () => {
  it('accepts a valid window policy', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'window', windowStartDay: 21, windowEndDay: 23 },
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('accepts a fixed_day policy', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'fixed_day', fixedDay: 21 },
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('rejects an unknown mode', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'whenever' },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a day out of 1..31', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'window', windowStartDay: 0, windowEndDay: 40 },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });
});
