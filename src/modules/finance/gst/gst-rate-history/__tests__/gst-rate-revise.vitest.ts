/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

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

import { GstRateHistoryService } from '../gst-rate-history.service';

// D15: reviseRate end-dates the current open rate and inserts the new one (no overlap).
function makeService(current: any) {
  const Model: any = vi.fn(function (this: any, data: any) {
    Object.assign(this, data);
    this.save = vi.fn(() => Promise.resolve(this));
  });
  Model.findOne = vi.fn(() => ({ sort: () => Promise.resolve(current) }));
  // reviseRate now opens a transaction when no session is passed (D16 atomicity fix).
  Model.db = {
    startSession: vi.fn(() =>
      Promise.resolve({
        withTransaction: async (fn: () => Promise<void>) => {
          await fn();
        },
        endSession: vi.fn(() => Promise.resolve()),
      }),
    ),
  };
  return new GstRateHistoryService(Model);
}

describe('GstRateHistoryService.reviseRate (D15)', () => {
  it('end-dates the current rate the day before the new one and inserts the new open row', async () => {
    const current: any = {
      fromDate: new Date('2017-07-01'),
      toDate: undefined,
      description: 'cotton fabric',
      save: vi.fn(() => Promise.resolve()),
    };
    const svc = makeService(current);
    const created: any = await svc.reviseRate({
      hsnPrefix: '5208',
      fromDate: new Date('2025-09-22'),
      cgstRate: 2.5,
      sgstRate: 2.5,
      igstRate: 5,
      notification: 'Notif 9/2025-CT(Rate)',
    });

    // Current row closed the day before the new rate starts -> no overlap, no gap.
    expect(current.toDate).toEqual(new Date('2025-09-21'));
    expect(current.save).toHaveBeenCalledTimes(1);
    // New open-ended row carries the revised rate + inherits the description.
    expect(created.fromDate).toEqual(new Date('2025-09-22'));
    expect(created.toDate).toBeUndefined();
    expect(created.igstRate).toBe(5);
    expect(created.description).toBe('cotton fabric');
  });

  it('rejects a revision dated on or before the current rate start', async () => {
    const current: any = {
      fromDate: new Date('2017-07-01'),
      toDate: undefined,
      save: vi.fn(() => Promise.resolve()),
    };
    const svc = makeService(current);
    await expect(
      svc.reviseRate({
        hsnPrefix: '5208',
        fromDate: new Date('2016-01-01'),
        cgstRate: 2.5,
        sgstRate: 2.5,
        igstRate: 5,
      }),
    ).rejects.toThrow(/must be after/i);
    expect(current.save).not.toHaveBeenCalled();
  });

  it('inserts a first rate when none is currently open', async () => {
    const svc = makeService(null);
    const created: any = await svc.reviseRate({
      hsnPrefix: '9988',
      fromDate: new Date('2025-09-22'),
      cgstRate: 9,
      sgstRate: 9,
      igstRate: 18,
    });
    expect(created.fromDate).toEqual(new Date('2025-09-22'));
    expect(created.igstRate).toBe(18);
  });
});
