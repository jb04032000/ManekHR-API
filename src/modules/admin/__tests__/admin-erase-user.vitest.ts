/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Admin erase endpoint: role gate, confirm guard, cross-workspace + complete-flow.
 *
 * Phase 7 — the endpoint now runs the COMPLETE erase via
 * AccountDeletionFinalizeService.eraseUserCompletely (Connect purge + identity
 * scrub with the admin as actor + vendor file delete), replacing the legacy
 * orphan-leaving permanent hard-delete. Tests:
 *  1. confirm false/omitted -> ERASURE_CONFIRM_REQUIRED, nothing runs.
 *  2. confirm=true -> delegates to eraseUserCompletely(targetId, actorId, reason).
 *  3. The controller adds no workspace filter — erasure is account-level.
 *
 * Links: admin.controller.ts (eraseUser), account-deletion-finalize.service.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { AdminController } from '../admin.controller';

describe('AdminController.eraseUser (confirm gate + complete admin erase)', () => {
  let finalizeService: any;
  let controller: AdminController;

  const actorId = 'admin-actor-id';
  const targetId = 'user-to-erase-id';

  beforeEach(() => {
    finalizeService = { eraseUserCompletely: vi.fn().mockResolvedValue(undefined) };

    // AdminController has many services injected; we only care about the erase
    // path (adminService, addOnsService, uploadsService, accountDeletionService,
    // accountDeletionFinalizeService).
    controller = new AdminController(
      {} as any, // adminService
      {} as any, // addOnsService
      {} as any, // uploadsService
      {} as any, // accountDeletionService
      finalizeService,
    );
  });

  // ── Confirm guard (irreversible action must not fire by accident) ──────────

  it('throws ERASURE_CONFIRM_REQUIRED (BadRequestException) when confirm is false', async () => {
    let caught: unknown;
    try {
      await controller.eraseUser(targetId, { confirm: false, reason: 'test' }, actorId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe('ERASURE_CONFIRM_REQUIRED');
    expect(finalizeService.eraseUserCompletely).not.toHaveBeenCalled();
  });

  it('throws ERASURE_CONFIRM_REQUIRED (BadRequestException) when confirm is undefined (omitted)', async () => {
    let caught: unknown;
    try {
      await controller.eraseUser(targetId, { confirm: undefined as any, reason: 'test' }, actorId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe('ERASURE_CONFIRM_REQUIRED');
    expect(finalizeService.eraseUserCompletely).not.toHaveBeenCalled();
  });

  // ── Happy path — confirm=true runs the complete erase ──────────────────────

  it('runs eraseUserCompletely(targetId, actorId, reason) when confirm=true', async () => {
    await controller.eraseUser(targetId, { confirm: true, reason: 'DPDP-ticket-99' }, actorId);

    expect(finalizeService.eraseUserCompletely).toHaveBeenCalledOnce();
    const [calledTarget, calledActor, calledReason] =
      finalizeService.eraseUserCompletely.mock.calls[0];
    expect(calledTarget).toBe(targetId);
    expect(calledActor).toBe(actorId);
    expect(calledReason).toBe('DPDP-ticket-99');
  });

  it('runs eraseUserCompletely without reason when reason is omitted', async () => {
    await controller.eraseUser(targetId, { confirm: true }, actorId);

    const [, , calledReason] = finalizeService.eraseUserCompletely.mock.calls[0];
    expect(calledReason).toBeUndefined();
  });

  // ── Cross-workspace safety: erasure is account-level (not workspace-scoped) ─
  it('passes targetId raw to the erase (no workspaceId filter added)', async () => {
    await controller.eraseUser('cross-ws-user-id', { confirm: true }, actorId);

    const [calledTarget] = finalizeService.eraseUserCompletely.mock.calls[0];
    expect(calledTarget).toBe('cross-ws-user-id');
  });
});
