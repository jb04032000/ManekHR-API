import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/**
 * ManekHR Connect — `Connection` collection (Phase 2 — Network).
 *
 * A symmetric, accepted connection between two `User`s. A connection is
 * undirected, so it is stored **once** as a CANONICAL ORDERED pair: `userA`
 * always holds the lexicographically-smaller `User` id, `userB` the larger.
 * `NetworkService` sorts the pair before every read and write. This lets a
 * single `{ userA, userB }` unique index dedup the edge (no two-row mirroring,
 * no race that creates a duplicate), and "my connections" is the union of
 * rows where `userA` OR `userB` is me.
 *
 * Created by `NetworkService.respondToRequest` when a recipient accepts a
 * `ConnectionRequest`. Mongo adjacency — no graph DB (`connect-build-plan.md`).
 */
@Schema({ timestamps: true, collection: 'connectconnections' })
export class Connection extends Document {
  /** The lexicographically-smaller `User` id of the connected pair. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userA: User | Types.ObjectId;

  /** The lexicographically-larger `User` id of the connected pair. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userB: User | Types.ObjectId;

  /** When the connection formed — the moment the request was accepted. */
  @Prop({ type: Date, required: true, default: () => new Date() })
  since: Date;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ConnectionSchema = SchemaFactory.createForClass(Connection);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// One canonical row per connected pair — dedups the symmetric edge.
ConnectionSchema.index({ userA: 1, userB: 1 }, { unique: true });
// "My connections" reverse lookup when the viewer is the larger id.
ConnectionSchema.index({ userB: 1 });
