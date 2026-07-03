/* eslint-disable @typescript-eslint/no-explicit-any */
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

// Mutable env so each test controls whether a provider key is configured.
const h = vi.hoisted(() => ({ env: { surepass: { apiKey: '' as string, filingStub: false } } }));
vi.mock('../../../../config/env', () => ({ env: h.env }));

import { GstinService } from '../gstin.service';

const VALID_GSTIN = '27AAPFU0939F1ZV'; // check-digit-valid (per the validator)

function makeService(cached: any) {
  const surepass: any = {
    fetchByGstin: vi.fn(() =>
      Promise.resolve({
        legalName: 'ACME TEXTILES',
        state: 'Gujarat',
        stateCode: '24',
        status: 'active',
      }),
    ),
  };
  const cacheModel: any = {
    findOne: vi.fn(() => ({ lean: () => Promise.resolve(cached) })),
    updateOne: vi.fn(() => Promise.resolve({})),
  };
  return { svc: new GstinService(surepass, cacheModel), surepass, cacheModel };
}

describe('GstinService.lookup (D6 graceful fallback + cache)', () => {
  beforeEach(() => {
    h.env.surepass.apiKey = '';
  });

  it('no provider key -> returns null (manual entry), never calls the provider', async () => {
    const { svc, surepass } = makeService(null);
    const res = await svc.lookup(VALID_GSTIN);
    expect(res).toBeNull();
    expect(surepass.fetchByGstin).not.toHaveBeenCalled();
  });

  it('cache hit -> returns cached info, never calls the provider', async () => {
    const { svc, surepass } = makeService({ info: { legalName: 'CACHED CO', stateCode: '24' } });
    h.env.surepass.apiKey = 'KEY';
    const res = await svc.lookup(VALID_GSTIN);
    expect(res?.legalName).toBe('CACHED CO');
    expect(surepass.fetchByGstin).not.toHaveBeenCalled();
  });

  it('cache miss + key set -> calls provider once and caches the result', async () => {
    const { svc, surepass, cacheModel } = makeService(null);
    h.env.surepass.apiKey = 'KEY';
    const res = await svc.lookup(VALID_GSTIN);
    expect(res?.legalName).toBe('ACME TEXTILES');
    expect(surepass.fetchByGstin).toHaveBeenCalledTimes(1);
    expect(cacheModel.updateOne).toHaveBeenCalledTimes(1);
  });
});
