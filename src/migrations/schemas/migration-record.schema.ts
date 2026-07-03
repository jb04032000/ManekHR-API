import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Migration ledger (ADR-0001). One row per migration unit that has been run by
 * `MigrationRunnerService`. The ledger is the audit trail that lets the runner
 * skip already-applied work instantly instead of re-querying Mongo on every boot
 * (the old `OnModuleInit` seed/backfill pattern this replaces).
 *
 * Collection: `migrations`. See docs/architecture/adr/0001-migration-ledger.md.
 */
@Schema({ timestamps: true, collection: 'migrations' })
export class MigrationRecord extends Document {
  /** Stable migration id, e.g. `0001_connect_backfill_product_and_indexes`. */
  // Unique declared ONCE here (no separate schema.index()) — see Finding 5 /
  // the duplicate-index cleanup: declaring it both ways triggers a Mongoose
  // "Duplicate schema index" warning.
  @Prop({ type: String, required: true, unique: true })
  name: string;

  /** Seed-payload version for `convergent` units; null for `once` units. */
  @Prop({ type: String, default: null })
  checksum: string | null;

  /** Outcome of the last attempt. A `failed` row is re-attempted next run. */
  @Prop({ type: String, enum: ['applied', 'failed'], required: true })
  status: 'applied' | 'failed';

  @Prop({ type: Date, default: null })
  appliedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  durationMs: number;

  /** Error message on failure (no PII), else null. */
  @Prop({ type: String, default: null })
  error: string | null;

  /** Who applied it: `<host>@<gitSha|trigger>`, for cross-instance traceability. */
  @Prop({ type: String, default: null })
  runner: string | null;
}

export const MigrationRecordSchema = SchemaFactory.createForClass(MigrationRecord);
