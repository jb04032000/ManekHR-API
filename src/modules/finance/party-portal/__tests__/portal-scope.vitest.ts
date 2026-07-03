/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators before importing the service so the
// transitive schema imports don't trip vitest's reflection pipeline. Models
// are injected as plain mocks.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}), forRoot: () => ({}) },
  };
});

import { ForbiddenException } from '@nestjs/common';
import { PortalPublicService } from '../portal-public.service';

const WS = '6a1ad9ddc71fb6465e645f16';
const FIRM = '6a1ad9ddc71fb6465e646051';
const PARTY = '6a1ad9ddc71fb6465e646052';

function ctx(scope: string[]) {
  return { jti: 'j', wsId: WS, firmId: FIRM, partyId: PARTY, scope };
}

function svc(models: Record<string, any> = {}): PortalPublicService {
  return new PortalPublicService(
    models.firm ?? {},
    models.party ?? {},
    models.ledger ?? {},
    models.invoice ?? {},
    models.receipt ?? {},
    models.partyLedger ?? {},
  );
}

describe('PortalPublicService — token scope enforcement (SEC-1 IDOR)', () => {
  it('rejects the statement read when the token scope omits "statement"', async () => {
    await expect(svc().getStatementForParty(ctx(['invoices']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects the invoices read when the token is statement-only', async () => {
    await expect(svc().getInvoicesForParty(ctx(['statement']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects the receipts read when the token omits "receipts"', async () => {
    await expect(svc().getReceiptsForParty(ctx(['statement', 'invoices']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects the aging read when the token omits "statement"', async () => {
    await expect(svc().getAgingForParty(ctx(['invoices']))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects an invoice-PDF ownership check before touching the DB when scope omits "invoices"', async () => {
    // invoice model is empty {} on purpose — the scope guard must throw first.
    await expect(
      svc().assertInvoiceBelongsToParty(ctx(['statement']), FIRM),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows the invoices read when the token includes "invoices"', async () => {
    const invoice = {
      find: () => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              select: () => ({ lean: () => Promise.resolve([{ voucherNumber: 'INV-1' }]) }),
            }),
          }),
        }),
      }),
      countDocuments: () => Promise.resolve(1),
    };
    const res = await svc({ invoice }).getInvoicesForParty(ctx(['invoices']), 1, 20);
    expect(res.total).toBe(1);
    expect(res.data).toHaveLength(1);
  });

  it('getContext returns the granted scope so the web shell can gate tabs', async () => {
    const firm = {
      findOne: () => ({
        lean: () => Promise.resolve({ firmName: 'Anant Group', brandProfile: {} }),
      }),
    };
    const party = { findOne: () => ({ lean: () => Promise.resolve({ name: 'Acme Mills' }) }) };
    const ledger = { aggregate: () => Promise.resolve([{ debit: 100, credit: 40 }]) };
    const payload = await svc({ firm, party, ledger }).getContext(ctx(['statement', 'invoices']));
    expect(payload.scope).toEqual(['statement', 'invoices']);
    expect(payload.outstanding).toBe(60);
    expect(payload.party.name).toBe('Acme Mills');
  });
});
