/**
 * Pure queue-backlog evaluation (launch monitoring — Workstream F). Turns a
 * BullMQ getJobCounts() snapshot into an alert verdict. Kept dependency-free and
 * side-effect-free so it is trivially unit-testable; QueueMonitorService wires it
 * to the live queues + Sentry/Logger.
 *
 * Signals (any one raises an alert):
 *   - backlog: waiting jobs exceed the configured threshold.
 *   - failed:  failed jobs exceed the configured threshold.
 *   - stalled: a backlog exists AND zero workers are processing (no consumer) —
 *              the most actionable signal; escalates to critical.
 * Severe (>= 5x threshold) backlog or failure also escalates to critical.
 */

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface QueueThresholds {
  waiting: number;
  failed: number;
}

export type QueueAlertLevel = 'ok' | 'warning' | 'critical';

export interface QueueBacklogVerdict {
  queue: string;
  level: QueueAlertLevel;
  alert: boolean;
  reasons: string[];
  counts: QueueCounts;
}

// Multiplier above which a breach is treated as critical rather than a warning.
const SEVERE_MULTIPLIER = 5;

export function evaluateQueueBacklog(
  queue: string,
  counts: QueueCounts,
  thresholds: QueueThresholds,
): QueueBacklogVerdict {
  const reasons: string[] = [];

  const backlog = counts.waiting > thresholds.waiting;
  const manyFailed = counts.failed > thresholds.failed;
  const stalled = backlog && counts.active === 0;
  const severeBacklog = counts.waiting >= thresholds.waiting * SEVERE_MULTIPLIER;
  const severeFailed = counts.failed >= thresholds.failed * SEVERE_MULTIPLIER;

  if (backlog) {
    reasons.push(`backlog: ${counts.waiting} jobs waiting (threshold ${thresholds.waiting})`);
  }
  if (manyFailed) {
    reasons.push(`${counts.failed} failed jobs (threshold ${thresholds.failed})`);
  }
  if (stalled) {
    reasons.push(`no active workers draining ${counts.waiting} waiting jobs`);
  }

  const level: QueueAlertLevel =
    stalled || severeBacklog || severeFailed ? 'critical' : reasons.length > 0 ? 'warning' : 'ok';

  return { queue, level, alert: reasons.length > 0, reasons, counts };
}
