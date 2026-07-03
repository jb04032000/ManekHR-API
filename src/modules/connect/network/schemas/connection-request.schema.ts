import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect — `ConnectionRequest` collection (Phase 2 — Network).
 *
 * A person-to-person request to form a symmetric `Connection`. Distinct from
 * the ERP `WorkspaceMember` invite (a workspace team-member invitation) — a
 * Connect connection request is a professional-network edge, never merged with
 * the ERP invite domain (`docs/connect/phases/phase-2-network.md`).
 *
 * Lifecycle: `pending` → `accepted` (recipient accepts → a `Connection` row is
 * created) | `ignored` (recipient declines) | `withdrawn` (sender cancels).
 * The row is retained after a response so the Invitations · Archive tab and
 * the dedup guard can see history.
 *
 * Every `@Prop` carries an explicit `{ type }` — required by `@nestjs/mongoose`
 * and the repo's Vitest SWC transform so `SchemaFactory.createForClass`
 * resolves without `emitDecoratorMetadata`.
 */

/** `ConnectionRequest.status` lifecycle. */
export const CONNECTION_REQUEST_STATUSES = ['pending', 'accepted', 'ignored', 'withdrawn'] as const;
export type ConnectionRequestStatus = (typeof CONNECTION_REQUEST_STATUSES)[number];

@Schema({ timestamps: true, collection: 'connectconnectionrequests' })
export class ConnectionRequest extends Document {
  /** The `User` who sent the request. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  fromUserId: User | Types.ObjectId;

  /** The `User` who received it (and alone may accept / ignore it). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  toUserId: User | Types.ObjectId;

  /** Lifecycle state — see `CONNECTION_REQUEST_STATUSES`. */
  @Prop({ type: String, enum: CONNECTION_REQUEST_STATUSES, default: 'pending' })
  status: ConnectionRequestStatus;

  /** Optional short message the sender attached to the request. */
  @Prop({ type: String, trim: true, maxlength: 280, default: null })
  note?: string | null;

  /** When the recipient accepted / ignored, or the sender withdrew. */
  @Prop({ type: Date, default: null })
  respondedAt?: Date | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ConnectionRequestSchema = SchemaFactory.createForClass(ConnectionRequest);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Invitations · Received — a user's incoming requests by status, newest first.
ConnectionRequestSchema.index({ toUserId: 1, status: 1, createdAt: -1 });
// Invitations · Sent — a user's outgoing requests by status, newest first.
ConnectionRequestSchema.index({ fromUserId: 1, status: 1, createdAt: -1 });
// Dedup probe — find an existing request for a given ordered pair.
ConnectionRequestSchema.index({ fromUserId: 1, toUserId: 1, status: 1 });
