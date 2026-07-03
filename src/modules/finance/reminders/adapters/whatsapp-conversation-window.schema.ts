import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Wave 8 — WhatsApp 24h conversation window tracking.
 *
 * Per Meta 2023+ pricing, 1 conversation = 24h window of unlimited messages
 * to the same peer. We mirror this:
 *   - First message to a peer in 24h → opens window + consumes 1 credit.
 *   - Subsequent messages within window → 0 credit, log links to existing window.
 *   - After expiresAt → next send opens a fresh window + consumes 1 credit.
 *
 * Sparse partial index on `(workspaceId, peerPhone)` where `expiresAt > now`
 * is enforced via app-side check (Mongo can't do "where now()" in indexes).
 */
@Schema({ timestamps: true, collection: 'whatsappconversationwindows' })
export class WhatsappConversationWindow extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  /** Peer phone in E.164-ish form (digits only including country code). */
  @Prop({ required: true, index: true })
  peerPhone: string;

  /**
   * Conversation category — Meta billing axis. We only ship 'utility' today;
   * 'authentication' / 'marketing' added in Wave 9+.
   */
  @Prop({
    enum: ['utility', 'authentication', 'marketing', 'service'],
    default: 'utility',
  })
  category: string;

  @Prop({ required: true, default: () => new Date() })
  openedAt: Date;

  /** openedAt + 24h. Sender treats `now < expiresAt` as "still inside window". */
  @Prop({ required: true })
  expiresAt: Date;

  /** AiSensy / Meta WAMID, when available. Ops trail. */
  @Prop()
  conversationId?: string;
}

export const WhatsappConversationWindowSchema = SchemaFactory.createForClass(
  WhatsappConversationWindow,
);

// Hot lookup: open window for (workspace, peer).
WhatsappConversationWindowSchema.index({
  workspaceId: 1,
  peerPhone: 1,
  expiresAt: -1,
});

// TTL on expiresAt — Mongo auto-purges after expiry. expireAfterSeconds=0
// honours the document's own `expiresAt` field as the deletion cutoff.
WhatsappConversationWindowSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);
