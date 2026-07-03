import { normTargetingList, normTargetingValue } from './targeting-normalize';
import { isRecognizedDistrict } from '../geo/india-districts';

export interface AdProfile {
  role: string;
  /**
   * ALL of the member's trade/skill tags, normalised (trimmed + lowercased).
   * Targeting matches if ANY selected sector is among these - mirroring the
   * audience counter's any-skill `$in`, so the estimate and delivery agree.
   * (Was a single `sector` = skills[0], which under-counted vs the counter.)
   */
  skills: string[];
  /** Member home district, normalised (trimmed + lowercased). */
  district: string;
  companySize: string;
  connectionDegree: number;
}

export interface TargetingMatchSpec {
  roles: string[];
  sectors: string[];
  districts: string[];
  companySizes: string[];
  maxConnectionDegree?: number;
}

/**
 * Delivery-time targeting check. Every string dimension is compared
 * case-insensitively (both sides normalised via targeting-normalize) so the
 * web's display-case values ("Weaving", "Surat") match the lowercased profile
 * data, AND so this agrees with ConnectAudienceCounter (the estimate). An empty
 * spec dimension means "no constraint" on that dimension.
 */
export function matchesTargeting(spec: TargetingMatchSpec, profile: AdProfile): boolean {
  if (spec.roles.length > 0) {
    const want = normTargetingList(spec.roles);
    if (!want.includes(normTargetingValue(profile.role))) return false;
  }
  if (spec.sectors.length > 0) {
    // Any-skill match: the member qualifies if any of their skill tags is one of
    // the selected sectors (mirrors the counter's skills $in).
    const want = normTargetingList(spec.sectors);
    const have = profile.skills.map(normTargetingValue);
    if (!want.some((w) => have.includes(w))) return false;
  }
  if (spec.districts.length > 0) {
    // Region (district) rule — three cases, fallback-friendly so a region boost
    // does NOT silently exclude almost everyone (onboarding rarely captured a
    // district, so most profiles are blank or free-text). EXCLUDE only when we
    // are CONFIDENT the viewer is elsewhere:
    //   1. Viewer has a RECOGNIZED canonical district (matches the india-districts
    //      list) AND it is NOT in the target list  -> EXCLUDE (confidently local
    //      to a different region).
    //   2. Viewer has a recognized canonical district that IS in the target list
    //      -> MATCH.
    //   3. Viewer district is EMPTY or NOT a recognized canonical district
    //      (unknown location) -> DO NOT exclude (still eligible; the decision
    //      service down-ranks this fallback match so confidently-local viewers
    //      are preferred — see isUnknownLocationDistrictMatch).
    // Normalization is via targeting-normalize (lowercase + strip non-alnum),
    // matching how india-districts builds its recognition tokens.
    const want = normTargetingList(spec.districts);
    const have = normTargetingValue(profile.district);
    if (isRecognizedDistrict(profile.district) && !want.includes(have)) {
      return false;
    }
    // Empty / unrecognized district falls through (unknown-location fallback).
  }
  if (spec.companySizes.length > 0) {
    const want = normTargetingList(spec.companySizes);
    if (!want.includes(normTargetingValue(profile.companySize))) return false;
  }
  if (spec.maxConnectionDegree != null && profile.connectionDegree > spec.maxConnectionDegree)
    return false;
  return true;
}

/**
 * Did this profile clear a DISTRICT-targeted spec ONLY via the unknown-location
 * fallback (case 3 above)? True when the boost targets districts AND the viewer's
 * district is empty or NOT a recognized canonical district. Used by
 * `ad-decision.service.ts` to modestly down-rank such matches so a confidently-
 * local viewer (recognized district in the target list) is preferred for the
 * slot. Returns false when the spec has no district constraint (nothing to
 * down-rank) or when the viewer has a recognized district (a confident match,
 * not a fallback). Callers should only consult this AFTER matchesTargeting()
 * returned true.
 */
export function isUnknownLocationDistrictMatch(
  spec: TargetingMatchSpec,
  profile: AdProfile,
): boolean {
  if (!spec.districts || spec.districts.length === 0) return false;
  return !isRecognizedDistrict(profile.district);
}
