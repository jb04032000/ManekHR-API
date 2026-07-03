/**
 * Pure decision logic for the legacy private-media migration
 * (`scripts/migrate-private-media.ts`). Kept here (not in the script) so it is
 * importable + unit-testable without a DB or a live S3 client.
 *
 * The migration walks the public objects that legacy chat + job-application
 * rows still point at and moves them to the private bucket, rewriting the DB
 * reference to a canonical `r2-private://<key>` ref. This function decides, for
 * ONE stored value, what the migrator should do - so the idempotency +
 * already-migrated + not-ours rules are testable in isolation.
 */
import { isPrivateRef, toPrivateRef } from './private-media.ref';

export type MigrationAction = 'migrate' | 'skip-already-private' | 'skip-empty' | 'skip-foreign';

export interface MigrationDecision {
  action: MigrationAction;
  /** Object key to copy public -> private (only when action === 'migrate'). */
  objectKey?: string;
  /** Canonical ref to write back to the DB (only when action === 'migrate'). */
  newRef?: string;
}

export interface DecideOptions {
  /** The public base URL legacy objects were served from (storage.r2.publicUrl). */
  publicBaseUrl: string;
}

/**
 * Decide what to do with one stored media value.
 *  - empty / null            -> skip-empty
 *  - already `r2-private://`  -> skip-already-private (idempotent / resumable)
 *  - a public URL on our base -> migrate (derive the object key + new ref)
 *  - anything else (offsite)  -> skip-foreign (never touch a URL that isn't ours)
 */
export function decidePrivateMediaMigration(
  value: string | null | undefined,
  options: DecideOptions,
): MigrationDecision {
  if (!value) return { action: 'skip-empty' };
  if (isPrivateRef(value)) return { action: 'skip-already-private' };

  const base = (options.publicBaseUrl || '').replace(/\/$/, '');
  if (!base || !value.startsWith(`${base}/`)) {
    return { action: 'skip-foreign' };
  }
  const objectKey = value.slice(base.length + 1).split('?')[0];
  if (!objectKey) return { action: 'skip-foreign' };
  return { action: 'migrate', objectKey, newRef: toPrivateRef(objectKey) };
}
