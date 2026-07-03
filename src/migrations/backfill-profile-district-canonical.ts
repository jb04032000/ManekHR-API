import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import {
  lookupCanonicalDistrict,
  type CanonicalDistrict,
} from '../modules/connect/ads/geo/india-districts';

interface MigrationResult {
  scanned: number;
  canonicalized: number;
  stateSlugSet: number;
  skippedUnrecognized: number;
  skippedAlreadyCanonical: number;
  errors: string[];
}

/**
 * Migration 0045 (Connect boost region-targeting fix) — backfill canonical
 * districts onto existing `connectprofiles`.
 *
 * WHY: region (district) targeting used to require the viewer's free-text
 * `ConnectProfile.district` to EXACTLY match (normalized) a targeted district.
 * Going forward the matcher treats the canonical district NAME as source of truth
 * and keeps blank/unrecognized districts eligible (unknown-location fallback —
 * see modules/connect/ads/lib/targeting.ts). This unit rescues EXISTING data: for
 * any profile whose free-text `district` normalizes to exactly one recognized
 * canonical district (modules/connect/ads/geo/india-districts), it rewrites
 * `district` to the canonical NAME and stamps `geoDistrictSlug` (+ `geoStateSlug`
 * when the district name is unique across India). Unrecognized / blank districts
 * are LEFT UNCHANGED — the matcher's fallback already covers them, and we must
 * not fabricate a region for them.
 *
 * IDEMPOTENT: a second run finds the recognizable rows already canonical (name
 * unchanged + slug already set) and skips them; it never overwrites a non-empty
 * geoStateSlug/geoDistrictSlug that already differs (a deliberate user pick from
 * the new picker wins). Re-runnable safely.
 *
 * AMBIGUITY: a handful of district names collide across states in the ~2018
 * india-geo snapshot (e.g. "Bilaspur" in CG + HP). `lookupCanonicalDistrict`
 * returns `stateSlug: null` for those — we still canonicalize the NAME + district
 * slug (unambiguous) but DO NOT guess `geoStateSlug` (leave it as-is).
 *
 * Uses the raw Mongo connection + canonical collection name (`connectprofiles`,
 * mirrors PurgeOrphanConnectProfilesService) so the migrations module needs no
 * extra model wiring. Run via `npm run migrate` (ADR-0001 ledgered runner), unit
 * `0045_connect_backfill_profile_district_canonical`.
 *
 * Dependency note: reads + writes `connectprofiles`. Keep the india-districts
 * list (and its web india-geo source) in sync — a refresh changes which
 * free-text values are recognized.
 */
@Injectable()
export class BackfillProfileDistrictCanonicalService {
  private readonly logger = new Logger(BackfillProfileDistrictCanonicalService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private col(name: string) {
    const db = this.connection.db;
    if (!db) throw new Error('Mongo connection not ready');
    return db.collection(name);
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      scanned: 0,
      canonicalized: 0,
      stateSlugSet: 0,
      skippedUnrecognized: 0,
      skippedAlreadyCanonical: 0,
      errors: [],
    };

    try {
      // Only rows that actually have a free-text district are candidates; blank
      // districts are left to the matcher fallback (no row to rescue).
      const cursor = this.col('connectprofiles').find(
        { district: { $nin: [null, ''] } },
        { projection: { _id: 1, district: 1, geoDistrictSlug: 1, geoStateSlug: 1 } },
      );

      for await (const doc of cursor) {
        result.scanned++;
        const raw = typeof doc.district === 'string' ? doc.district : '';
        const canonical: CanonicalDistrict | null = lookupCanonicalDistrict(raw);

        if (!canonical) {
          // Not a recognized canonical district — leave it (fallback covers it).
          result.skippedUnrecognized++;
          continue;
        }

        const currentDistrict = raw;
        const currentDistrictSlug =
          typeof doc.geoDistrictSlug === 'string' ? doc.geoDistrictSlug : '';
        const currentStateSlug = typeof doc.geoStateSlug === 'string' ? doc.geoStateSlug : '';

        // Build the set update only for fields that actually need to change, so a
        // re-run that finds everything already canonical does ZERO writes.
        const set: Record<string, string> = {};
        if (currentDistrict !== canonical.name) {
          set['district'] = canonical.name;
        }
        if (!currentDistrictSlug) {
          // Only fill an EMPTY slug — never clobber a deliberate picker value.
          set['geoDistrictSlug'] = canonical.districtSlug;
        }
        // Set the state slug only when unambiguous AND currently empty.
        let willSetState = false;
        if (canonical.stateSlug && !currentStateSlug) {
          set['geoStateSlug'] = canonical.stateSlug;
          willSetState = true;
        }

        if (Object.keys(set).length === 0) {
          result.skippedAlreadyCanonical++;
          continue;
        }

        await this.col('connectprofiles').updateOne({ _id: doc._id }, { $set: set });
        result.canonicalized++;
        if (willSetState) result.stateSlugSet++;
      }

      this.logger.log(
        `Backfilled canonical district on connectprofiles: scanned=${result.scanned} ` +
          `canonicalized=${result.canonicalized} stateSlugSet=${result.stateSlugSet} ` +
          `skippedUnrecognized=${result.skippedUnrecognized} ` +
          `skippedAlreadyCanonical=${result.skippedAlreadyCanonical}`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to backfill canonical district: ${detail}`);
      result.errors.push(`backfill: ${detail}`);
    }

    return result;
  }
}
