/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing FirmsService so the
// transitive schema imports (firm.schema and friends) don't trip the
// "Cannot determine type" reflection error under vitest's esbuild transform.
// The Model is injected as a plain mock; real Mongoose is never used here.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}), forRoot: () => ({}) },
  };
});

import { FirmsService } from '../firms.service';

const WS = '6a1ad9ddc71fb6465e645f16';
const FIRM = '6a1ad9ddc71fb6465e646051';

// Build a service with a mock Model; other injected services are unused by the
// methods under test (updateWizardStep / getSetupChecklist only touch the model).
function makeService(model: any): FirmsService {
  return new FirmsService(model, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('FirmsService.updateWizardStep — per-step field whitelist', () => {
  it('step 2 persists address + contact and IGNORES unknown / credential / off-step keys', async () => {
    let captured: any;
    const model = {
      findOneAndUpdate: vi.fn((_q: any, update: any) => {
        captured = update;
        return { exec: () => Promise.resolve({ _id: FIRM }) };
      }),
    };
    await makeService(model).updateWizardStep(WS, FIRM, 2, {
      address: { line1: 'Plot 42', city: 'Surat', stateCode: '24' },
      contactPhone: '9876543210',
      contactEmail: 'a@b.com',
      website: 'https://x.in',
      aato: 100,
      inventoryValuationMethod: 'fifo',
      lateFeePct: 12,
      // The following MUST be dropped by the whitelist:
      firmName: 'HACKED', // a step-1 field, not allowed in step 2
      primaryRole: 'manager', // a step-3 field
      irpConfig: { encryptedApiKey: 'evil' }, // credential (mass-assignment attempt)
      isDeleted: true, // arbitrary firm field
    });

    const set = captured.$set;
    // allowed step-2 fields persist
    expect(set.address).toEqual({ line1: 'Plot 42', city: 'Surat', stateCode: '24' });
    expect(set.contactPhone).toBe('9876543210');
    expect(set.contactEmail).toBe('a@b.com');
    expect(set.website).toBe('https://x.in');
    expect(set.aato).toBe(100);
    expect(set.inventoryValuationMethod).toBe('fifo');
    expect(set.lateFeePct).toBe(12);
    // step flag set
    expect(set['setupChecklistState.step2Done']).toBe(true);
    // disallowed keys dropped
    expect(set.firmName).toBeUndefined();
    expect(set.primaryRole).toBeUndefined();
    expect(set.irpConfig).toBeUndefined();
    expect(set.isDeleted).toBeUndefined();
  });

  it('step 1 persists only identity fields (address / role are dropped)', async () => {
    let captured: any;
    const model = {
      findOneAndUpdate: vi.fn((_q: any, update: any) => {
        captured = update;
        return { exec: () => Promise.resolve({ _id: FIRM }) };
      }),
    };
    await makeService(model).updateWizardStep(WS, FIRM, 1, {
      firmName: 'Anant Group',
      businessType: 'trading',
      gstin: '24AABCR1234R1ZX',
      pan: 'AABCR1234R',
      accountsBooksBeginDate: '2025-04-01T00:00:00.000Z',
      address: { line1: 'should-not-save' },
      primaryRole: 'owner',
    });

    const set = captured.$set;
    expect(set.firmName).toBe('Anant Group');
    expect(set.businessType).toBe('trading');
    expect(set.gstin).toBe('24AABCR1234R1ZX');
    expect(set.pan).toBe('AABCR1234R');
    expect(set.accountsBooksBeginDate).toBe('2025-04-01T00:00:00.000Z');
    expect(set['setupChecklistState.step1Done']).toBe(true);
    // off-step fields dropped
    expect(set.address).toBeUndefined();
    expect(set.primaryRole).toBeUndefined();
  });

  it('skipped step (empty dto) still marks the step done', async () => {
    let captured: any;
    const model = {
      findOneAndUpdate: vi.fn((_q: any, update: any) => {
        captured = update;
        return { exec: () => Promise.resolve({ _id: FIRM }) };
      }),
    };
    await makeService(model).updateWizardStep(WS, FIRM, 3, {});
    expect(captured.$set['setupChecklistState.step3Done']).toBe(true);
    // nothing else written
    expect(Object.keys(captured.$set)).toEqual(['setupChecklistState.step3Done']);
  });
});

describe('FirmsService.getSetupChecklist — real done-checks + real routes', () => {
  function withFirm(firm: any) {
    return makeService({ findOne: vi.fn(() => ({ exec: () => Promise.resolve(firm) })) });
  }

  it('marks every item done from real firm state and links to live routes', async () => {
    const list = await withFirm({
      gstin: '24AABCR1234R1ZX',
      address: { line1: 'Plot 42' },
      brandProfile: { logoUrl: 'https://x/logo.png', bankAccountNumber: '00112233' },
    }).getSetupChecklist(WS, FIRM);

    const byKey = Object.fromEntries(list.map((i) => [i.key, i]));
    expect(byKey.tax_identity.done).toBe(true);
    expect(byKey.business_address.done).toBe(true);
    expect(byKey.brand_profile.done).toBe(true);
    expect(byKey.bank_details.done).toBe(true);

    // routes point at REAL pages, never the old dead `settings?tab=` links
    expect(byKey.business_address.route).toBe(`/dashboard/finance/firms/${FIRM}/settings/business`);
    expect(byKey.brand_profile.route).toBe(`/dashboard/finance/firms/${FIRM}/settings/branding`);
    list.forEach((i) => expect(i.route).not.toContain('settings?tab='));
  });

  it('marks items not-done when the underlying fields are missing', async () => {
    const list = await withFirm({ brandProfile: {} }).getSetupChecklist(WS, FIRM);
    const byKey = Object.fromEntries(list.map((i) => [i.key, i]));
    expect(byKey.tax_identity.done).toBe(false);
    expect(byKey.business_address.done).toBe(false);
    expect(byKey.brand_profile.done).toBe(false);
    expect(byKey.bank_details.done).toBe(false);
  });

  it('does not include the retired voucher-series / gstin-provider items', async () => {
    const list = await withFirm({ brandProfile: {} }).getSetupChecklist(WS, FIRM);
    const keys = list.map((i) => i.key);
    expect(keys).not.toContain('voucher_series');
    expect(keys).not.toContain('gstin_provider');
  });
});
