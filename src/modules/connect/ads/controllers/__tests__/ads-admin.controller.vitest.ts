/**
 * AdsAdminController -- TDD spec.
 *
 * Verifies that each route delegates to the correct AdsAdminService method
 * with the right arguments, and that the admin user id always comes from
 * req.user.sub (not from the request body).
 */

import { describe, it, expect, vi } from 'vitest';
import { AdsAdminController } from '../ads-admin.controller';
import type { AdminApproveDto } from '../../dto/admin-review.dto';
import type { AdminRejectDto } from '../../dto/admin-review.dto';
import type { AdminPlacementDto } from '../../dto/admin-placement.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(sub = 'admin-user-id-123') {
  return { user: { sub } };
}

function buildController() {
  const service = {
    listPending: vi.fn().mockResolvedValue([]),
    approve: vi
      .fn()
      .mockResolvedValue({ creativeId: 'cid', campaignId: 'camp', status: 'approved' }),
    reject: vi
      .fn()
      .mockResolvedValue({ creativeId: 'cid', campaignId: 'camp', status: 'rejected' }),
    listPlacements: vi.fn().mockResolvedValue([]),
    updatePlacement: vi
      .fn()
      .mockResolvedValue({ key: 'feed_promoted_post', floorCpm: 10, enabled: true }),
    getRevenue: vi.fn().mockResolvedValue({ revenue: 999 }),
  };

  const controller = new AdsAdminController(service as any);
  return { controller, service };
}

// ---------------------------------------------------------------------------
// GET /review
// ---------------------------------------------------------------------------

describe('AdsAdminController GET /review', () => {
  it('delegates to service.listPending()', async () => {
    const { controller, service } = buildController();
    service.listPending.mockResolvedValue([{ _id: 'x', reviewStatus: 'pending' }]);

    const result = await controller.listPending();

    expect(service.listPending).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /review/:id/approve
// ---------------------------------------------------------------------------

describe('AdsAdminController POST /review/:id/approve', () => {
  it('calls service.approve with creativeId from path and adminUserId from req.user.sub', async () => {
    const { controller, service } = buildController();
    const req = makeRequest('admin-abc');
    const dto: AdminApproveDto = { note: 'good ad' };

    await controller.approve('creative-id-1', req, dto);

    expect(service.approve).toHaveBeenCalledWith('creative-id-1', 'admin-abc', 'good ad');
  });

  it('passes undefined note when dto.note is absent', async () => {
    const { controller, service } = buildController();
    const req = makeRequest('admin-abc');
    const dto: AdminApproveDto = {};

    await controller.approve('creative-id-1', req, dto);

    expect(service.approve).toHaveBeenCalledWith('creative-id-1', 'admin-abc', undefined);
  });
});

// ---------------------------------------------------------------------------
// POST /review/:id/reject
// ---------------------------------------------------------------------------

describe('AdsAdminController POST /review/:id/reject', () => {
  it('calls service.reject with creativeId from path, adminUserId from req.user.sub, and reason from body', async () => {
    const { controller, service } = buildController();
    const req = makeRequest('admin-xyz');
    const dto: AdminRejectDto = { reason: 'policy violation' };

    await controller.reject('creative-id-2', req, dto);

    expect(service.reject).toHaveBeenCalledWith('creative-id-2', 'admin-xyz', 'policy violation');
  });
});

// ---------------------------------------------------------------------------
// GET /placements
// ---------------------------------------------------------------------------

describe('AdsAdminController GET /placements', () => {
  it('delegates to service.listPlacements()', async () => {
    const { controller, service } = buildController();
    service.listPlacements.mockResolvedValue([{ key: 'feed_promoted_post' }]);

    const result = await controller.listPlacements();

    expect(service.listPlacements).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PUT /placements/:key
// ---------------------------------------------------------------------------

describe('AdsAdminController PUT /placements/:key', () => {
  it('calls service.updatePlacement with key from path, dto, and adminUserId from req.user.sub', async () => {
    const { controller, service } = buildController();
    const req = makeRequest('admin-put');
    const dto: AdminPlacementDto = { floorCpm: 8, enabled: false };

    await controller.updatePlacement('rail_spotlight', dto, req);

    expect(service.updatePlacement).toHaveBeenCalledWith('rail_spotlight', dto, 'admin-put');
  });
});

// ---------------------------------------------------------------------------
// GET /revenue
// ---------------------------------------------------------------------------

describe('AdsAdminController GET /revenue', () => {
  it('delegates to service.getRevenue() and returns the result', async () => {
    const { controller, service } = buildController();
    service.getRevenue.mockResolvedValue({ revenue: 42000 });

    const result = await controller.getRevenue();

    expect(service.getRevenue).toHaveBeenCalledOnce();
    expect(result.revenue).toBe(42000);
  });
});

// ---------------------------------------------------------------------------
// Guard presence check
// ---------------------------------------------------------------------------

describe('AdsAdminController guard metadata', () => {
  it('has UseGuards metadata on the class with JwtAuthGuard and IsAdminGuard', () => {
    // Reflect metadata is set by @UseGuards decorator at class level.
    // We verify the guard constructors are registered.
    const guards: unknown[] = Reflect.getMetadata('__guards__', AdsAdminController) ?? [];

    // Guard names for readability
    const guardNames = guards.map((g) => (g as { name?: string }).name ?? String(g));
    expect(guardNames).toContain('JwtAuthGuard');
    expect(guardNames).toContain('IsAdminGuard');
  });
});
