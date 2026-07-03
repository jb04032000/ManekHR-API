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

import { Types } from 'mongoose';
import { ReportCacheService } from '../report-cache.service';

// A versionModel mock whose stored version is bumped by updateOne ($inc) and read by findOne.
function makeService() {
  let version = 0;
  const versionModel: any = {
    findOne: vi.fn(() => ({ lean: () => Promise.resolve({ version }) })),
    updateOne: vi.fn(() => {
      version += 1;
      return Promise.resolve({});
    }),
  };
  return new ReportCacheService(versionModel);
}

describe('ReportCacheService', () => {
  const ws = new Types.ObjectId();
  const firm = new Types.ObjectId();

  it('computes once, then serves the cached value while the version is unchanged', async () => {
    const svc = makeService();
    let i = 0;
    const compute = vi.fn(() => Promise.resolve({ n: ++i }));
    const a = await svc.getOrCompute(ws, firm, 'k', compute);
    const b = await svc.getOrCompute(ws, firm, 'k', compute);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 }); // same cached value
    expect(compute).toHaveBeenCalledTimes(1); // not recomputed
  });

  it('recomputes after a posting bumps the version', async () => {
    const svc = makeService();
    let i = 0;
    const compute = vi.fn(() => Promise.resolve({ n: ++i }));
    const a = await svc.getOrCompute(ws, firm, 'k', compute);
    await svc.bumpVersion(ws, firm); // simulate a posting
    const b = await svc.getOrCompute(ws, firm, 'k', compute);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 2 }); // fresh compute after invalidation
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('caches different report keys independently', async () => {
    const svc = makeService();
    const c1 = vi.fn(() => Promise.resolve('A'));
    const c2 = vi.fn(() => Promise.resolve('B'));
    expect(await svc.getOrCompute(ws, firm, 'k1', c1)).toBe('A');
    expect(await svc.getOrCompute(ws, firm, 'k2', c2)).toBe('B');
    expect(await svc.getOrCompute(ws, firm, 'k1', c1)).toBe('A'); // cached
    expect(c1).toHaveBeenCalledTimes(1);
  });
});
