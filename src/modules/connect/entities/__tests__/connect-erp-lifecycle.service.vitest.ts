/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
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
import { ConnectErpLifecycleService } from '../connect-erp-lifecycle.service';

/**
 * Unit coverage for the `workspace.deleted` -> Connect ERP-link cascade
 * (ADR-0004 / 2026-06-18 spec). Verifies that every CompanyPage / Storefront
 * pointing at the deleted workspace gets its link cleared (erpWorkspaceId null,
 * erpLink revoked), audited with actor=system, and the owner notified.
 */

const WS = new Types.ObjectId();
const OWNER = new Types.ObjectId();

function makeModel(affected: any[]) {
  // updateOne(...).exec() — mirrors the real Mongoose query-builder the service uses.
  const updateOne = vi.fn(() => ({
    exec: async () => ({ matchedCount: 1, modifiedCount: 1 }),
  }));
  return {
    updateOne,
    find: vi.fn(() => ({
      select: () => ({ lean: () => ({ exec: async () => affected }) }),
    })),
  } as any;
}

function build(opts?: { pages?: any[]; stores?: any[] }) {
  const pageModel = makeModel(opts?.pages ?? []);
  const storefrontModel = makeModel(opts?.stores ?? []);
  const audit = { logEvent: vi.fn(async () => undefined) };
  const notifications = { dispatch: vi.fn(async () => ({})) };
  const svc = new ConnectErpLifecycleService(
    pageModel,
    storefrontModel,
    audit as any,
    notifications as any,
  );
  return { svc, pageModel, storefrontModel, audit, notifications };
}

describe('ConnectErpLifecycleService — workspace.deleted cascade (ADR-0004)', () => {
  it('clears the link + audits (system) + notifies the owner for each affected page', async () => {
    const page = {
      _id: new Types.ObjectId(),
      ownerUserId: OWNER,
      name: 'Zari Co',
      erpLink: { status: 'verified', linkedByUserId: OWNER },
    };
    const { svc, pageModel, audit, notifications } = build({ pages: [page] });

    await svc.handleWorkspaceDeleted({ workspaceId: String(WS), ownerId: String(OWNER) });

    // The dangling link is cleared (erpWorkspaceId null + erpLink revoked).
    expect(pageModel.updateOne).toHaveBeenCalledWith(
      { _id: page._id },
      expect.objectContaining({
        $set: expect.objectContaining({ erpWorkspaceId: null, 'erpLink.status': 'revoked' }),
      }),
    );
    // Audited with the system actor (all-zeros ObjectId) + workspace-deleted reason.
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'company_page_erp_unlinked',
        actorId: '000000000000000000000000',
        entityType: 'CompanyPage',
        meta: expect.objectContaining({ reason: 'workspace_deleted' }),
      }),
    );
    // Owner notified (involuntary badge loss).
    expect(notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: OWNER,
        category: 'connect.erp_badge_removed',
        actorId: null,
      }),
    );
  });

  it('also cascades to affected storefronts', async () => {
    const store = {
      _id: new Types.ObjectId(),
      ownerUserId: OWNER,
      name: 'Zari Shop',
      erpLink: { status: 'verified' },
    };
    const { svc, storefrontModel, audit, notifications } = build({ stores: [store] });

    await svc.handleWorkspaceDeleted({ workspaceId: String(WS), ownerId: String(OWNER) });

    expect(storefrontModel.updateOne).toHaveBeenCalled();
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'storefront_erp_unlinked',
        actorId: '000000000000000000000000',
      }),
    );
    expect(notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: OWNER, category: 'connect.erp_badge_removed' }),
    );
  });

  it('is a no-op when no entity points at the deleted workspace', async () => {
    const { svc, audit, notifications } = build();
    await svc.handleWorkspaceDeleted({ workspaceId: String(WS), ownerId: String(OWNER) });
    expect(audit.logEvent).not.toHaveBeenCalled();
    expect(notifications.dispatch).not.toHaveBeenCalled();
  });

  it('ignores an invalid / missing workspaceId without throwing', async () => {
    const { svc, pageModel } = build();
    await expect(
      svc.handleWorkspaceDeleted({ workspaceId: 'not-an-id', ownerId: String(OWNER) }),
    ).resolves.toBeUndefined();
    expect(pageModel.find).not.toHaveBeenCalled();
  });

  it('never throws into the workspace flow even when a notification fails', async () => {
    const page = {
      _id: new Types.ObjectId(),
      ownerUserId: OWNER,
      name: 'X',
      erpLink: { status: 'verified' },
    };
    const { svc, notifications, pageModel } = build({ pages: [page] });
    notifications.dispatch.mockRejectedValueOnce(new Error('bell down'));

    // Resolves (the per-entity error is swallowed + Sentry-captured).
    await expect(
      svc.handleWorkspaceDeleted({ workspaceId: String(WS), ownerId: String(OWNER) }),
    ).resolves.toBeUndefined();
    // The clear write still happened before the notify failed.
    expect(pageModel.updateOne).toHaveBeenCalled();
  });
});
