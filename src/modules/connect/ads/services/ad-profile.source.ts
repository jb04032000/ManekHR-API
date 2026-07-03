import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConnectProfile } from '../../profile/schemas/connect-profile.schema';
import { ErpLinkService } from '../../profile/erp-link.service';
import type { AdProfileSource } from './ad-profile.service';
import type { AdProfile } from '../lib/targeting';
import { targetingRegexes } from '../lib/targeting-normalize';
import type { TargetingMatchSpec } from '../lib/targeting';
import type { AudienceCounter } from './audience.service';
import { CANONICAL_DISTRICT_NAMES, lookupCanonicalDistrictBySlug } from '../geo/india-districts';

/**
 * Recognition regexes for EVERY canonical India district name, built once via the
 * SAME `targetingRegexes` helper the matcher uses. The audience counter uses
 * these in a `$nin` to include profiles whose district is NOT a recognized
 * canonical district (blank / free-text), mirroring the delivery matcher's
 * unknown-location fallback. Module-level so the ~700-entry array is built once,
 * not per estimate request.
 */
const CANONICAL_DISTRICT_REGEXES = targetingRegexes(CANONICAL_DISTRICT_NAMES);

// ---------------------------------------------------------------------------
// ConnectAdProfileSource
// ---------------------------------------------------------------------------

/**
 * Real implementation of `AdProfileSource` backed by the `ConnectProfile`
 * collection.
 *
 * Mapping strategy:
 *   role         - derived from `onboardingIntent` (the structured persona: karigar,
 *                  workshop_owner, buyer, explorer) then falls back to the first token
 *                  of `headline` when intent is null. This gives a clean enum-safe
 *                  role dim for the foundation; a richer NLP-derived role is a
 *                  deferred enrichment.
 *   skills       - ALL of the member's skill tags (ConnectProfile.skills),
 *                  normalised (trimmed + lowercased). Targeting matches on ANY
 *                  skill (previously skills[0] only, which under-counted vs the
 *                  audience counter). An explicit `industry` / `sector` field does
 *                  not exist on `ConnectProfile` yet; skills are the closest signal.
 *   district     - maps directly to `ConnectProfile.district` (the home textile hub,
 *                  e.g. "Surat", "Jetpur").
 *   companySize  - no clean source on `ConnectProfile` in Phase 1. Defaulted to ''
 *                  (empty string = "all sizes" - the targeting filter is a $in on a
 *                  non-empty array, so an empty profile dim is never excluded by an
 *                  empty companySizes spec). A future `ConnectProfile.companySize`
 *                  field or ERP-derived headcount range will populate this.
 *   connectionDegree - intentionally defaulted to 1 for all users. Real per-viewer
 *                  relative connection-degree (1st, 2nd, 3rd) is a viewer-advertiser
 *                  relationship and cannot be precomputed per-user at profile-build
 *                  time. Setting the default to 1 means that a rarely-used
 *                  `maxConnectionDegree: 1` filter on an AdSet will match EVERYONE
 *                  who has a profile, which is slightly over-broad but safe (no user
 *                  is wrongly EXCLUDED). The alternative default of Infinity would
 *                  correctly pass all filters but would fail TypeScript's `number`
 *                  type; 1 is the conservative safe sentinel. Deferred enrichment:
 *                  at decision time, enrich `connectionDegree` from the viewer's
 *                  network-degree graph relative to the advertiser before calling
 *                  matchesTargeting.
 *
 * ERP enrichment (optional, non-blocking):
 *   When the user has an active ERP-link (`ErpLinkService.getUserStatus` reports
 *   `linked: true`), `getErpSummary` is called to fetch their employer's karigar
 *   count. This is used as a company-size proxy in a future pass; wired here so
 *   the plumbing exists but the dim is still defaulted to '' until that mapping
 *   is specified. Errors from `ErpLinkService` are swallowed (the ERP-link badge
 *   is a trust enhancement, not a hard dependency).
 *
 * No-profile fallback:
 *   When the user has never completed Connect onboarding (no `ConnectProfile` row),
 *   returns an all-empty `AdProfile` with `connectionDegree: 1` so the decision
 *   engine can still serve broad-targeting ads rather than crashing.
 */
@Injectable()
export class ConnectAdProfileSource implements AdProfileSource {
  private readonly logger = new Logger(ConnectAdProfileSource.name);

  constructor(
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    private readonly erpLink: ErpLinkService,
  ) {}

  async buildFor(userId: string): Promise<AdProfile> {
    const empty: AdProfile = {
      role: '',
      skills: [],
      district: '',
      companySize: '',
      connectionDegree: 1,
    };

    let profile: ConnectProfile | null = null;
    try {
      profile = await this.profileModel.findOne({ userId }).lean<ConnectProfile>().exec();
    } catch (err) {
      this.logger.warn(
        `ConnectAdProfileSource: failed to load profile for user ${userId}: ${(err as Error).message}`,
      );
      return empty;
    }

    if (!profile) {
      return empty;
    }

    // role - prefer structured onboardingIntent, fall back to first word of headline
    let role = '';
    if (profile.onboardingIntent) {
      role = profile.onboardingIntent;
    } else if (profile.headline) {
      role =
        profile.headline
          .trim()
          // eslint-disable-next-line no-useless-escape
          .split(/[\s·,\-]+/)[0]
          ?.toLowerCase() ?? '';
    }

    // skills - ALL trade tags, normalised (trimmed + lowercased) so targeting
    // matches case-insensitively on ANY skill (keep in step with matchesTargeting
    // and the audience counter; normalisation lives in targeting-normalize).
    const skills = (profile.skills ?? [])
      .map((s) => (s ?? '').trim().toLowerCase())
      .filter(Boolean);

    // district - prefer the STRUCTURED canonical slug when the member picked a
    // State -> District in onboarding/profile-edit (geoDistrictSlug); resolve it
    // to the canonical NAME via the india-districts list so the matcher sees a
    // recognized district. Fall back to the free-text `district` (now canonical
    // going forward after the backfill migration; pre-backfill it may be free
    // text). Normalised (trimmed + lowercased) for case-insensitive targeting.
    // Safe: empty/unrecognized slug -> falls back to free text -> '' if also
    // empty; never throws. Keep in step with matchesTargeting + the counter.
    const bySlug = lookupCanonicalDistrictBySlug(profile.geoDistrictSlug);
    const district = (bySlug?.name ?? profile.district ?? '').trim().toLowerCase();

    // companySize - no source in Phase 1; defaulted to '' (broad match)
    // ERP enrichment attempt (non-blocking, future use)
    const companySize = '';
    try {
      // Optionally enrich from ERP when user is linked. No workspace needed -
      // ErpLinkService resolves context from active WorkspaceMember rows.
      // Currently only wires the plumbing; actual companySize derivation is deferred.
      void this.erpLink.getUserStatus(userId);
    } catch (err) {
      // Swallowed - ERP enrichment is a best-effort enhancement (currently a
      // no-op plumbing call). Debug-level so a failing ERP lookup is observable
      // without warn-spam on this per-decision hot path. No PII.
      this.logger.debug(
        `ERP profile enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      role,
      skills,
      district,
      companySize,
      // connectionDegree intentionally defaulted to 1 - see class-level doc.
      connectionDegree: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// ConnectAudienceCounter
// ---------------------------------------------------------------------------

/**
 * Real implementation of `AudienceCounter` backed by the `ConnectProfile`
 * collection.
 *
 * Builds a Mongo filter from the non-empty dims of the `TargetingMatchSpec`:
 *   roles       -> onboardingIntent $in [...]
 *   sectors     -> skills $in [/^v$/i ...] (case-insensitive; skills is an array,
 *                  so $in matches any doc with at least one matching skill)
 *   districts   -> district $in [/^v$/i ...] (case-insensitive)
 *
 * Only public profiles are counted (`visibility: 'public'`) to match what the
 * delivery engine actually serves to.
 *
 * Dims without a clean Phase 1 source (companySize, maxConnectionDegree) are
 * documented but not counted - they are accepted foundation simplifications.
 * An empty spec (all arrays empty, no maxConnectionDegree) counts all public
 * profiles, giving the "broad reach" estimate.
 */
@Injectable()
export class ConnectAudienceCounter implements AudienceCounter {
  constructor(
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
  ) {}

  async countMatching(spec: TargetingMatchSpec): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = {
      // Only count publicly reachable profiles (mirrors delivery scope).
      visibility: 'public',
    };

    if (spec.roles && spec.roles.length > 0) {
      filter['onboardingIntent'] = { $in: spec.roles };
    }

    if (spec.sectors && spec.sectors.length > 0) {
      // skills is an array; $in of case-insensitive anchored regexes matches any
      // element matching any selected sector (mirrors the delivery matcher so the
      // count == who is actually served). See targeting-normalize.
      filter['skills'] = { $in: targetingRegexes(spec.sectors) };
    }

    if (spec.districts && spec.districts.length > 0) {
      // Mirror matchesTargeting's district fallback so the reach estimate equals
      // who is actually served. A profile is reachable if EITHER:
      //   - its district matches one of the targeted districts (the local
      //     audience), OR
      //   - its district is NOT a recognized canonical district (blank or
      //     free-text "unknown location") — these are kept eligible, never
      //     excluded by region targeting (delivery down-ranks them later).
      // Profiles with a RECOGNIZED canonical district NOT in the target list are
      // the only ones excluded (confidently local elsewhere). The $nin of all
      // canonical-name regexes captures "not recognized" without per-doc
      // normalization. Keep in sync with lib/targeting.matchesTargeting.
      filter['$or'] = [
        { district: { $in: targetingRegexes(spec.districts) } },
        { district: { $nin: CANONICAL_DISTRICT_REGEXES } },
      ];
    }

    // companySizes / maxConnectionDegree: no clean Phase 1 source on ConnectProfile.
    // Counts treat these as unconstrained (all profiles pass). Deferred enrichment
    // when ConnectProfile gains companySize + network-degree data.

    return this.profileModel.countDocuments(filter).exec();
  }
}
