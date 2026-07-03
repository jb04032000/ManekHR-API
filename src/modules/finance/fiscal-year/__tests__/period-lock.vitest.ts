/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators so the FiscalYear + Firm schema imports don't trip the
// "Cannot determine type" reflection error under vitest. Models are injected as mocks.
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

import { FyLockService } from '../fy-lock.service';

const fyOpen = () => ({
  findOne: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
});
const firmWithLock = (lockedUptoDate: Date | undefined) => ({
  findById: vi.fn(() => ({
    select: () => ({
      lean: () => Promise.resolve(lockedUptoDate ? { booksLockedUptoDate: lockedUptoDate } : {}),
    }),
  })),
});
const fyClosed = () => ({
  findOne: vi.fn(() => ({
    select: () => ({
      lean: () =>
        Promise.resolve({
          status: 'CLOSED',
          startDate: new Date('2026-04-01'),
          endDate: new Date('2027-03-31'),
        }),
    }),
  })),
});
const makeAudit = () => ({ logEvent: vi.fn(() => Promise.resolve()) });

const ws = '000000000000000000000001';
const firm = '000000000000000000000002';

// D21: postings dated on or before the firm's books-lock date are blocked, even in an open FY.
describe('FyLockService period lock (D21)', () => {
  it('allows posting when no period lock is set', async () => {
    const svc = new FyLockService(
      fyOpen() as any,
      firmWithLock(undefined) as any,
      makeAudit() as any,
    );
    await expect(svc.assertOpen(ws, firm, new Date('2026-05-15'))).resolves.toBeUndefined();
  });

  it('blocks a posting dated on or before the lock date', async () => {
    const svc = new FyLockService(
      fyOpen() as any,
      firmWithLock(new Date('2026-05-31')) as any,
      makeAudit() as any,
    );
    await expect(svc.assertOpen(ws, firm, new Date('2026-05-15'))).rejects.toThrow(/locked up to/i);
    // exactly on the lock date is also blocked
    await expect(svc.assertOpen(ws, firm, new Date('2026-05-31'))).rejects.toThrow(/locked up to/i);
    // R4: the soft books-lock rejection carries the FINANCE_PERIOD_LOCKED discriminator
    // (+ lockedUptoDate) so the editor can pop the amendment-reason prompt.
    await expect(svc.assertOpen(ws, firm, new Date('2026-05-15'))).rejects.toMatchObject({
      response: { code: 'FINANCE_PERIOD_LOCKED', lockedUptoDate: '2026-05-31' },
    });
  });

  it('allows a posting dated after the lock date', async () => {
    const svc = new FyLockService(
      fyOpen() as any,
      firmWithLock(new Date('2026-05-31')) as any,
      makeAudit() as any,
    );
    await expect(svc.assertOpen(ws, firm, new Date('2026-06-15'))).resolves.toBeUndefined();
  });

  // D21 amendment path: a dated correction into the locked period is allowed with a reason + audit.
  it('allows a locked-period posting when an amendment reason is supplied, and audits it', async () => {
    const audit = makeAudit();
    const svc = new FyLockService(
      fyOpen() as any,
      firmWithLock(new Date('2026-05-31')) as any,
      audit as any,
    );
    await expect(
      svc.assertOpen(ws, firm, new Date('2026-05-15'), {
        amendment: { reason: 'correcting a missed bill', actorId: ws },
      }),
    ).resolves.toBeUndefined();
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
  });

  it('does not let an amendment bypass a CLOSED fiscal year', async () => {
    const audit = makeAudit();
    const svc = new FyLockService(fyClosed() as any, firmWithLock(undefined) as any, audit as any);
    await expect(
      svc.assertOpen(ws, firm, new Date('2026-05-15'), {
        amendment: { reason: 'x', actorId: ws },
      }),
    ).rejects.toThrow(/closed/i);
    expect(audit.logEvent).not.toHaveBeenCalled();
  });
});
