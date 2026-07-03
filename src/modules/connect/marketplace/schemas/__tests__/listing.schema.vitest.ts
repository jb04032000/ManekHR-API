import { describe, it, expect } from 'vitest';
import {
  ListingSchema,
  LISTING_CATEGORIES,
  NEW_SERVICE_CATEGORIES,
  SERVICE_CATEGORIES,
} from '../listing.schema';

describe('Listing schema tags', () => {
  it('declares a tags string array', () => {
    const path = ListingSchema.path('tags');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Array');
  });
});

describe('Listing schema videos', () => {
  it('declares a videos array of {url, posterUrl?, durationSec?} subdocs', () => {
    const path = ListingSchema.path('videos');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Array');
    // The embedded sub-schema carries the feed-symmetric video fields.
    const sub = path.schema;
    expect(sub).toBeDefined();
    expect(Object.keys(sub.paths)).toEqual(
      expect.arrayContaining(['url', 'posterUrl', 'durationSec']),
    );
  });
});

/**
 * Service listings (Slice B1) — mirrors the courseDetails contract: an optional
 * `serviceDetails` sub-object (default null) + the 8 new service category slugs.
 */
describe('Listing schema serviceDetails', () => {
  it('declares an optional serviceDetails subdoc defaulting to null', () => {
    const path = ListingSchema.path('serviceDetails');
    expect(path).toBeDefined();
    // An embedded single nested sub-schema (like courseDetails).
    expect(path.instance).toBe('Embedded');
    // Default is null (additive — a non-service listing leaves it unset).
    expect(path.getDefault()).toBeNull();
    const sub = (path as unknown as { schema: { paths: Record<string, unknown> } }).schema;
    expect(Object.keys(sub.paths)).toEqual(
      expect.arrayContaining([
        'deliveryMode',
        'pricingModel',
        'coverageArea',
        'yearsExperience',
        'availability',
      ]),
    );
  });

  it('exposes the 8 new service categories in LISTING_CATEGORIES', () => {
    const expected = [
      'consulting',
      'maintenance',
      'machine-repair',
      'testing',
      'installation',
      'transport',
      'logistics',
      'contractor',
    ];
    expect(NEW_SERVICE_CATEGORIES).toEqual(expected);
    expect([...LISTING_CATEGORIES]).toEqual(expect.arrayContaining(expected));
  });

  it('SERVICE_CATEGORIES is the 8 new ones PLUS the pre-existing service-ish set', () => {
    expect([...SERVICE_CATEGORIES]).toEqual(
      expect.arrayContaining([
        ...NEW_SERVICE_CATEGORIES,
        'job-work',
        'dyeing',
        'printing',
        'embroidery-zari',
      ]),
    );
  });
});
