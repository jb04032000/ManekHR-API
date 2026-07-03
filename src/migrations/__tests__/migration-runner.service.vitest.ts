/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationRunnerService } from '../migration-runner.service';
import type { Migration } from '../migration.types';

/**
 * In-memory fake of the bits of `Model<MigrationRecord>` the runner uses:
 *   findOne({ name }).lean()  and  updateOne({ name }, { $set }, { upsert })
 */
function fakeLedger() {
  const rows = new Map<string, any>();
  return {
    rows,
    findOne({ name }: { name: string }) {
      return { lean: () => Promise.resolve(rows.get(name) ?? null) };
    },
    updateOne({ name }: { name: string }, update: any) {
      rows.set(name, { name, ...(rows.get(name) ?? {}), ...update.$set });
      return Promise.resolve({ acknowledged: true });
    },
  };
}

// SingleFlight stub that always wins the claim and runs fn.
const passthroughLock = {
  runExclusive: async (_k: string, _p: string, fn: () => Promise<any>) => ({
    ran: true,
    result: await fn(),
  }),
} as any;

const onceUnit = (name: string, run: () => Promise<unknown>): Migration => ({
  name,
  kind: 'once',
  run,
});
const convergentUnit = (
  name: string,
  checksum: string,
  run: () => Promise<unknown>,
): Migration => ({
  name,
  kind: 'convergent',
  checksum,
  run,
});

const makeRunner = (ledger: any, units: Migration[]) =>
  new MigrationRunnerService(ledger, units, passthroughLock);

describe('MigrationRunnerService.applyPending', () => {
  let ledger: ReturnType<typeof fakeLedger>;
  beforeEach(() => {
    ledger = fakeLedger();
  });

  it('runs a once-unit that is not in the ledger and records it applied + duration', async () => {
    const run = vi.fn().mockResolvedValue({ ok: 1 });
    const runner = makeRunner(ledger, [onceUnit('0001_a', run)]);

    const summary = await runner.applyPending();

    expect(run).toHaveBeenCalledTimes(1);
    expect(summary.applied).toEqual(['0001_a']);
    const row = ledger.rows.get('0001_a');
    expect(row.status).toBe('applied');
    expect(typeof row.durationMs).toBe('number');
  });

  it('skips a once-unit already marked applied (no re-run)', async () => {
    ledger.rows.set('0001_a', { name: '0001_a', status: 'applied' });
    const run = vi.fn();
    const runner = makeRunner(ledger, [onceUnit('0001_a', run)]);

    const summary = await runner.applyPending();

    expect(run).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual(['0001_a']);
  });

  it('skips a convergent-unit when the checksum is unchanged', async () => {
    ledger.rows.set('0004_seed', { name: '0004_seed', status: 'applied', checksum: 'v1' });
    const run = vi.fn();
    const runner = makeRunner(ledger, [convergentUnit('0004_seed', 'v1', run)]);

    await runner.applyPending();

    expect(run).not.toHaveBeenCalled();
  });

  it('re-runs a convergent-unit when the checksum changed', async () => {
    ledger.rows.set('0004_seed', { name: '0004_seed', status: 'applied', checksum: 'v1' });
    const run = vi.fn().mockResolvedValue({ inserted: 2 });
    const runner = makeRunner(ledger, [convergentUnit('0004_seed', 'v2', run)]);

    const summary = await runner.applyPending();

    expect(run).toHaveBeenCalledTimes(1);
    expect(summary.applied).toEqual(['0004_seed']);
    expect(ledger.rows.get('0004_seed').checksum).toBe('v2');
  });

  it('re-attempts a unit whose last status was failed', async () => {
    ledger.rows.set('0001_a', { name: '0001_a', status: 'failed' });
    const run = vi.fn().mockResolvedValue({});
    const runner = makeRunner(ledger, [onceUnit('0001_a', run)]);

    await runner.applyPending();

    expect(run).toHaveBeenCalledTimes(1);
    expect(ledger.rows.get('0001_a').status).toBe('applied');
  });

  it('is fail-closed: on a failure it records failed, throws, and does NOT run later units', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const later = vi.fn().mockResolvedValue({});
    const runner = makeRunner(ledger, [
      onceUnit('0001_fail', failing),
      onceUnit('0002_later', later),
    ]);

    await expect(runner.applyPending()).rejects.toThrow(/0001_fail/);

    expect(failing).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    expect(ledger.rows.get('0001_fail').status).toBe('failed');
    expect(ledger.rows.get('0001_fail').error).toContain('boom');
  });

  it('runs units in registry order', async () => {
    const calls: string[] = [];
    const runner = makeRunner(ledger, [
      onceUnit('0001_a', () => Promise.resolve(calls.push('a'))),
      onceUnit('0002_b', () => Promise.resolve(calls.push('b'))),
      onceUnit('0003_c', () => Promise.resolve(calls.push('c'))),
    ]);

    await runner.applyPending();

    expect(calls).toEqual(['a', 'b', 'c']);
  });
});

describe('MigrationRunnerService.markBaseline', () => {
  it('marks the given units applied WITHOUT running them (existing-DB pre-stamp)', async () => {
    const ledger = fakeLedger();
    const run = vi.fn();
    const runner = makeRunner(ledger, [onceUnit('0001_a', run), onceUnit('0002_b', run)]);

    await runner.markBaseline(['0001_a', '0002_b']);

    expect(run).not.toHaveBeenCalled();
    expect(ledger.rows.get('0001_a').status).toBe('applied');
    expect(ledger.rows.get('0002_b').status).toBe('applied');

    // A subsequent run then skips them.
    const summary = await runner.applyPending();
    expect(summary.skipped.sort()).toEqual(['0001_a', '0002_b']);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('MigrationRunnerService.runAll', () => {
  it('skips entirely when another instance holds the lock', async () => {
    const ledger = fakeLedger();
    const run = vi.fn();
    const losingLock = {
      runExclusive: () => Promise.resolve({ ran: false }),
    } as any;
    const runner = new MigrationRunnerService(ledger as any, [onceUnit('0001_a', run)], losingLock);

    const summary = await runner.runAll('cli');

    expect(run).not.toHaveBeenCalled();
    expect(summary.applied).toEqual([]);
  });
});
