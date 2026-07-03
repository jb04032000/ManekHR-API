import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateAdvanceRequestDto } from '../dto/advance-salary-request.dto';

/**
 * Root-cause guard for the "advance request fails with a generic 400" bug.
 *
 * The global ValidationPipe (src/main.ts) runs `whitelist: true` +
 * `forbidNonWhitelisted: true`. The IDOR fix removed `teamMemberId` from
 * CreateAdvanceRequestDto (the caller's own member id is resolved from the JWT),
 * so ANY `teamMemberId` in the request body is a non-whitelisted property and
 * the pipe rejects the whole request with a 400 BEFORE the handler runs. The
 * frontend used to send it; this test documents the contract so the FE/BE pair
 * cannot silently drift again. Mirrors the pipe options exactly.
 * Links: advance-salary-request.dto.ts, advance-salary-request.controller.ts,
 * crewroster-web AdvanceRequestDrawer.tsx.
 */
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

describe('CreateAdvanceRequestDto - whitelist contract (forbidNonWhitelisted)', () => {
  it('REJECTS a body that carries teamMemberId (the old FE payload -> 400)', async () => {
    const dto = plainToInstance(CreateAdvanceRequestDto, {
      teamMemberId: '000000000000000000000000',
      requestedAmount: 5000,
      month: 6,
      year: 2026,
    });
    const errors = await validate(dto, PIPE_OPTS);
    const offending = errors.find((e) => e.property === 'teamMemberId');
    expect(offending).toBeDefined();
    expect(offending?.constraints ?? {}).toHaveProperty('whitelistValidation');
  });

  it('ACCEPTS the slim {requestedAmount, month, year} body (the fixed FE payload)', async () => {
    const dto = plainToInstance(CreateAdvanceRequestDto, {
      requestedAmount: 5000,
      month: 6,
      year: 2026,
    });
    const errors = await validate(dto, PIPE_OPTS);
    expect(errors).toHaveLength(0);
  });
});
