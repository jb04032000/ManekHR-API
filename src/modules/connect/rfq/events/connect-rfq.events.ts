/**
 * Domain events emitted by the Connect RFQ module.
 *
 * `RfqService` fires {@link CONNECT_RFQ_CHANGED} whenever an RFQ's servability
 * changes — specifically when it leaves the `open` state (closed by the buyer,
 * or awarded on quote-accept). The RFQ-side mirror of `connect.listing.changed`
 * / `connect.job.changed`: a thin, fire-and-forget signal.
 *
 * Consumer (feed harden Bucket 2, CN-BOOST-1): `BoostService.stopForRfq` listens
 * with `@OnEvent` and stops (refund-completes) the RFQ's boost campaign once the
 * RFQ is no longer open, so a boosted RFQ stops winning auctions / burning its
 * reserve the moment it closes. With no listener registered the emit is a clean
 * no-op. Kept in its own file so a consumer imports the name + type without
 * pulling in `RfqService` (and its model graph), avoiding a module cycle.
 */

/** Event name — an RFQ was created or its status changed. */
export const CONNECT_RFQ_CHANGED = 'connect.rfq.changed';

/** How the RFQ changed — lets a listener decide (open vs closed/awarded). */
export type ConnectRfqChangeType = 'created' | 'updated' | 'closed';

export interface ConnectRfqChangedEvent {
  /** The RFQ that changed (stringified ObjectId). */
  rfqId: string;
  /** What happened to it. `closed` covers buyer-close AND award (both leave `open`). */
  change: ConnectRfqChangeType;
}
