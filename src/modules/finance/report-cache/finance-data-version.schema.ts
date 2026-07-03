import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FinanceDataVersionDocument = HydratedDocument<FinanceDataVersion>;

/**
 * D17 report cache invalidation key. One row per firm holding a monotonically-increasing version
 * that is bumped on every ledger posting (via the LedgerEntry post-save hook). The ReportCache
 * keys cached report results by this version, so any posting transparently invalidates them - the
 * next read recomputes from the live aggregation (the source of truth) and re-caches. This makes
 * caching correct-by-construction: a stale result is impossible because its key no longer matches.
 */
@Schema({ collection: 'financedataversions' })
export class FinanceDataVersion {
  @Prop({ type: Types.ObjectId, required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Number, required: true, default: 0 })
  version: number;
}

export const FinanceDataVersionSchema = SchemaFactory.createForClass(FinanceDataVersion);

FinanceDataVersionSchema.index({ workspaceId: 1, firmId: 1 }, { unique: true });
