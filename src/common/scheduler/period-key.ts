/**
 * Occurrence bucket keys for the single-flight lock (scheduler-contract ADR).
 *
 * A periodKey identifies one scheduled occurrence. All worker instances firing
 * the same scheduled tick must derive the SAME key so the Redis claim collapses
 * them to one run. Pick the bucket that matches the job's cadence - a coarser
 * bucket is more robust to small clock skew between instances, so daily jobs
 * should use `dayBucket`, hourly jobs `hourBucket`, and sub-hour jobs
 * `minuteBucket`. Never pick a bucket finer than the job's interval.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in UTC. For daily / monthly / weekly jobs. */
export function dayBucket(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `YYYY-MM-DDTHH` in UTC. For hourly jobs. */
export function hourBucket(d: Date = new Date()): string {
  return `${dayBucket(d)}T${pad(d.getUTCHours())}`;
}

/** `YYYY-MM-DDTHH:MM` in UTC. For sub-hour jobs (every minute / 15 min). */
export function minuteBucket(d: Date = new Date()): string {
  return `${hourBucket(d)}:${pad(d.getUTCMinutes())}`;
}
