import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateListingDto } from '../create-listing.dto';

/**
 * Validation contract for the create-listing payload's product-video field. The
 * service's media-ownership guard is unit-tested separately; here we pin the
 * DECLARATIVE rules the controller enforces before the service ever runs: at most
 * ONE video, and each clip url/posterUrl must be an https URL.
 */
async function errorPaths(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreateListingDto, {
    title: 'A product',
    category: 'weaving',
    ...payload,
  });
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

describe('CreateListingDto videos', () => {
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
 * Course-listing validation contract (Institutes Phase 1): `courseDetails` is
 * REQUIRED (with its core fields) only when `category === 'course'`, and IGNORED
 * for any other category.
 */
describe('CreateListingDto courseDetails (course category)', () => {
  async function paths(payload: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(CreateListingDto, { title: 'A product', ...payload });
    const errors = await validate(dto);
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

  it('accepts a course listing with full courseDetails', async () => {
    expect(
      await paths({
        category: 'course',
        courseDetails: {
          durationLabel: '6 weeks',
          batchStart: '2026-07-01T00:00:00.000Z',
          mode: 'offline',
          feeType: 'fixed',
          seats: 20,
          certificate: true,
          skillsTaught: ['digitising'],
        },
      }),
    ).toEqual([]);
  });

  it('requires courseDetails when category is course', async () => {
    expect(await paths({ category: 'course' })).toContain('courseDetails');
  });

  it('does not require courseDetails for a non-course category', async () => {
    expect(await paths({ category: 'weaving' })).toEqual([]);
  });

  it('rejects course courseDetails missing the required fields', async () => {
    const p = await paths({ category: 'course', courseDetails: { seats: 5 } });
    expect(p.some((x) => x.includes('durationLabel'))).toBe(true);
    expect(p.some((x) => x.includes('mode'))).toBe(true);
    expect(p.some((x) => x.includes('feeType'))).toBe(true);
  });
});

/**
 * Service-listing validation contract (Slice B1): `serviceDetails` is REQUIRED
 * (with its core fields `deliveryMode` + `pricingModel`) only when `category` is
 * one of the 8 NEW_SERVICE_CATEGORIES, and IGNORED for any other category —
 * including the pre-existing service-ish categories (`dyeing` etc.), which keep
 * their current optional behavior (no behavior change). Mirrors the course
 * `courseDetails` contract above.
 */
describe('CreateListingDto serviceDetails (service category)', () => {
  async function paths(payload: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(CreateListingDto, { title: 'A service', ...payload });
    const errors = await validate(dto);
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

  it('accepts a service listing with full serviceDetails', async () => {
    expect(
      await paths({
        category: 'consulting',
        serviceDetails: {
          deliveryMode: 'on-site',
          pricingModel: 'hourly',
          coverageArea: 'Surat + Ahmedabad',
          yearsExperience: 8,
          availability: 'Mon–Sat, 9am–7pm',
        },
      }),
    ).toEqual([]);
  });

  it('accepts a service listing with only the required core fields', async () => {
    expect(
      await paths({
        category: 'maintenance',
        serviceDetails: { deliveryMode: 'both', pricingModel: 'per-visit' },
      }),
    ).toEqual([]);
  });

  it('requires serviceDetails when category is a new service category', async () => {
    expect(await paths({ category: 'consulting' })).toContain('serviceDetails');
    expect(await paths({ category: 'maintenance' })).toContain('serviceDetails');
  });

  it('does not require serviceDetails for a non-service category (e.g. weaving)', async () => {
    expect(await paths({ category: 'weaving' })).toEqual([]);
  });

  it('does not require serviceDetails for a pre-existing service-ish category (dyeing) — no behavior change', async () => {
    expect(await paths({ category: 'dyeing' })).toEqual([]);
    expect(await paths({ category: 'job-work' })).toEqual([]);
  });

  it('rejects service serviceDetails missing the required core fields', async () => {
    const p = await paths({ category: 'machine-repair', serviceDetails: { yearsExperience: 3 } });
    expect(p.some((x) => x.includes('deliveryMode'))).toBe(true);
    expect(p.some((x) => x.includes('pricingModel'))).toBe(true);
  });

  it('rejects bad enum values for deliveryMode / pricingModel', async () => {
    const p = await paths({
      category: 'transport',
      serviceDetails: { deliveryMode: 'teleport', pricingModel: 'barter' },
    });
    expect(p.some((x) => x.includes('deliveryMode'))).toBe(true);
    expect(p.some((x) => x.includes('pricingModel'))).toBe(true);
  });
});
