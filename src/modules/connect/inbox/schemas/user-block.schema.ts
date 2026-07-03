import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- a cross-thread user block (Phase 7 -- Inbox).
 *
 * A directed block: `blockerUserId` blocked `blockedUserId`. Because DMs are
 * OPEN, a block must apply across ALL threads with that person (and pre-empt
 * any future thread), so it lives in its own collection keyed on the pair,
 * not as a per-thread flag. The send / open paths consult it both ways: a send
 * is rejected if EITHER side blocked the other, and a blocked user gets no
 * presence / read signal and no retaliation notification.
 */
@Schema({ timestamps: true, collection: 'connect_user_blocks' })
export class UserBlock extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  blockerUserId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  blockedUserId: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export type UserBlockDocument = UserBlock & Document;
export const UserBlockSchema = SchemaFactory.createForClass(UserBlock);

// One row per directed pair (idempotent block).
UserBlockSchema.index({ blockerUserId: 1, blockedUserId: 1 }, { unique: true });
// Reverse lookup -- "who blocked me" / both-way check at send time.
UserBlockSchema.index({ blockedUserId: 1 });
