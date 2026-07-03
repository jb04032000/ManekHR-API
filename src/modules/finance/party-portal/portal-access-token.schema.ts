import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * PortalAccessToken — per-party signed-URL tokens for the customer portal
 * (D-21, FIN-15-03).
 *
 * Stores ONLY the `jti` (JWT ID), never the raw JWT. Verification path:
 *   1. JWT signature + audience='party-portal' verified via portal JwtService
 *   2. lookup by jti — if missing → 401, if revokedAt is set → 410, if
 *      expiresAt < now → 401
 *
 * No compound unique on (wsId, partyId) per D-21 — multiple active tokens
 * allowed per party (different scopes / device-specific links). No TTL index
 * — revoked rows are kept for audit; cleanup is a separate cron concern.
 *
 * All ObjectId read filters consuming this schema MUST wrap with
 * `new Types.ObjectId(...)` per project Mongoose-9 autocast guard.
 */
@Schema({ timestamps: true, collection: 'portalaccesstokens' })
export class PortalAccessToken extends Document {
  @Prop({ type: String, required: true, unique: true, index: true })
  jti: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  wsId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  partyId: Types.ObjectId;

  // View-only portal (owner decision 2026-06-06, feedback_no_payments_in_billing):
  // 'pay' scope removed - this module does no payment collection.
  @Prop({
    type: [String],
    default: ['statement', 'invoices', 'receipts'],
  })
  scope: string[];

  @Prop({ type: Types.ObjectId, required: true })
  issuedBy: Types.ObjectId;

  @Prop({ type: Date, required: true })
  issuedAt: Date;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Date })
  lastAccessedAt?: Date;

  @Prop({ type: Number, default: 0 })
  accessCount: number;

  @Prop({ type: Date })
  revokedAt?: Date;

  @Prop({ type: Types.ObjectId })
  revokedBy?: Types.ObjectId;

  @Prop({ type: String })
  revokeReason?: string;
}

export const PortalAccessTokenSchema = SchemaFactory.createForClass(PortalAccessToken);

PortalAccessTokenSchema.index({
  wsId: 1,
  firmId: 1,
  partyId: 1,
  revokedAt: 1,
});
