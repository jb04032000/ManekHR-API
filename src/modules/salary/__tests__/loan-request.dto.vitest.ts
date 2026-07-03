import { describe, it, expect, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// Stub @nestjs/mongoose decorators BEFORE importing the DTO. The DTO imports
// INTEREST_TYPES + ApprovalStepDto, which transitively pull in
// employer-loan.schema.ts (decorated with @Prop/@Schema). Under vitest's esbuild
// transform those decorators trip the "Cannot determine type" reflection error.
// We only need the plain const + the validation classes here, so neutralize the
// Mongoose decorators (worked example: auth.service.audit.vitest.ts).
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

import {
  CreateLoanRequestDto,
  ApproveLoanRequestDto,
  RejectLoanRequestDto,
} from '../dto/loan-request.dto';
import { UpdatePayrollConfigDto } from '../dto/update-payroll-config.dto';

// Mirrors the controller ValidationPipe: unknown props are stripped and, when
// present, cause validation to fail (forbidNonWhitelisted). Same approach as
// update-disbursement-rules.dto.vitest.ts.
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

describe('CreateLoanRequestDto', () => {
  it('accepts a valid body', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 5_000_00, // paise
      desiredTenorMonths: 6,
      purpose: 'Medical expenses',
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('accepts a valid body without the optional purpose', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 100_00,
      desiredTenorMonths: 1,
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('rejects requestedAmount < 1', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 0,
      desiredTenorMonths: 6,
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a non-integer requestedAmount', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 1234.56,
      desiredTenorMonths: 6,
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects desiredTenorMonths below 1', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 100_00,
      desiredTenorMonths: 0,
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects desiredTenorMonths above 120', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 100_00,
      desiredTenorMonths: 121,
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a too-long purpose', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 100_00,
      desiredTenorMonths: 6,
      purpose: 'x'.repeat(501),
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a client-supplied teamMemberId (IDOR guard via forbidNonWhitelisted)', async () => {
    const dto = plainToInstance(CreateLoanRequestDto, {
      requestedAmount: 100_00,
      desiredTenorMonths: 6,
      teamMemberId: '507f1f77bcf86cd799439011',
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });
});

describe('ApproveLoanRequestDto', () => {
  it('defaults interestType to zero when omitted', async () => {
    const dto = plainToInstance(ApproveLoanRequestDto, {
      tenorMonths: 6,
      startMonth: 7,
      startYear: 2026,
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
    expect(dto.interestType).toBe('zero');
  });

  it('accepts a full valid approve body (explicit zero, principal, chain)', async () => {
    const dto = plainToInstance(ApproveLoanRequestDto, {
      tenorMonths: 12,
      startMonth: 1,
      startYear: 2027,
      interestType: 'zero',
      principalAmount: 50_000_00,
      approvalChain: [{ approverId: '507f1f77bcf86cd799439011', approverName: 'Owner' }],
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('rejects tenorMonths above 120', async () => {
    const dto = plainToInstance(ApproveLoanRequestDto, {
      tenorMonths: 121,
      startMonth: 7,
      startYear: 2026,
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a startMonth out of 1..12', async () => {
    const dto = plainToInstance(ApproveLoanRequestDto, {
      tenorMonths: 6,
      startMonth: 13,
      startYear: 2026,
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects an unknown interestType', async () => {
    const dto = plainToInstance(ApproveLoanRequestDto, {
      tenorMonths: 6,
      startMonth: 7,
      startYear: 2026,
      interestType: 'flat_rate',
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });
});

describe('RejectLoanRequestDto', () => {
  it('accepts a valid reason', async () => {
    const dto = plainToInstance(RejectLoanRequestDto, { reason: 'Outstanding loan exists' });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('rejects a missing reason', async () => {
    const dto = plainToInstance(RejectLoanRequestDto, {});
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a too-long reason', async () => {
    const dto = plainToInstance(RejectLoanRequestDto, { reason: 'x'.repeat(501) });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });
});

describe('UpdatePayrollConfigDto - loanConfig self-apply', () => {
  it('accepts the three self-apply fields', async () => {
    const dto = plainToInstance(UpdatePayrollConfigDto, {
      loanConfig: {
        selfApplyEnabled: true,
        selfApplyMinTenureMonths: 6,
        selfApplyMaxAmount: 100_000_00,
      },
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('accepts null to clear the optional caps', async () => {
    const dto = plainToInstance(UpdatePayrollConfigDto, {
      loanConfig: { selfApplyMinTenureMonths: null, selfApplyMaxAmount: null },
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('rejects a non-boolean selfApplyEnabled', async () => {
    const dto = plainToInstance(UpdatePayrollConfigDto, {
      loanConfig: { selfApplyEnabled: 'yes' },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a negative selfApplyMinTenureMonths', async () => {
    const dto = plainToInstance(UpdatePayrollConfigDto, {
      loanConfig: { selfApplyMinTenureMonths: -1 },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects an unknown field inside loanConfig', async () => {
    const dto = plainToInstance(UpdatePayrollConfigDto, {
      loanConfig: { selfApplyEnabled: true, bogus: 1 },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });
});
