import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Per-WORKSPACE member-cap EPISODE state. Mirrors `ConnectOverLimitState`
 * (docs/connect/2026-06-12-connect-over-limit-policy.md) but scoped to a
 * workspace instead of a (user, kind).
 *
 * This is the ONLY thing persisted by the ERP member-cap feature — the allowed
 * member set itself is ALWAYS computed at read time (drift-free) and never
 * stored. A delete / re-upgrade reverses the cap on the very next read because
 * the set is re-derived from live members + the current plan limit every time.
 *
 * `overCapSince` is the fair-warning grace clock: set the first time the
 * workspace is observed OVER its member limit, cleared the moment it returns
 * under (episode ends). `notifiedAt` guards the once-per-episode entry notice.
 *
 * Maintained idempotently (convergent upsert) by ErpMemberCapService —
 * lazily / nightly via `reconcileWorkspace` (so passive workspaces still get
 * the clock + notice on time).
 */
@Schema({ collection: 'erp_member_cap_states', timestamps: true })
export class ErpMemberCapState extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  /**
   * Start of the CURRENT over-cap episode (null when the workspace is at/under
   * its member limit). The cap only begins to apply at `overCapSince +
   * graceDays`. Resets to null when member count drops to/under the limit.
   */
  @Prop({ type: Date, default: null })
  overCapSince: Date | null;

  /**
   * When the once-per-episode "you are over the member cap" notification was
   * sent for the current episode. Null while no episode is active (or before
   * the notice fires). Cleared together with `overCapSince` when the episode
   * ends, so a later episode re-notifies exactly once.
   */
  @Prop({ type: Date, default: null })
  notifiedAt: Date | null;
}

export const ErpMemberCapStateSchema = SchemaFactory.createForClass(ErpMemberCapState);

// One episode row per workspace. Unique so the convergent upsert in
// ErpMemberCapService can never create duplicates under concurrency
// (a lazy reconcile + a worker cron can race).
ErpMemberCapStateSchema.index({ workspaceId: 1 }, { unique: true });
