/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * Account-deletion Phase 7 — the processor cascade (DPDP s.8(7): "erase at the
 * processor", ACCOUNT-DELETION-AND-DPDP-PLAN.md §8).
 *
 * The Day-30 scrub (eraseAccount) already NULLs the User fields (profilePicture,
 * googleId, fcmToken). What it can NOT do is reach OUTSIDE the database: the
 * uploaded profile-photo OBJECT still sits in R2 storage. This service deletes
 * that object at the vendor and records, for the grievance trail, the disposition
 * of every other processor:
 *   - Google: we hold no revocable OAuth token (sign-in is googleId match only),
 *     so there is nothing to revoke at Google — documented no-op.
 *   - FCM device token: cleared by the scrub; an individual token is not
 *     "revoked" at the vendor, it simply stops being used — documented no-op.
 *   - Meili people index: already purged by the Connect content cascade (Phase 3,
 *     runs before the scrub) — documented, never double-purged.
 *   - Razorpay: customer PII is RETAINED under the billing/tax legal basis
 *     (Bucket B) — recorded, never deleted.
 *
 * Best-effort: a vendor failure never throws (the scrub has already committed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  Prop: () => () => undefined,
  Schema: () => () => undefined,
  SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  InjectModel: () => () => undefined,
  getModelToken: (name: string) => `${name}Model`,
  MongooseModule: { forFeature: () => ({}) },
}));

import { Types } from 'mongoose';
import { ProcessorErasureService } from '../processor-erasure.service';

describe('ProcessorErasureService (Phase 7 processor cascade, DPDP s.8(7))', () => {
  const userId = new Types.ObjectId().toString();
  let uploads: { deleteFile: ReturnType<typeof vi.fn> };
  let audit: { logEvent: ReturnType<typeof vi.fn> };
  let svc: ProcessorErasureService;

  beforeEach(() => {
    uploads = { deleteFile: vi.fn().mockResolvedValue(undefined) };
    audit = { logEvent: vi.fn().mockResolvedValue(undefined) };
    svc = new ProcessorErasureService(uploads as any, audit as any);
  });

  it('deletes the profile-photo object at storage when one is present', async () => {
    const summary = await svc.eraseAtProcessors(userId, {
      profilePicture: 'https://cdn.example/pp/abc.jpg',
    });
    expect(uploads.deleteFile).toHaveBeenCalledWith('https://cdn.example/pp/abc.jpg');
    expect(summary.profilePictureObjectDeleted).toBe(true);
    expect(summary.errors).toEqual([]);
  });

  it('skips object deletion when there is no profile picture (no vendor artifact to erase)', async () => {
    const summary = await svc.eraseAtProcessors(userId, { profilePicture: null });
    expect(uploads.deleteFile).not.toHaveBeenCalled();
    expect(summary.profilePictureObjectDeleted).toBe(false);
  });

  it('records the documented no-op / retained disposition of every other processor', async () => {
    const summary = await svc.eraseAtProcessors(userId, { profilePicture: null });
    expect(summary.googleGrant).toBe('no-revocable-token');
    expect(summary.fcmToken).toBe('cleared-at-scrub');
    expect(summary.meiliIndex).toBe('purged-by-connect-cascade');
    expect(summary.razorpay).toBe('retained-under-billing-basis');
  });

  it('audits the cascade with the per-processor summary (grievance trail)', async () => {
    await svc.eraseAtProcessors(userId, { profilePicture: 'https://cdn.example/pp/x.jpg' });
    const call = audit.logEvent.mock.calls.find(
      (c: any[]) => c[0].action === 'account_processor_erasure',
    );
    expect(call).toBeDefined();
    expect(call[0].entityId).toBe(userId);
    expect(call[0].actorId).toBe(userId);
    expect(call[0].meta.profilePictureObjectDeleted).toBe(true);
  });

  it('never throws when the storage delete fails — best-effort (scrub already committed)', async () => {
    uploads.deleteFile.mockRejectedValue(new Error('R2 unreachable'));
    const summary = await svc.eraseAtProcessors(userId, {
      profilePicture: 'https://cdn.example/pp/x.jpg',
    });
    expect(summary.profilePictureObjectDeleted).toBe(false);
    expect(summary.errors).toContain('profilePicture');
  });
});
