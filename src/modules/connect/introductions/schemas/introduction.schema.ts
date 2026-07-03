import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../../users/schemas/user.schema';

/** The two roles an introduced party can hold in an introduction. */
export const INTRODUCTION_ROLES = ['buyer', 'seller'] as const;
export type IntroductionRole = (typeof INTRODUCTION_ROLES)[number];

/** Lifecycle of an introduction (anti-gaming heart of the feature). */
export const INTRODUCTION_STATUSES = ['pending', 'confirmed', 'declined'] as const;
export type IntroductionStatus = (typeof INTRODUCTION_STATUSES)[number];

/**
 * ManekHR Connect — `Introduction` collection (Broker Introductions slice).
 *
 * A broker introduces TWO users (a buyer + a seller). The introduction is
 * `pending` until BOTH introduced parties independently confirm, then
 * `confirmed` — the anti-gaming guard: a broker cannot fabricate a confirmed
 * introduction, both sides must actively agree.
 *
 * Like `Connection`, the introduced pair is symmetric for dedup purposes, so it
 * is stored ONCE as a CANONICAL ORDERED pair: `userLow` holds the
 * lexicographically-smaller `User` id, `userHigh` the larger. `roleOfLow` pins
 * the buyer/seller side to the low party (the high party's role is the
 * opposite). This lets a single `{ brokerUserId, userLow, userHigh }` unique
 * index dedup the introduction (no two-row mirroring, no duplicate race).
 * Copied from `connection.schema.ts`'s ordering technique + `sortedPair`.
 */
@Schema({ timestamps: true, collection: 'connect_introductions' })
export class Introduction extends Document {
  /** The broker who made the introduction. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  brokerUserId: User | Types.ObjectId;

  /** The lexicographically-smaller `User` id of the introduced pair. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userLow: User | Types.ObjectId;

  /** The lexicographically-larger `User` id of the introduced pair. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userHigh: User | Types.ObjectId;

  /** The low party's role. The high party holds the opposite role. */
  @Prop({ type: String, enum: INTRODUCTION_ROLES, required: true })
  roleOfLow: IntroductionRole;

  /** Optional broker note shown to both parties. */
  @Prop({ type: String, required: false, trim: true, maxlength: 500 })
  note?: string;

  /** Lifecycle. `pending` until both sides confirm; `declined` is soft-deleted. */
  @Prop({ type: String, enum: INTRODUCTION_STATUSES, required: true, default: 'pending' })
  status: IntroductionStatus;

  /** When the low party confirmed their side (null until they confirm). */
  @Prop({ type: Date, default: null })
  confirmedByLowAt?: Date | null;

  /** When the high party confirmed their side (null until they confirm). */
  @Prop({ type: Date, default: null })
  confirmedByHighAt?: Date | null;

  /** Soft-delete tombstone — set on decline (never hard-delete). */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  // `createdAt` / `updatedAt` are added by `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const IntroductionSchema = SchemaFactory.createForClass(Introduction);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// One canonical row per (broker, introduced pair) — dedups the introduction +
// is the backstop the service's E11000 catch relies on for the friendly conflict.
IntroductionSchema.index({ brokerUserId: 1, userLow: 1, userHigh: 1 }, { unique: true });
// "Introductions where I am the low party, by status" — backs the pending queue.
IntroductionSchema.index({ userLow: 1, status: 1 });
// "Introductions where I am the high party, by status" — same, other side.
IntroductionSchema.index({ userHigh: 1, status: 1 });
// The broker's auto contact book, filterable by status.
IntroductionSchema.index({ brokerUserId: 1, status: 1 });
