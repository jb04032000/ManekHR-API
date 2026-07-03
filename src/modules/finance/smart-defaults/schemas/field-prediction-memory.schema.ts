/**
 * Smart Defaults / Field Prediction — per-party last-used invoice settings.
 *
 * A tenant-scoped key/value memory that remembers the last value a party (or
 * party+item pair, or vendor) used for a given invoice field, so the web client
 * can pre-fill a new invoice form. Written best-effort by the sale-invoice post
 * flow (the orchestrator wires that call separately — see SmartDefaultsService
 * .rememberMany) and read by the smart-defaults GET endpoint.
 *
 * Storage model: one row per (workspaceId, firmId, scope, key, field). The
 * remembered value lands in `valueNum` (numeric fields like dueDays / ratePaise /
 * placeOfSupplyStateCode-as-number is NOT used — state code is a string) or
 * `valueStr` (string fields like placeOfSupplyStateCode / expenseCategory).
 *
 * Idempotency: a UNIQUE compound index on {workspaceId, firmId, scope, key,
 * field} lets the writer upsert the same logical slot repeatedly without
 * creating duplicates (last-write-wins via $set).
 *
 * Tenant isolation: every read/write filters by workspaceId + firmId. The
 * unique index leads with those two fields so cross-tenant rows can never
 * collide.
 *
 * ALL @Prop carry an explicit { type } per the repo Mongoose-autocast-safety
 * rule.
 *
 * Links to: SmartDefaultsService (read/write), sale-invoice.service (writer,
 * wired by the orchestrator), and the web new-invoice form (consumer of the
 * GET endpoint).
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/** Locked v1 scope enum. Adding a scope is a logical change (new read path). */
export const FIELD_PREDICTION_SCOPES = ['party', 'party_item', 'vendor'] as const;
export type FieldPredictionScope = (typeof FIELD_PREDICTION_SCOPES)[number];

@Schema({
  collection: 'fieldpredictionmemories',
  // Only updatedAt matters (last-write-wins memory); skip createdAt to keep
  // rows lean and the upsert $set small.
  timestamps: { createdAt: false, updatedAt: true },
})
export class FieldPredictionMemory extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  /** Scope of the remembered value — see FIELD_PREDICTION_SCOPES. */
  @Prop({ type: String, required: true, enum: FIELD_PREDICTION_SCOPES })
  scope: FieldPredictionScope;

  /**
   * Lookup key within the scope:
   *   - scope 'party'      → `${partyId}`
   *   - scope 'party_item' → `${partyId}:${itemId}`
   *   - scope 'vendor'     → `${vendorId}` (purchase-side, future consumer)
   */
  @Prop({ type: String, required: true })
  key: string;

  /**
   * Field name being remembered, e.g. 'dueDays', 'placeOfSupplyStateCode',
   * 'ratePaise', 'expenseCategory'. Combined with scope+key it identifies one
   * memory slot.
   */
  @Prop({ type: String, required: true })
  field: string;

  /** Numeric value slot (dueDays, ratePaise, ...). Optional. */
  @Prop({ type: Number })
  valueNum?: number;

  /** String value slot (placeOfSupplyStateCode, expenseCategory, ...). Optional. */
  @Prop({ type: String })
  valueStr?: string;

  /** Maintained by timestamps option above; declared here for typing only. */
  updatedAt?: Date;
}

export const FieldPredictionMemorySchema = SchemaFactory.createForClass(FieldPredictionMemory);

// Idempotent-upsert key: one row per logical memory slot, tenant-scoped.
// Leads with workspaceId + firmId so the index also serves the getForParty
// read path (workspaceId + firmId + scope + key-prefix scans).
FieldPredictionMemorySchema.index(
  { workspaceId: 1, firmId: 1, scope: 1, key: 1, field: 1 },
  { unique: true },
);
