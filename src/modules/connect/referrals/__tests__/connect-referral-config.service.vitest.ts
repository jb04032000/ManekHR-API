import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConnectReferralConfigService } from '../services/connect-referral-config.service';
import { CONNECT_REFERRAL_DEFAULTS } from '../schemas/connect-referral-config.schema';
import { AppModule } from '../../../../common/enums/modules.enum';

function makeModel(doc: any) {
  return {
    findOneAndUpdate: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) }),
  } as any;
}
const audit = { logEvent: vi.fn().mockResolvedValue(undefined) } as any;

describe('ConnectReferralConfigService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts + returns defaults on first read', async () => {
    const doc = { _id: 'x', ...CONNECT_REFERRAL_DEFAULTS };
    const svc = new ConnectReferralConfigService(makeModel(doc), audit);
    const view = await svc.getConfig(1000);
    expect(view.referrerCredits).toBe(50);
    expect(view.enabled).toBe(true);
  });

  it('rejects holdbackDays above guardrail', async () => {
    const svc = new ConnectReferralConfigService(makeModel({}), audit);
    await expect(
      svc.updateConfig({ ...CONNECT_REFERRAL_DEFAULTS, holdbackDays: 1000 } as any, 'admin1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes + audits a valid update', async () => {
    const doc = { _id: 'cfg1', ...CONNECT_REFERRAL_DEFAULTS, referrerCredits: 100 };
    const svc = new ConnectReferralConfigService(makeModel(doc), audit);
    const view = await svc.updateConfig(
      { ...CONNECT_REFERRAL_DEFAULTS, referrerCredits: 100 } as any,
      'admin1',
    );
    expect(view.referrerCredits).toBe(100);
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'referral_config_updated',
        actorId: 'admin1',
        module: AppModule.ADS,
        entityType: 'ConnectReferralConfig',
      }),
    );
  });

  it('rejects referrerCredits above guardrail (20000 > max 10000)', async () => {
    const svc = new ConnectReferralConfigService(makeModel({}), audit);
    await expect(
      svc.updateConfig({ ...CONNECT_REFERRAL_DEFAULTS, referrerCredits: 20000 } as any, 'admin1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
