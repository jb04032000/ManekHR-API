/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { scoreColdContact, decideSpamAction, SPAM_THRESHOLDS } from '../spam-scoring';
import { MessagingSpamGuard } from '../messaging-spam-guard';

const clean = { duplicateBodyCount: 1, initiationCount: 0, openReportCount: 0 };

describe('scoreColdContact', () => {
  it('scores a clean cold message at zero', () => {
    expect(scoreColdContact({ body: 'Hello, do you make zari panels?', ...clean }).score).toBe(0);
  });

  it('flags a link / phone / email as a single low signal (not enough alone)', () => {
    expect(scoreColdContact({ body: 'see http://x.example', ...clean }).signals).toContain('link');
    expect(scoreColdContact({ body: 'call 9876543210', ...clean }).signals).toContain('phone');
    expect(scoreColdContact({ body: 'mail me a@b.com', ...clean }).signals).toContain('email');
    // a lone link only reaches "log", never quarantine
    expect(decideSpamAction(scoreColdContact({ body: 'http://x.example', ...clean }).score)).toBe(
      'log',
    );
  });

  it('treats a repeated body as a soft-limit signal', () => {
    const r = scoreColdContact({
      body: 'lowest price',
      duplicateBodyCount: 4,
      initiationCount: 0,
      openReportCount: 0,
    });
    expect(r.signals).toContain('repeated_body');
    expect(decideSpamAction(r.score)).toBe('soft_limit');
  });

  it('quarantines a link + repeated body + high fan-out combination', () => {
    const r = scoreColdContact({
      body: 'deal http://x.example',
      duplicateBodyCount: 5,
      initiationCount: 20,
      openReportCount: 0,
    });
    expect(r.score).toBeGreaterThanOrEqual(SPAM_THRESHOLDS.quarantine);
    expect(decideSpamAction(r.score)).toBe('quarantine');
  });

  it('quarantines on accumulated reports alone (capped)', () => {
    const r = scoreColdContact({
      body: 'hi',
      duplicateBodyCount: 1,
      initiationCount: 0,
      openReportCount: 9,
    });
    expect(decideSpamAction(r.score)).toBe('quarantine');
  });
});

describe('decideSpamAction thresholds', () => {
  it('maps scores to actions', () => {
    expect(decideSpamAction(0)).toBe('allow');
    expect(decideSpamAction(2)).toBe('log');
    expect(decideSpamAction(SPAM_THRESHOLDS.soft)).toBe('soft_limit');
    expect(decideSpamAction(SPAM_THRESHOLDS.quarantine)).toBe('quarantine');
  });
});

describe('MessagingSpamGuard', () => {
  it('counts a repeated body and sets a TTL on first sight', async () => {
    const redis = { incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1) };
    const guard = new MessagingSpamGuard(redis as any);
    await expect(guard.recordAndCountDuplicateBody('u1', 'hello')).resolves.toBe(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it('reads the initiation count without incrementing', async () => {
    const redis = { get: vi.fn().mockResolvedValue('5') };
    const guard = new MessagingSpamGuard(redis as any);
    await expect(guard.getInitiationCount('u1')).resolves.toBe(5);
  });

  it('reports quarantine state from the flag key', async () => {
    const onRedis = { exists: vi.fn().mockResolvedValue(1) };
    const offRedis = { exists: vi.fn().mockResolvedValue(0) };
    await expect(new MessagingSpamGuard(onRedis as any).isQuarantined('u1')).resolves.toBe(true);
    await expect(new MessagingSpamGuard(offRedis as any).isQuarantined('u1')).resolves.toBe(false);
  });

  it('sets the quarantine flag with a TTL', async () => {
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    const guard = new MessagingSpamGuard(redis as any);
    await guard.quarantine('u1', 3600);
    expect(redis.set).toHaveBeenCalledWith('inbox:spam:quarantine:u1', '1', 'EX', 3600);
  });

  it('fails open when Redis errors', async () => {
    const redis = {
      incr: vi.fn().mockRejectedValue(new Error('down')),
      exists: vi.fn().mockRejectedValue(new Error('down')),
    };
    const guard = new MessagingSpamGuard(redis as any);
    await expect(guard.recordAndCountDuplicateBody('u1', 'x')).resolves.toBe(1);
    await expect(guard.isQuarantined('u1')).resolves.toBe(false);
  });
});
