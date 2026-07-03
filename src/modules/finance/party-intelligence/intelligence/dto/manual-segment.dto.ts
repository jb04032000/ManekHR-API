/**
 * Phase 17 / FIN-16-01 D-07 — Manual segment override DTO.
 *
 * Body for POST /workspaces/:wsId/parties/:partyId/intelligence/manual-segment.
 *
 * BLACKLIST is intentionally excluded — clients must use POST /blacklist
 * (which carries reason metadata + audit fields). The segmenter clears the
 * manualSegment field after one cycle (D-07) except for BLACKLIST sticky.
 */
import { IsIn } from 'class-validator';

export const MANUAL_SEGMENT_VALUES = [
  'NEW',
  'REGULAR',
  'VIP',
  'DORMANT',
  'CHURNED',
] as const;
export type ManualSegmentValue = typeof MANUAL_SEGMENT_VALUES[number];

export class ManualSegmentDto {
  @IsIn(MANUAL_SEGMENT_VALUES as unknown as string[])
  segment!: ManualSegmentValue;
}
