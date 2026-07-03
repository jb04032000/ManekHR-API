/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import { ReferralAdminController } from '../controllers/referral-admin.controller';
import type { AdminReferralConfigDto } from '../dto/admin-referral-config.dto';

/**
 * Unit coverage for the admin referral controller (`admin/connect/referrals/*`).
 * Verifies: the class is JwtAuthGuard + IsAdminGuard protected; every route
 * delegates to the right service; and the admin id ALWAYS comes from
 * req.user.sub (never the body/param). Services are stubbed (their own specs
 * cover the guardrails / reversal / audit).
 */

const ADMIN = '60b0000000000000000000aa';
const REF_ID = '60b0000000000000000000c1';

function build() {
  const configService: any = {
    getConfig: vi.fn().mockResolvedValue({ enabled: false, referrerCredits: 50 }),
    updateConfig: vi.fn().mockResolvedValue({ enabled: true, referrerCredits: 100 }),
  };
  const referralService: any = {
    listReferrals: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    clawback: vi.fn().mockResolvedValue({ _id: REF_ID, status: 'rejected' }),
  };
  const controller = new ReferralAdminController(configService, referralService);
  const req: any = { user: { sub: ADMIN } };
  return { controller, configService, referralService, req };
}

const CFG: AdminReferralConfigDto = {
  enabled: true,
  referrerCredits: 100,
  refereeCredits: 50,
  holdbackDays: 7,
  perReferrerCap: 0,
  monthlyPerReferrerCap: 0,
  annualCreditCeilingPerUser: 19000,
  totalBudgetCap: 0,
  dailyVelocityPerReferrer: 10,
};

beforeEach(() => vi.clearAllMocks());

describe('ReferralAdminController', () => {
  it('is guarded by JwtAuthGuard + IsAdminGuard at the class level', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', ReferralAdminController) ?? [];
    const names = guards.map((g) => (g as { name?: string }).name ?? String(g));
    expect(names).toContain('JwtAuthGuard');
    expect(names).toContain('IsAdminGuard');
  });

  it('GET /config -> configService.getConfig()', async () => {
    const f = build();
    await f.controller.getConfig();
    expect(f.configService.getConfig).toHaveBeenCalledOnce();
  });

  it('PUT /config -> updateConfig(dto, req.user.sub) [admin id from JWT, not body]', async () => {
    const f = build();
    const out = await f.controller.updateConfig(CFG, f.req);
    expect(f.configService.updateConfig).toHaveBeenCalledWith(CFG, ADMIN);
    expect(out).toMatchObject({ enabled: true, referrerCredits: 100 });
  });

  it('GET / -> listReferrals with coerced/defaulted pagination + filters', async () => {
    const f = build();
    await f.controller.list({ status: 'rewarded', page: 2, pageSize: 50 } as any);
    expect(f.referralService.listReferrals).toHaveBeenCalledWith({
      status: 'rewarded',
      referrerUserId: undefined,
      page: 2,
      pageSize: 50,
    });
  });

  it('GET / -> defaults page=1 / pageSize=25 when query omits them', async () => {
    const f = build();
    await f.controller.list({} as any);
    expect(f.referralService.listReferrals).toHaveBeenCalledWith({
      status: undefined,
      referrerUserId: undefined,
      page: 1,
      pageSize: 25,
    });
  });

  it('POST /:id/clawback -> clawback(id, reason, req.user.sub) [admin id from JWT]', async () => {
    const f = build();
    await f.controller.clawback(REF_ID, { reason: 'fraud review' }, f.req);
    expect(f.referralService.clawback).toHaveBeenCalledWith(REF_ID, 'fraud review', ADMIN);
  });

  it('POST /:id/clawback -> empty-string reason when body omits it', async () => {
    const f = build();
    await f.controller.clawback(REF_ID, {}, f.req);
    expect(f.referralService.clawback).toHaveBeenCalledWith(REF_ID, '', ADMIN);
  });
});
