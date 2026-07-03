import { describe, it, expect } from 'vitest';
import { evaluateQueueBacklog } from '../queue-backlog.util';

const thresholds = { waiting: 100, failed: 20 };

describe('evaluateQueueBacklog', () => {
  it('is ok with no alert when all counts are within thresholds', () => {
    const v = evaluateQueueBacklog(
      'connect-feed-fanout',
      { waiting: 10, active: 3, delayed: 0, failed: 1 },
      thresholds,
    );
    expect(v.level).toBe('ok');
    expect(v.alert).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.queue).toBe('connect-feed-fanout');
  });

  it('treats counts exactly at the threshold as ok (strictly-greater trigger)', () => {
    const v = evaluateQueueBacklog(
      'billing-dunning',
      { waiting: 100, active: 2, delayed: 0, failed: 20 },
      thresholds,
    );
    expect(v.level).toBe('ok');
    expect(v.alert).toBe(false);
  });

  it('warns when waiting exceeds threshold but workers are still draining it', () => {
    const v = evaluateQueueBacklog(
      'connect-feed-fanout',
      { waiting: 150, active: 5, delayed: 0, failed: 0 },
      thresholds,
    );
    expect(v.alert).toBe(true);
    expect(v.level).toBe('warning');
    expect(v.reasons.join(' ')).toMatch(/waiting/i);
  });

  it('escalates to critical when a backlog exists with zero active workers (stalled queue)', () => {
    const v = evaluateQueueBacklog(
      'einvoice-retry',
      { waiting: 150, active: 0, delayed: 0, failed: 0 },
      thresholds,
    );
    expect(v.alert).toBe(true);
    expect(v.level).toBe('critical');
    expect(v.reasons.join(' ')).toMatch(/no active workers/i);
  });

  it('alerts when failed jobs exceed the failed threshold', () => {
    const v = evaluateQueueBacklog(
      'billing-dunning',
      { waiting: 0, active: 1, delayed: 0, failed: 30 },
      thresholds,
    );
    expect(v.alert).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/failed/i);
  });

  it('escalates to critical when the backlog is severe (>= 5x threshold) even with active workers', () => {
    const v = evaluateQueueBacklog(
      'connect-feed-fanout',
      { waiting: 600, active: 8, delayed: 0, failed: 0 },
      thresholds,
    );
    expect(v.level).toBe('critical');
    expect(v.alert).toBe(true);
  });

  it('escalates to critical when failed count is severe (>= 5x threshold)', () => {
    const v = evaluateQueueBacklog(
      'einvoice-retry',
      { waiting: 0, active: 1, delayed: 0, failed: 100 },
      thresholds,
    );
    expect(v.level).toBe('critical');
    expect(v.alert).toBe(true);
  });
});
