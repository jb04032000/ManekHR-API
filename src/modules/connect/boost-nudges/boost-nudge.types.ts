/**
 * ManekHR Connect -- shared types for the boost-nudge feature.
 *
 * What it does: the three boostable entity kinds and the candidate shape the
 * GET /me/connect/boost-nudges endpoint returns. Defined in a leaf file so the
 * schema, service, controller, and DTO can all import it without a cycle.
 *
 * Cross-module links: the web mirror is features/connect/boost-nudges.types.ts
 * (keep the field names in sync). `kind` mirrors the ads BoostSubject and the
 * backend campaign kind (boost_<kind>).
 */

/** The boostable entity kinds a traction nudge can target. */
export type BoostNudgeKind = 'listing' | 'post' | 'job';

/** All three kinds, stable order, for iteration. */
export const BOOST_NUDGE_KINDS: readonly BoostNudgeKind[] = ['listing', 'post', 'job'];

/** One nudge candidate -- a high-traction entity the owner can boost right now. */
export interface BoostNudgeCandidate {
  kind: BoostNudgeKind;
  /** The entity id (listing / post / job). */
  entityId: string;
  /** Human-readable name (listing/job title, or a post-body snippet). */
  name: string;
  /** Views in the trailing window (the traction signal). */
  viewsWindow: number;
  /** The window length the count covers (days). */
  windowDays: number;
}
