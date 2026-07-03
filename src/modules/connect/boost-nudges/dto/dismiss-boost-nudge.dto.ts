import { IsIn } from 'class-validator';
import type { BoostNudgeKind } from '../boost-nudge.types';

/**
 * Body for POST /me/connect/boost-nudges/:entityId/dismiss. The entity id is in
 * the path; the kind is needed to key the dismissal (the same id space is not
 * shared across kinds, so kind disambiguates). Mirrors the web dismiss action.
 */
export class DismissBoostNudgeDto {
  @IsIn(['listing', 'post', 'job'])
  kind: BoostNudgeKind;
}
