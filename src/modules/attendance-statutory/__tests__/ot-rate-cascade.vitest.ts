import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Model } from 'mongoose';

// Target (to be implemented in G-02)
import { OtRateResolver } from '../services/ot-rate-resolver.service';

function mockSalaryModel(returnDoc: any) {
  return { findOne: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(returnDoc) }) }) } as unknown as Model<any>;
}
function mockTeamMemberModel(returnDoc: any) {
  return { findById: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(returnDoc) }) }) } as unknown as Model<any>;
}

describe('OtRateResolver (DG-5 cascade)', () => {
  it('level 1: uses Salary.baseSalary / workingDaysInMonth when salary record exists', async () => {
    const salary = mockSalaryModel({ baseSalary: 26000 });
    const member = mockTeamMemberModel({ ctcAmount: 0 });
    const resolver = new OtRateResolver(salary, member);
    const result = await resolver.resolve('wsId', 'memberA', 2026, 4, 26, undefined);
    expect(result.dailyRate).toBe(1000);                  // 26000 / 26
    expect(result.source).toBe('salary_ledger');
  });

  it('level 2: falls back to TeamMember.ctcAmount / 26 when no salary record', async () => {
    const salary = mockSalaryModel(null);
    const member = mockTeamMemberModel({ ctcAmount: 52000 });
    const resolver = new OtRateResolver(salary, member);
    const result = await resolver.resolve('wsId', 'memberA', 2026, 4, 26, undefined);
    expect(result.dailyRate).toBe(2000);                   // 52000 / 26
    expect(result.source).toBe('ctc_amount');
  });

  it('level 3: uses customDailyRate when both levels 1 and 2 are missing', async () => {
    const salary = mockSalaryModel(null);
    const member = mockTeamMemberModel({ ctcAmount: 0 });
    const resolver = new OtRateResolver(salary, member);
    const result = await resolver.resolve('wsId', 'memberA', 2026, 4, 26, 750);
    expect(result.dailyRate).toBe(750);
    expect(result.source).toBe('custom_override');
  });

  it('throws when all three sources are absent', async () => {
    const salary = mockSalaryModel(null);
    const member = mockTeamMemberModel(null);
    const resolver = new OtRateResolver(salary, member);
    await expect(resolver.resolve('wsId', 'memberA', 2026, 4, 26, undefined)).rejects.toThrow(/Cannot determine daily rate/);
  });

  it('queries Salary with { workspaceId, teamMemberId, year, month } (NOT yearMonth string)', async () => {
    const salary = mockSalaryModel({ baseSalary: 30000 });
    const member = mockTeamMemberModel(null);
    const resolver = new OtRateResolver(salary, member);
    await resolver.resolve('ws1', 'memberX', 2026, 4, 30, undefined);
    expect((salary as any).findOne).toHaveBeenCalledWith(expect.objectContaining({ year: 2026, month: 4 }));
  });
});
