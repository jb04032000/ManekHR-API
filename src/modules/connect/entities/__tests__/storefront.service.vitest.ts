/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
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

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StorefrontService } from '../services/storefront.service';

const OWNER = '60c0000000000000000000a1';
const OTHER = '60c0000000000000000000a2';
const CP = '60c0000000000000000000d1';

function makeModel() {
  const created: any[] = [];
  let findByIdDoc: any = null;
  let findOneDoc: any = null;
  return {
    _created: created,
    setFindById: (d: any) => (findByIdDoc = d),
    setFindOne: (d: any) => (findOneDoc = d),
    countDocuments: vi.fn(async () => 0),
    exists: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, any>) => {
      const doc = {
        ...input,
        _id: `sf-${created.length + 1}`,
        save: vi.fn(() => Promise.resolve()),
      };
      created.push(doc);
      return doc;
    }),
    find: vi.fn(() => ({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) })),
    findById: vi.fn(async () => findByIdDoc),
    findOne: vi.fn(() => ({ lean: () => ({ exec: async () => findOneDoc }) })),
    updateMany: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  } as any;
}

function makeCompanyPageModel(ownerOfCp: string | null) {
  return {
    findById: vi.fn(() => ({
      select: () => ({
        lean: () => ({ exec: async () => (ownerOfCp ? { ownerUserId: ownerOfCp } : null) }),
      }),
    })),
  } as any;
}

function makeSvc(opts?: {
  allowThrows?: boolean;
  cpOwner?: string | null;
  wsOwner?: string | null;
}) {
  const model = makeModel();
  const companyPageModel = makeCompanyPageModel(opts?.cpOwner ?? OWNER);
  const allowances = {
    assertCanCreateStorefront: vi.fn(async () => {
      if (opts?.allowThrows) throw new ForbiddenException('cap');
    }),
  };
  const erpLink = {
    getWorkspaceStatus: vi.fn(async () => ({ linked: true, since: null })),
    // Consent gate (ADR-0004): unlinked unless the entity's erpLink is verified.
    getConsentedWorkspaceStatus: vi.fn(async (entity: any) =>
      entity?.erpLink?.status === 'verified' && entity?.erpWorkspaceId
        ? { linked: true, since: null }
        : { linked: false, since: null, signals: { attendance: 0, payrollRuns: 0, invoices: 0 } },
    ),
  };
  const audit = { logEvent: vi.fn(() => Promise.resolve()) };
  const posthog = { capture: vi.fn() };
  // Workspace model for the ownership-checked link path (ADR-0004).
  const wsOwner = opts?.wsOwner === undefined ? OWNER : opts.wsOwner;
  const workspaceModel: any = {
    findById: vi.fn(() => ({
      select: () => ({
        lean: () => ({ exec: async () => (wsOwner ? { ownerId: wsOwner } : null) }),
      }),
    })),
  };
  const svc = new StorefrontService(
    model,
    companyPageModel,
    allowances as any,
    erpLink as any,
    audit as any,
    posthog as any,
    // Media-ownership guard stub so create/update logo/banner checks no-op in unit tests.
    {
      assertOwnedMedia: () => Promise.resolve(),
      assertOwnedSingle: () => Promise.resolve(),
    } as any,
    undefined, // overLimit (optional)
    undefined, // events (optional)
    workspaceModel, // ADR-0004 ownership check for linkErpWorkspace
  );
  return { svc, model, companyPageModel, allowances, audit, posthog, workspaceModel };
}

describe('StorefrontService', () => {
  it('create: gates on the cap, derives a slug, persists, audits', async () => {
    const { svc, model, allowances, audit } = makeSvc();
    const doc = await svc.create(OWNER, { name: 'Rajesh Shop' });
    expect(allowances.assertCanCreateStorefront).toHaveBeenCalledWith(OWNER, 0);
    expect((doc as any).slug).toBe('rajesh-shop');
    expect(model.create).toHaveBeenCalled();
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storefront_created' }),
    );
  });

  it('create: propagates the storefront cap rejection', async () => {
    const { svc, model } = makeSvc({ allowThrows: true });
    await expect(svc.create(OWNER, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('create: links an owned company page', async () => {
    const { svc, companyPageModel } = makeSvc({ cpOwner: OWNER });
    await svc.create(OWNER, { name: 'Shop', companyPageId: CP });
    expect(companyPageModel.findById).toHaveBeenCalledWith(CP);
  });

  it('create: rejects linking a company page the caller does not own', async () => {
    const { svc, model } = makeSvc({ cpOwner: OTHER });
    await expect(svc.create(OWNER, { name: 'Shop', companyPageId: CP })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(model.create).not.toHaveBeenCalled();
  });

  it('getMine 404s for a non-owner', async () => {
    const { svc, model } = makeSvc();
    model.setFindById({ _id: 'sf-9', ownerUserId: OTHER });
    await expect(svc.getMine(OWNER, 'sf-9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPublicBySlug 404s a hidden shop to a non-owner', async () => {
    const { svc, model } = makeSvc();
    model.setFindOne({ _id: 'sf-1', ownerUserId: OWNER, visibility: 'hidden', slug: 'h' });
    await expect(svc.getPublicBySlug('h')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPublicBySlug returns the shop + linked:false without an ERP workspace', async () => {
    const { svc, model } = makeSvc();
    model.setFindOne({
      _id: 'sf-1',
      ownerUserId: OWNER,
      visibility: 'public',
      slug: 'p',
      erpWorkspaceId: null,
    });
    const res = await svc.getPublicBySlug('p');
    expect(res.storefront.slug).toBe('p');
    expect(res.erpLink).toEqual({ linked: false, since: null });
  });

  it('setPrimary clears isPrimary on all the owner shops then sets the target, audits, returns ok', async () => {
    const TARGET = '60c0000000000000000000f1';
    const { svc, model, audit } = makeSvc();
    model.setFindById({ _id: TARGET, ownerUserId: OWNER });

    const result = await svc.setPrimary(OWNER, TARGET);

    expect(result).toEqual({ ok: true });
    // Clear-all runs before the set, scoped to the owner.
    expect(model.updateMany).toHaveBeenCalledTimes(1);
    const clearFilter = model.updateMany.mock.calls[0][0];
    const clearUpdate = model.updateMany.mock.calls[0][1];
    expect(String(clearFilter.ownerUserId)).toBe(OWNER);
    expect(clearUpdate).toEqual({ $set: { isPrimary: false } });
    // Set the chosen one true, pinned by owner so it cannot touch another's shop.
    expect(model.updateOne).toHaveBeenCalledTimes(1);
    const setFilter = model.updateOne.mock.calls[0][0];
    const setUpdate = model.updateOne.mock.calls[0][1];
    expect(String(setFilter._id)).toBe(TARGET);
    expect(String(setFilter.ownerUserId)).toBe(OWNER);
    expect(setUpdate).toEqual({ $set: { isPrimary: true } });
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storefront_set_primary', entityId: TARGET }),
    );
  });

  it('setPrimary 404s for a non-owner and never writes', async () => {
    const { svc, model } = makeSvc();
    model.setFindById({ _id: 'sf-9', ownerUserId: OTHER });
    await expect(svc.setPrimary(OWNER, 'sf-9')).rejects.toBeInstanceOf(NotFoundException);
    expect(model.updateMany).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  // ── ERP link / unlink (consent + ownership-verified, ADR-0004) ─────────────
  const WS = '60c0000000000000000000e1';

  it('linkErpWorkspace: sets erpWorkspaceId + verified erpLink when caller owns the workspace', async () => {
    const { svc, model, audit, workspaceModel } = makeSvc({ wsOwner: OWNER });
    const doc = {
      _id: 'sf-1',
      ownerUserId: OWNER,
      erpWorkspaceId: null as any,
      erpLink: null as any,
      save: vi.fn(() => Promise.resolve()),
    };
    model.setFindById(doc);

    const res = await svc.linkErpWorkspace(OWNER, 'sf-1', WS);

    expect(workspaceModel.findById).toHaveBeenCalledWith(WS);
    expect(String(res.erpWorkspaceId)).toBe(WS);
    expect(res.erpLink).toMatchObject({ status: 'verified', consentVersion: 'erp-verify-v1' });
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storefront_erp_linked' }),
    );
  });

  it('linkErpWorkspace: throws ForbiddenException when caller does NOT own the workspace', async () => {
    const { svc, model } = makeSvc({ wsOwner: OTHER });
    const doc = { _id: 'sf-1', ownerUserId: OWNER, save: vi.fn(() => Promise.resolve()) };
    model.setFindById(doc);
    await expect(svc.linkErpWorkspace(OWNER, 'sf-1', WS)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('unlinkErpWorkspace: clears erpWorkspaceId + revokes the link, audits', async () => {
    const { svc, model, audit } = makeSvc();
    const doc = {
      _id: 'sf-1',
      ownerUserId: OWNER,
      erpWorkspaceId: WS as any,
      erpLink: { status: 'verified', consentVersion: 'erp-verify-v1' } as any,
      save: vi.fn(() => Promise.resolve()),
    };
    model.setFindById(doc);

    const res = await svc.unlinkErpWorkspace(OWNER, 'sf-1');

    expect(res.erpWorkspaceId).toBeNull();
    expect(res.erpLink.status).toBe('revoked');
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'storefront_erp_unlinked' }),
    );
  });

  it('create never sets erpWorkspaceId from the DTO (link only via linkErpWorkspace)', async () => {
    const { svc, model } = makeSvc();
    await svc.create(OWNER, { name: 'Shop', erpWorkspaceId: WS } as any);
    const created = model._created[0];
    expect(created.erpWorkspaceId).toBeNull();
    expect(created.erpLink).toBeNull();
  });
});
