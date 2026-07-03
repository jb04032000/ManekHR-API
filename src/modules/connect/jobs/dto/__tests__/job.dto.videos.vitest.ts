import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateJobDto, UpdateJobDto } from '../job.dto';

/**
 * Validation contract for the job payload's video field (the FIRST media field on
 * jobs). The service's media-ownership guard is unit-tested separately; here we
 * pin the DECLARATIVE rules the controller enforces before the service ever runs:
 * at most ONE video (`@ArrayMaxSize(1)`), and each clip url/posterUrl must be an
 * https URL. Copied from create-listing.dto's video spec. Cross-module link:
 * marketplace/dto/__tests__/create-listing.dto.vitest.ts.
 */
async function errorPaths(
  Dto: typeof CreateJobDto | typeof UpdateJobDto,
  payload: Record<string, unknown>,
): Promise<string[]> {
  // Create requires title + category; Update has neither required, so the base
  // fields are harmless on both.
  const dto = plainToInstance(Dto, {
    title: 'Zari operator',
    category: 'embroidery-zari',
    ...payload,
  });
  const errors = await validate(dto as object);
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

describe('CreateJobDto videos', () => {
  it('accepts a single https video with an https poster', async () => {
    const paths = await errorPaths(CreateJobDto, {
      videos: [
        {
          url: 'https://cdn.example.com/clip.mp4',
          posterUrl: 'https://cdn.example.com/poster.jpg',
        },
      ],
    });
    expect(paths).not.toContain('videos');
  });

  it('rejects two videos (cap is one) via @ArrayMaxSize(1)', async () => {
    const paths = await errorPaths(CreateJobDto, {
      videos: [{ url: 'https://cdn.example.com/a.mp4' }, { url: 'https://cdn.example.com/b.mp4' }],
    });
    expect(paths).toContain('videos');
  });

  it('rejects a non-https video url', async () => {
    const paths = await errorPaths(CreateJobDto, { videos: [{ url: 'http://cdn/clip.mp4' }] });
    expect(paths).toContain('videos');
  });

  it('is valid when no videos are provided (optional)', async () => {
    const paths = await errorPaths(CreateJobDto, {});
    expect(paths).not.toContain('videos');
  });
});

describe('UpdateJobDto videos', () => {
  it('accepts a single https video', async () => {
    const paths = await errorPaths(UpdateJobDto, {
      videos: [{ url: 'https://cdn.example.com/clip.mp4' }],
    });
    expect(paths).not.toContain('videos');
  });

  it('rejects two videos (cap is one) via @ArrayMaxSize(1)', async () => {
    const paths = await errorPaths(UpdateJobDto, {
      videos: [{ url: 'https://cdn.example.com/a.mp4' }, { url: 'https://cdn.example.com/b.mp4' }],
    });
    expect(paths).toContain('videos');
  });
});
