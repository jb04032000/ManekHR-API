import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateConnectProfileDto } from '../update-connect-profile.dto';

/**
 * Validation contract for the profile update payload's intro-video field.
 * Mirrors the marketplace `create-listing.dto.vitest` video cases. The service's
 * media-ownership guard is unit-tested separately; here we pin the DECLARATIVE
 * rules the controller enforces before the service ever runs: at most ONE video,
 * and each clip url/posterUrl must be an https URL. The 60s length cap is NOT a
 * DTO rule - it lives in the upload probe (`connect-profile-video` policy).
 */
async function errorPaths(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateConnectProfileDto, payload);
  const errors = await validate(dto);
  // Flatten nested (videos -> children) error property paths for assertions.
  const out: string[] = [];
  const walk = (es: typeof errors, prefix = '') => {
    for (const e of es) {
      out.push(`${prefix}${e.property}`);
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errors);
  return out;
}

describe('UpdateConnectProfileDto videos', () => {
  it('accepts a single https video with an https poster', async () => {
    const paths = await errorPaths({
      videos: [
        {
          url: 'https://cdn.example.com/clip.mp4',
          posterUrl: 'https://cdn.example.com/poster.jpg',
        },
      ],
    });
    expect(paths).not.toContain('videos');
  });

  it('rejects two videos (cap is one)', async () => {
    const paths = await errorPaths({
      videos: [{ url: 'https://cdn.example.com/a.mp4' }, { url: 'https://cdn.example.com/b.mp4' }],
    });
    expect(paths).toContain('videos');
  });

  it('rejects a non-https video url', async () => {
    const paths = await errorPaths({ videos: [{ url: 'http://cdn/clip.mp4' }] });
    expect(paths).toContain('videos');
  });

  it('is valid when no videos are provided (optional)', async () => {
    const paths = await errorPaths({});
    expect(paths).toEqual([]);
  });
});

/**
 * Training credential validation contract (Institutes Phase 1). `instituteName`
 * is required; `companyPageId` (optional link) must be a Mongo id; the
 * certificate url must be https; the array is capped. Self-declared only - there
 * is no verified field on the DTO.
 */
describe('UpdateConnectProfileDto training[]', () => {
  it('accepts a self-declared training entry with an optional institute link', async () => {
    expect(
      await errorPaths({
        training: [
          {
            instituteName: 'Surat Stitch Academy',
            companyPageId: '60b0000000000000000000a1',
            course: 'Embroidery',
            completedAt: '2025-12-01T00:00:00.000Z',
            certificateUrl: 'https://cdn.example.com/cert.pdf',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('accepts a bare training entry (only instituteName)', async () => {
    expect(await errorPaths({ training: [{ instituteName: 'Self Taught Co' }] })).toEqual([]);
  });

  it('rejects a training entry missing instituteName', async () => {
    // @ValidateNested({ each: true }) reports the failing child with its array
    // index, so the path is `training.0.instituteName` (not `training.instituteName`).
    expect(await errorPaths({ training: [{ course: 'X' }] })).toContain('training.0.instituteName');
  });

  it('rejects a non-https certificate url', async () => {
    expect(
      await errorPaths({
        training: [{ instituteName: 'X', certificateUrl: 'http://cdn/cert.pdf' }],
      }),
    ).toContain('training.0.certificateUrl');
  });

  it('rejects a bad companyPageId', async () => {
    expect(
      await errorPaths({ training: [{ instituteName: 'X', companyPageId: 'not-an-id' }] }),
    ).toContain('training.0.companyPageId');
  });

  it('caps the training array at 30 entries', async () => {
    const many = Array.from({ length: 31 }, () => ({ instituteName: 'I' }));
    expect(await errorPaths({ training: many })).toContain('training');
  });

  // Institutes Phase 2 student-side guard: the DTO is the first line of defence
  // against a student forging an institute confirmation. It accepts the round-
  // tripped id + the opt-in, accepts only self|pending for confirmStatus, and
  // rejects confirmed|declined outright.
  it('accepts an id round-trip, self|pending confirmStatus, and the shareWithInstitute opt-in', async () => {
    expect(
      await errorPaths({
        training: [
          {
            id: '6a0a8f515ea9af111dd40999',
            instituteName: 'Surat Stitch Academy',
            companyPageId: '60b0000000000000000000a1',
            confirmStatus: 'pending',
            shareWithInstitute: true,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      await errorPaths({
        training: [{ instituteName: 'X', confirmStatus: 'self', shareWithInstitute: false }],
      }),
    ).toEqual([]);
  });

  it('rejects confirmStatus=confirmed on the student DTO (cannot self-confirm)', async () => {
    expect(
      await errorPaths({ training: [{ instituteName: 'X', confirmStatus: 'confirmed' }] }),
    ).toContain('training.0.confirmStatus');
  });

  it('rejects confirmStatus=declined on the student DTO', async () => {
    expect(
      await errorPaths({ training: [{ instituteName: 'X', confirmStatus: 'declined' }] }),
    ).toContain('training.0.confirmStatus');
  });

  it('rejects a non-boolean shareWithInstitute', async () => {
    expect(
      await errorPaths({
        training: [{ instituteName: 'X', shareWithInstitute: 'yes' as unknown as boolean }],
      }),
    ).toContain('training.0.shareWithInstitute');
  });
});

/**
 * Broker / dalal self-declaration (Broker badge, Slice 1). Optional boolean,
 * mirrors the other optional booleans on the DTO. `brokerSince` is deliberately
 * NOT a DTO field (the service stamps it), so only `isBroker` is validated here.
 */
describe('UpdateConnectProfileDto isBroker', () => {
  it('accepts a boolean isBroker', async () => {
    expect(await errorPaths({ isBroker: true })).toEqual([]);
  });

  it('rejects a non-boolean isBroker', async () => {
    expect(await errorPaths({ isBroker: 'yes' as unknown as boolean })).toContain('isBroker');
  });
});
