/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migration 0045 (Connect boost region-targeting fix) — canonicalize existing
 * free-text `connectprofiles.district`. Verifies: a recognizable name is rewritten
 * to the canonical NAME + slugs are stamped; an unrecognized/blank value is left
 * as-is; a cross-state collision sets the district name+slug but NOT the state;
 * the unit is idempotent (already-canonical rows do zero writes) and never
 * clobbers a deliberate picker slug. Links: backfill-profile-district-canonical.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => ({
  InjectConnection: () => () => undefined,
}));

import { Types } from 'mongoose';
import { BackfillProfileDistrictCanonicalService } from '../backfill-profile-district-canonical';

/** A find() that yields the given docs via an async iterator (matches for-await). */
function makeFindCursor(docs: any[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          return i < docs.length
            ? Promise.resolve({ value: docs[i++], done: false })
            : Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function buildService(docs: any[]) {
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const find = vi.fn(() => makeFindCursor(docs));
  const col = { find, updateOne };
  const connection: any = { db: { collection: () => col } };
  return { svc: new BackfillProfileDistrictCanonicalService(connection), updateOne, find };
}

describe('BackfillProfileDistrictCanonicalService (migration 0045)', () => {
  it('canonicalizes a recognizable free-text district + stamps slugs (unique state)', async () => {
    const id = new Types.ObjectId();
    const { svc, updateOne } = buildService([
      { _id: id, district: 'surat', geoDistrictSlug: '', geoStateSlug: '' },
    ]);

    const result = await svc.run();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: id },
      { $set: { district: 'Surat', geoDistrictSlug: 'surat', geoStateSlug: 'gujarat' } },
    );
    expect(result.canonicalized).toBe(1);
    expect(result.stateSlugSet).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('canonicalizes a name across spacing differences ("east godavari")', async () => {
    const id = new Types.ObjectId();
    const { svc, updateOne } = buildService([
      { _id: id, district: 'east godavari', geoDistrictSlug: '', geoStateSlug: '' },
    ]);

    await svc.run();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: id },
      {
        $set: {
          district: 'East Godavari',
          geoDistrictSlug: 'east-godavari',
          geoStateSlug: 'andhra-pradesh',
        },
      },
    );
  });

  it('leaves an unrecognized free-text district unchanged', async () => {
    const id = new Types.ObjectId();
    const { svc, updateOne } = buildService([
      { _id: id, district: 'Some Unknown Place', geoDistrictSlug: '', geoStateSlug: '' },
    ]);

    const result = await svc.run();

    expect(updateOne).not.toHaveBeenCalled();
    expect(result.skippedUnrecognized).toBe(1);
    expect(result.canonicalized).toBe(0);
  });

  it('sets district name+slug but NOT state for a cross-state collision (ambiguous)', async () => {
    // "Bilaspur" is in both Chhattisgarh and Himachal Pradesh -> no state guess.
    // Lowercase input so the NAME also gets corrected (proves both fields).
    const id = new Types.ObjectId();
    const { svc, updateOne } = buildService([
      { _id: id, district: 'bilaspur', geoDistrictSlug: '', geoStateSlug: '' },
    ]);

    const result = await svc.run();

    expect(updateOne).toHaveBeenCalledWith(
      { _id: id },
      { $set: { district: 'Bilaspur', geoDistrictSlug: 'bilaspur' } },
    );
    expect(result.canonicalized).toBe(1);
    expect(result.stateSlugSet).toBe(0); // ambiguous -> state not set
  });

  it('is idempotent: an already-canonical row does zero writes', async () => {
    const id = new Types.ObjectId();
    const { svc, updateOne } = buildService([
      { _id: id, district: 'Surat', geoDistrictSlug: 'surat', geoStateSlug: 'gujarat' },
    ]);

    const result = await svc.run();

    expect(updateOne).not.toHaveBeenCalled();
    expect(result.skippedAlreadyCanonical).toBe(1);
    expect(result.canonicalized).toBe(0);
  });

  it('never clobbers a deliberate picker slug (only the NAME is corrected)', async () => {
    // Stale free-text NAME but the user already picked a (different) slug/state.
    // We only fix the display NAME; we do NOT overwrite the existing slugs.
    const id = new Types.ObjectId();
    const { svc, updateOne } = buildService([
      { _id: id, district: 'surat', geoDistrictSlug: 'rajkot', geoStateSlug: 'gujarat' },
    ]);

    await svc.run();

    expect(updateOne).toHaveBeenCalledWith({ _id: id }, { $set: { district: 'Surat' } });
  });

  it('no profiles with a district -> no writes', async () => {
    const { svc, updateOne } = buildService([]);

    const result = await svc.run();

    expect(updateOne).not.toHaveBeenCalled();
    expect(result.scanned).toBe(0);
  });
});
