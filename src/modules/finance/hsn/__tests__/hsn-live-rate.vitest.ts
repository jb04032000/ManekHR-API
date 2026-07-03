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

import { HsnService } from '../hsn.service';

// P0/D18: the finder must autofill the LIVE effective-dated rate (gst-rate-history), not the
// static seeded gstRate, so admin rate revisions reach it. Falls back to the stored rate when the
// prefix has no history row.
function makeSvc(getRateAsOf: (code: string) => Promise<{ igstRate: number } | null>) {
  const model: any = {};
  const gstRateHistory: any = { getRateAsOf: vi.fn((code: string) => getRateAsOf(code)) };
  const svc = new HsnService(model, gstRateHistory);
  (svc as any).cache = [
    { code: '5208', type: 'goods', description: 'Cotton fabric', synonyms: ['cotton'], gstRate: 5 },
    { code: '9988', type: 'service', description: 'Job work', synonyms: ['jobwork'], gstRate: 5 },
  ];
  return svc;
}

describe('HsnService.search live rate resolution', () => {
  it('overrides the static seeded rate with the live effective-dated rate', async () => {
    const svc = makeSvc((code) => Promise.resolve(code === '5208' ? { igstRate: 12 } : null));
    const res = await svc.search('5208');
    expect(res.find((r) => r.code === '5208')?.gstRate).toBe(12); // live, not the static 5
  });

  it('falls back to the stored rate when there is no history row', async () => {
    const svc = makeSvc(() => Promise.resolve(null));
    const res = await svc.search('cotton');
    expect(res.find((r) => r.code === '5208')?.gstRate).toBe(5); // stored fallback
  });
});
