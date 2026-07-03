/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { FeedbackAdminService } from '../feedback-admin.service';

// Verifies the admin detail read decorates private attachment refs into signed
// URLs (sign once, resolve per ref). Links to: feedback-admin.service.ts.
describe('FeedbackAdminService.getOne — photo decoration', () => {
  let model: any;
  let audit: any;
  let privateMedia: any;
  let svc: FeedbackAdminService;
  const id = new Types.ObjectId().toHexString();

  beforeEach(() => {
    model = {
      findById: vi.fn().mockReturnValue({
        lean: () => ({
          exec: () =>
            Promise.resolve({
              _id: id,
              attachments: ['r2-private://erp-feedback-media/1-a.webp'],
              isDeleted: false,
            }),
        }),
      }),
    };
    audit = { logEvent: vi.fn() };
    privateMedia = {
      signMany: vi
        .fn()
        .mockResolvedValue(
          new Map([['r2-private://erp-feedback-media/1-a.webp', 'https://signed/a']]),
        ),
      resolve: vi
        .fn()
        .mockImplementation((ref: string, map: Map<string, string>) => map.get(ref) ?? ref),
    };
    svc = new FeedbackAdminService(model, audit, privateMedia);
  });

  it('returns signed URLs for attachments', async () => {
    const out = await svc.getOne(id);
    expect(out.attachments).toEqual(['https://signed/a']);
    expect(privateMedia.signMany).toHaveBeenCalledTimes(1);
  });

  it('throws NotFound for an invalid id', async () => {
    await expect(svc.getOne('not-an-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});
