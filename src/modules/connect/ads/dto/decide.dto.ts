import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** The creative kinds a caller may restrict the auction to (CN-ADS-8). */
const DECIDE_KINDS = [
  'promoted_post',
  'promoted_listing',
  'promoted_job',
  'promoted_open_to_work',
  'promoted_hiring',
  'promoted_rfq',
] as const;

/**
 * Body for `POST /connect/ads/decide` (internal / SSR call from the feed
 * renderer). Returns the winning ad placement for a given placement slot.
 */
export class DecideDto {
  /**
   * Identifies the feed slot where the ad will appear, e.g. `"feed_card_3"`.
   * Used to look up the placement config (floor CPM, enabled flag) and to
   * run the second-price auction.
   */
  @IsString()
  @IsNotEmpty()
  placementKey: string;

  /**
   * Opaque per-page-render id for cross-slot dedupe (fairness C5). When the
   * rail + grid + feed slots of one page render pass the SAME id, a campaign
   * that wins one slot is excluded from the others. Generated client/SSR-side
   * (a uuid); optional so single-slot callers can omit it. Bounded so it can
   * never be abused as an unbounded Redis key.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  pageRequestId?: string;

  /**
   * CN-ADS-8: restrict the auction to these creative kinds. The network page's
   * promoted-profile slot passes `['promoted_open_to_work','promoted_hiring']`
   * so a shared placement never returns a non-profile winner the page discards.
   * Omitted = every kind (unchanged default). Bounded + enum-validated.
   */
  @IsOptional()
  @IsArray()
  @IsIn(DECIDE_KINDS, { each: true })
  kinds?: Array<(typeof DECIDE_KINDS)[number]>;
}
