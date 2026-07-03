/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { SalaryLifecycleService } from '../salary-lifecycle.service';

/**
 * Workstream G hardening Pillar 1 — SalaryLifecycleService covers:
 *   - memberHasHistory() Remove-vs-Delete gate (AC-1.1)
 *   - onMemberRemoved() cascade: pause schedules (AC-1.2), cancel pending
 *     advances (AC-1.3), alert on open loans, and NEVER delete Bucket-B rows.
 */
function existsModel(hit: boolean) {
  return { exists: vi.fn().mockResolvedValue(hit ? { _id: 'x' } : null) };
}

// updateMany/countDocuments in onMemberRemoved are called with `.exec()`.
function updateManyMock(modifiedCount: number) {
  return vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({ modifiedCount }) });
}
function countMock(n: number) {
  return vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(n) });
}

function makeService(overrides: Partial<Record<string, any>> = {}) {
  // 12 history-probe models in memberHasHistory order; default = no history.
  const noHistory = () => existsModel(false);
  const models = {
    salary: overrides.salary ?? noHistory(),
    payment: overrides.payment ?? noHistory(),
    adjustment: overrides.adjustment ?? noHistory(),
    increment: overrides.increment ?? noHistory(),
    taxDeclaration: overrides.taxDeclaration ?? noHistory(),
    gratuity: overrides.gratuity ?? noHistory(),
    fnf: overrides.fnf ?? noHistory(),
    advancePlan: overrides.advancePlan ?? noHistory(),
    advanceRequest:
      overrides.advanceRequest ?? Object.assign(noHistory(), { updateMany: updateManyMock(0) }),
    loan: overrides.loan ?? Object.assign(noHistory(), { countDocuments: countMock(0) }),
    commission:
      overrides.commission ?? Object.assign(noHistory(), { updateMany: updateManyMock(0) }),
    cashLedger: overrides.cashLedger ?? noHistory(),
  };

  const notifications = { createNotification: vi.fn().mockResolvedValue(undefined) };
  const audit = { logEvent: vi.fn().mockResolvedValue(undefined) };

  // db.collection('workspaces').findOne for owner lookup is reached via salaryModel.db.
  models.salary.db = {
    collection: () => ({ findOne: vi.fn().mockResolvedValue({ ownerId: 'owner1' }) }),
  };

  const service = new SalaryLifecycleService(
    models.salary,
    models.payment,
    models.adjustment,
    models.increment,
    models.taxDeclaration,
    models.gratuity,
    models.fnf,
    models.advancePlan,
    models.advanceRequest,
    models.loan,
    models.commission,
    models.cashLedger,
    notifications as any,
    audit as any,
  );
  return { service, models, notifications, audit };
}

const WS = '5f8d04b3b54764421b7156aa';
const TM = '5f8d04b3b54764421b7156bb';

describe('SalaryLifecycleService.memberHasHistory (AC-1.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when no salary collection has a row', async () => {
    const { service } = makeService();
    await expect(service.memberHasHistory(WS, TM)).resolves.toBe(false);
  });

  it('returns true when a Payment row exists', async () => {
    const { service } = makeService({ payment: existsModel(true) });
    await expect(service.memberHasHistory(WS, TM)).resolves.toBe(true);
  });

  it('returns true when a CashLedgerEntry exists', async () => {
    const { service } = makeService({ cashLedger: existsModel(true) });
    await expect(service.memberHasHistory(WS, TM)).resolves.toBe(true);
  });
});

describe('SalaryLifecycleService.onMemberRemoved cascade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pauses active commission schedules + cancels pending advances + reports open loans', async () => {
    const commission = Object.assign(existsModel(false), { updateMany: updateManyMock(2) });
    const advanceRequest = Object.assign(existsModel(false), { updateMany: updateManyMock(1) });
    const loan = Object.assign(existsModel(false), { countDocuments: countMock(3) });
    const { service, notifications } = makeService({ commission, advanceRequest, loan });

    const result = await service.onMemberRemoved(WS, TM, 'actor1');

    expect(commission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      { $set: { status: 'paused' } },
    );
    expect(advanceRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      { $set: { status: 'cancelled' } },
    );
    expect(result).toEqual({ pausedSchedules: 2, cancelledRequests: 1, openLoans: 3 });
    // Owner was alerted about the 3 open loans.
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('does not alert when there are no open loans', async () => {
    const { service, notifications } = makeService();
    const result = await service.onMemberRemoved(WS, TM, 'actor1');
    expect(result.openLoans).toBe(0);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
