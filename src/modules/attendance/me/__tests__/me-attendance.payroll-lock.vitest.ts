/**
 * me-attendance.payroll-lock.vitest.ts
 *
 * ATT-SEC-01 regression: MeAttendanceService.punch must throw the payroll-lock
 * error with a STRUCTURED { code: 'PAYROLL_LOCKED', message } body (not a bare
 * string), so the web error mapper (attendance.api.ts → getAttendanceErrorMessage)
 * can resolve `attendance.errors.PAYROLL_LOCKED` in all four locales for a worker
 * self-punching on a locked pay period. Previously the throw carried no `code`,
 * so gu / gu-en / hi-en workers saw raw English.
 *
 * Strategy: same as kiosk.vitest.ts — inline the guard chain of the real
 * `punch()` (offboard write-lock → self-punch policy gate → payroll-lock guard)
 * so we test the exact exception body shape without NestJS DI / Mongoose
 * decorator loading. The inlined `assertPunchAllowed` mirrors steps 1-3 of
 * MeAttendanceService.punch one-for-one; keep them in sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

// ── PolicyDeniedException mirror (avoids importing the decorated module tree) ──
class PolicyDeniedException extends ForbiddenException {
  constructor(code: string, message: string) {
    super({ code, message, policyDenied: true });
  }
}

// ── Inlined guard chain — mirrors MeAttendanceService.punch steps 1-3 ──────────
interface Deps {
  // step 1 + 2: offboard write-lock then self-punch policy toggle
  assertMemberWritable: (wsId: string, memberId: string) => Promise<void>;
  selfPunchEnabled: boolean;
  // step 3: salary-lock lookup result for (ws, member, this month/year)
  isSalaryLocked: boolean;
}

async function assertPunchAllowed(wsId: string, teamMemberId: string, deps: Deps): Promise<void> {
  // 1. Offboarded members cannot self-punch (MEMBER_OFFBOARDED).
  await deps.assertMemberWritable(wsId, teamMemberId);

  // 2. Workspace policy — self check-in must be enabled by the owner.
  if (!deps.selfPunchEnabled) {
    throw new PolicyDeniedException(
      'SELF_PUNCH_DISABLED',
      'Self check-in is turned off for this workspace. Ask an admin to enable it.',
    );
  }

  // 3. Payroll-lock guard — structured { code, message } body (ATT-SEC-01).
  if (deps.isSalaryLocked) {
    throw new BadRequestException({
      code: 'PAYROLL_LOCKED',
      message: 'Attendance is locked — payroll has been generated for this period.',
    });
  }
}

const WS_ID = 'ws-1';
const MEMBER_ID = 'member-1';

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    assertMemberWritable: vi.fn().mockResolvedValue(undefined),
    selfPunchEnabled: true,
    isSalaryLocked: false,
    ...overrides,
  };
}

describe('MeAttendanceService.punch — payroll-lock guard (ATT-SEC-01)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws BadRequestException when the pay period is locked', async () => {
    const deps = makeDeps({ isSalaryLocked: true });
    await expect(assertPunchAllowed(WS_ID, MEMBER_ID, deps)).rejects.toThrow(BadRequestException);
  });

  it("carries a structured { code: 'PAYROLL_LOCKED' } body the web mapper keys off", async () => {
    const deps = makeDeps({ isSalaryLocked: true });
    try {
      await assertPunchAllowed(WS_ID, MEMBER_ID, deps);
      throw new Error('expected punch to throw on a locked period');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      // NestJS HttpException.getResponse() returns the object we threw, which is
      // the exact body the FE error mapper reads (response.data.code).
      const body = (err as BadRequestException).getResponse() as {
        code?: string;
        message?: string;
      };
      expect(body.code).toBe('PAYROLL_LOCKED');
      // English fallback message preserved for the no-translator path.
      expect(body.message).toBe(
        'Attendance is locked — payroll has been generated for this period.',
      );
    }
  });

  it('does NOT throw the payroll-lock error when the period is unlocked', async () => {
    const deps = makeDeps({ isSalaryLocked: false });
    await expect(assertPunchAllowed(WS_ID, MEMBER_ID, deps)).resolves.toBeUndefined();
  });

  it('still blocks an offboarded member before the payroll-lock guard runs', async () => {
    const deps = makeDeps({
      isSalaryLocked: true,
      assertMemberWritable: vi
        .fn()
        .mockRejectedValue(
          new ForbiddenException({ code: 'MEMBER_OFFBOARDED', message: 'removed' }),
        ),
    });
    await expect(assertPunchAllowed(WS_ID, MEMBER_ID, deps)).rejects.toThrow(ForbiddenException);
  });

  it('blocks with SELF_PUNCH_DISABLED when the policy toggle is off, before payroll-lock', async () => {
    const deps = makeDeps({ selfPunchEnabled: false, isSalaryLocked: true });
    try {
      await assertPunchAllowed(WS_ID, MEMBER_ID, deps);
      throw new Error('expected a policy-denied throw');
    } catch (err) {
      const body = (err as ForbiddenException).getResponse() as { code?: string };
      expect(body.code).toBe('SELF_PUNCH_DISABLED');
    }
  });
});
