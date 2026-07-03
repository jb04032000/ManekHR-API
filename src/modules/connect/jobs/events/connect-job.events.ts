/**
 * Domain events emitted by the Connect Jobs module (Phase 5).
 *
 * `JobsService` fires {@link CONNECT_JOB_CHANGED} whenever a job is created or
 * its status changes (closed / filled) - i.e. whenever its searchability
 * changes. The job-side mirror of `connect.post.changed`: a thin, fire-and-forget
 * signal the search indexer subscribes to with `@OnEvent` to keep the Meili
 * `connect_jobs` index warm (only OPEN jobs are indexed; a closed / filled job
 * is dropped). With no listener registered the emit is a clean no-op. Kept in
 * its own file so a consumer imports the name + type without pulling in
 * `JobsService` (and its model graph), avoiding a cycle.
 */

/** Event name - a job was created or its status changed. */
export const CONNECT_JOB_CHANGED = 'connect.job.changed';

/** How the job changed - lets a listener upsert (open) vs delete (closed/filled). */
export type ConnectJobChangeType = 'created' | 'updated' | 'closed';

export interface ConnectJobChangedEvent {
  /** The job that changed (stringified ObjectId). */
  jobId: string;
  /** What happened to it. */
  change: ConnectJobChangeType;
}
