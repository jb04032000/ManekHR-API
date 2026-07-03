import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { CapitalGoodsItcService } from '../capital-goods-itc/capital-goods-itc.service';
import { CapitalGoodsItcCron } from '../capital-goods-itc/capital-goods-itc.cron';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM string (no date-fns dependency in unit tests) */
function fmtMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Add N months to a date and return new Date */
function addMonths(d: Date, n: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + n);
  return result;
}

function makeBill(overrides: Partial<{
  lineItems: any[];
  voucherDate: Date;
}> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    firmId: new Types.ObjectId(),
    voucherNumber: 'PB/25-26/001',
    voucherDate: overrides.voucherDate ?? new Date('2025-04-01'),
    financialYear: '2025-26',
    lineItems: overrides.lineItems ?? [],
  };
}

function makeSchedule(overrides: Partial<{
  monthsAmortised: number;
  monthsTotal: number;
  totalItcPaise: number;
  monthlyAmountPaise: number;
  status: string;
  itcSplit: string;
  nextAmortisationMonth: string;
  cgstTotalPaise: number;
  sgstTotalPaise: number;
  igstTotalPaise: number;
}> = {}) {
  const totalItcPaise = overrides.totalItcPaise ?? 6000;
  const monthlyAmountPaise = overrides.monthlyAmountPaise ?? Math.round(totalItcPaise / 60);
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    firmId: new Types.ObjectId(),
    sourceBillNumber: 'PB/25-26/001',
    itemName: 'Machine A',
    financialYear: '2025-26',
    totalItcPaise,
    monthlyAmountPaise,
    monthsTotal: overrides.monthsTotal ?? 60,
    monthsAmortised: overrides.monthsAmortised ?? 0,
    status: overrides.status ?? 'amortising',
    itcSplit: overrides.itcSplit ?? 'cgst_sgst',
    nextAmortisationMonth: overrides.nextAmortisationMonth ?? '2025-05',
    cgstTotalPaise: overrides.cgstTotalPaise ?? Math.round(totalItcPaise / 2),
    sgstTotalPaise: overrides.sgstTotalPaise ?? (totalItcPaise - Math.round(totalItcPaise / 2)),
    igstTotalPaise: overrides.igstTotalPaise ?? 0,
    cgstReleasedPaise: 0,
    sgstReleasedPaise: 0,
    igstReleasedPaise: 0,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── CapitalGoodsItcService.createScheduleForBill ────────────────────────────

describe('CapitalGoodsItcService.createScheduleForBill', () => {
  it('SC-3: skips lineItems where isCapitalGoods=false', async () => {
    const createFn = vi.fn().mockResolvedValue([{}]);
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const bill = makeBill({
      lineItems: [
        { isCapitalGoods: false, cgstPaise: 500, sgstPaise: 500, igstPaise: 0, itemName: 'Raw Material' },
      ],
    });

    const result = await svc.createScheduleForBill(bill as any);
    expect(result).toHaveLength(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it('SC-3: skips capital-goods lines where total ITC (cgst+sgst+igst) === 0', async () => {
    const createFn = vi.fn();
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const bill = makeBill({
      lineItems: [
        { isCapitalGoods: true, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, itemName: 'Exempt Machine' },
      ],
    });

    const result = await svc.createScheduleForBill(bill as any);
    expect(result).toHaveLength(0);
    expect(createFn).not.toHaveBeenCalled();
  });

  it('SC-3: creates one schedule per capital-goods line item (ignores non-capital lines)', async () => {
    let callCount = 0;
    const createFn = vi.fn().mockImplementation(async () => [{ _id: new Types.ObjectId() }]);
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const bill = makeBill({
      lineItems: [
        { isCapitalGoods: true, cgstPaise: 1000, sgstPaise: 1000, igstPaise: 0, itemName: 'Machine A' },
        { isCapitalGoods: false, cgstPaise: 200, sgstPaise: 200, igstPaise: 0, itemName: 'Supplies' },
        { isCapitalGoods: true, cgstPaise: 500, sgstPaise: 500, igstPaise: 0, itemName: 'Machine B' },
      ],
    });

    const result = await svc.createScheduleForBill(bill as any);
    expect(result).toHaveLength(2);
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('SC-3: monthlyAmountPaise = Math.round(totalItcPaise / 60)', async () => {
    const totalItcPaise = 6001; // odd to test rounding
    const expectedMonthly = Math.round(totalItcPaise / 60); // 100
    let capturedDoc: any = null;
    const createFn = vi.fn().mockImplementation(async ([doc]: any[]) => {
      capturedDoc = doc;
      return [{ ...doc }];
    });
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const cgst = Math.round(totalItcPaise / 2);
    const sgst = totalItcPaise - cgst;
    const bill = makeBill({
      lineItems: [{ isCapitalGoods: true, cgstPaise: cgst, sgstPaise: sgst, igstPaise: 0, itemName: 'Machine' }],
    });

    await svc.createScheduleForBill(bill as any);
    expect(capturedDoc.monthlyAmountPaise).toBe(expectedMonthly);
    expect(capturedDoc.monthsTotal).toBe(60);
    expect(capturedDoc.monthsAmortised).toBe(0);
  });

  it('SC-3: nextAmortisationMonth is startMonth + 1 month in YYYY-MM format', async () => {
    let capturedDoc: any = null;
    const createFn = vi.fn().mockImplementation(async ([doc]: any[]) => {
      capturedDoc = doc;
      return [{ ...doc }];
    });
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const voucherDate = new Date('2025-04-15');
    const bill = makeBill({
      voucherDate,
      lineItems: [{ isCapitalGoods: true, cgstPaise: 1000, sgstPaise: 1000, igstPaise: 0, itemName: 'M' }],
    });

    await svc.createScheduleForBill(bill as any);

    expect(capturedDoc.startMonth).toBe('2025-04');
    expect(capturedDoc.nextAmortisationMonth).toBe('2025-05');
  });

  it('SC-3: nextAmortisationMonth handles month boundary correctly (Dec → Jan)', async () => {
    let capturedDoc: any = null;
    const createFn = vi.fn().mockImplementation(async ([doc]: any[]) => {
      capturedDoc = doc;
      return [{ ...doc }];
    });
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const voucherDate = new Date('2025-12-15');
    const bill = makeBill({
      voucherDate,
      lineItems: [{ isCapitalGoods: true, cgstPaise: 1000, sgstPaise: 1000, igstPaise: 0, itemName: 'M' }],
    });

    await svc.createScheduleForBill(bill as any);

    expect(capturedDoc.startMonth).toBe('2025-12');
    expect(capturedDoc.nextAmortisationMonth).toBe('2026-01');
  });

  it('SC-3: itcSplit=igst when igstPaise > 0 (inter-state)', async () => {
    let capturedDoc: any = null;
    const createFn = vi.fn().mockImplementation(async ([doc]: any[]) => {
      capturedDoc = doc;
      return [{ ...doc }];
    });
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const bill = makeBill({
      lineItems: [{ isCapitalGoods: true, cgstPaise: 0, sgstPaise: 0, igstPaise: 2000, itemName: 'Import Machine' }],
    });

    await svc.createScheduleForBill(bill as any);
    expect(capturedDoc.itcSplit).toBe('igst');
  });

  it('SC-3: itcSplit=cgst_sgst when igstPaise === 0 (intra-state)', async () => {
    let capturedDoc: any = null;
    const createFn = vi.fn().mockImplementation(async ([doc]: any[]) => {
      capturedDoc = doc;
      return [{ ...doc }];
    });
    const svc = new CapitalGoodsItcService({ create: createFn } as any);

    const bill = makeBill({
      lineItems: [{ isCapitalGoods: true, cgstPaise: 1000, sgstPaise: 1000, igstPaise: 0, itemName: 'Domestic Machine' }],
    });

    await svc.createScheduleForBill(bill as any);
    expect(capturedDoc.itcSplit).toBe('cgst_sgst');
  });
});

// ─── CapitalGoodsItcCron.amortiseCapitalGoodsItc ─────────────────────────────

describe('CapitalGoodsItcCron.amortiseCapitalGoodsItc', () => {
  it('SC-3: queries with status=amortising filter; skips completed schedules', async () => {
    const postReleaseFn = vi.fn().mockResolvedValue(undefined);
    // Model returns empty — simulates no matching amortising schedules
    const model = { find: vi.fn().mockResolvedValue([]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: postReleaseFn } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(model.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'amortising' }),
    );
    expect(postReleaseFn).not.toHaveBeenCalled();
  });

  it('SC-3: releases monthlyAmountPaise for non-last instalment', async () => {
    const schedule = makeSchedule({ monthsAmortised: 0, totalItcPaise: 6000, monthlyAmountPaise: 100 });
    const postReleaseFn = vi.fn().mockResolvedValue(undefined);
    const model = { find: vi.fn().mockResolvedValue([schedule]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: postReleaseFn } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(postReleaseFn).toHaveBeenCalledWith(
      schedule,
      100, // monthlyAmountPaise
      expect.objectContaining({ userId: 'cron' }),
    );
  });

  it('SC-3: 60th instalment = totalItcPaise - (59 * monthlyAmountPaise) — exact remainder, no rounding drift', async () => {
    const totalItcPaise = 6001; // odd to force rounding
    const monthlyAmountPaise = Math.round(totalItcPaise / 60); // 100
    const monthsAmortised = 59;
    const expectedLastRelease = totalItcPaise - monthsAmortised * monthlyAmountPaise;
    // 6001 - 59 * 100 = 6001 - 5900 = 101

    const schedule = makeSchedule({ totalItcPaise, monthlyAmountPaise, monthsAmortised, nextAmortisationMonth: '2025-05' });

    let capturedReleasePaise: number | null = null;
    const postReleaseFn = vi.fn().mockImplementation(async (_s: any, releasePaise: number) => {
      capturedReleasePaise = releasePaise;
    });
    const model = { find: vi.fn().mockResolvedValue([schedule]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: postReleaseFn } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(capturedReleasePaise).toBe(expectedLastRelease); // 101, not 100
    expect(capturedReleasePaise).not.toBe(monthlyAmountPaise);
  });

  it('SC-3: marks status=completed after 60th release', async () => {
    const schedule = makeSchedule({ totalItcPaise: 6000, monthlyAmountPaise: 100, monthsAmortised: 59, nextAmortisationMonth: '2025-05' });
    const model = { find: vi.fn().mockResolvedValue([schedule]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: vi.fn().mockResolvedValue(undefined) } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(schedule.status).toBe('completed');
    expect(schedule.save).toHaveBeenCalled();
  });

  it('SC-3: increments monthsAmortised by 1 after each release', async () => {
    const schedule = makeSchedule({ monthsAmortised: 5, nextAmortisationMonth: '2025-09' });
    const model = { find: vi.fn().mockResolvedValue([schedule]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: vi.fn().mockResolvedValue(undefined) } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(schedule.monthsAmortised).toBe(6);
  });

  it('SC-3: advances nextAmortisationMonth by 1 month in YYYY-MM format', async () => {
    const schedule = makeSchedule({ monthsAmortised: 5, nextAmortisationMonth: '2025-09' });
    const model = { find: vi.fn().mockResolvedValue([schedule]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: vi.fn().mockResolvedValue(undefined) } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(schedule.nextAmortisationMonth).toBe('2025-10');
  });

  it('SC-3: handles month boundary — Dec advances to Jan of next year', async () => {
    const schedule = makeSchedule({ monthsAmortised: 5, nextAmortisationMonth: '2025-12' });
    const model = { find: vi.fn().mockResolvedValue([schedule]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: vi.fn().mockResolvedValue(undefined) } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(schedule.nextAmortisationMonth).toBe('2026-01');
  });

  it('SC-3: posts LedgerEntry for each due schedule via ledgerPostingService', async () => {
    const schedule1 = makeSchedule({ nextAmortisationMonth: '2025-01' });
    const schedule2 = makeSchedule({ nextAmortisationMonth: '2025-02' });
    const postReleaseFn = vi.fn().mockResolvedValue(undefined);
    const model = { find: vi.fn().mockResolvedValue([schedule1, schedule2]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: postReleaseFn } as any);

    await cron.amortiseCapitalGoodsItc();

    expect(postReleaseFn).toHaveBeenCalledTimes(2);
  });

  it('SC-3: continues processing other schedules if one throws', async () => {
    const schedule1 = makeSchedule({ nextAmortisationMonth: '2025-01' });
    const schedule2 = makeSchedule({ nextAmortisationMonth: '2025-02' });

    let callCount = 0;
    const postReleaseFn = vi.fn().mockImplementation(async () => {
      if (callCount++ === 0) throw new Error('DB error');
    });
    const model = { find: vi.fn().mockResolvedValue([schedule1, schedule2]) };
    const cron = new CapitalGoodsItcCron(model as any, { postCapitalGoodsItcRelease: postReleaseFn } as any);

    // Should not throw — error is caught per-schedule
    await expect(cron.amortiseCapitalGoodsItc()).resolves.toBeUndefined();
    expect(postReleaseFn).toHaveBeenCalledTimes(2);
  });
});
