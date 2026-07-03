import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { hostname } from 'os';
import { Model } from 'mongoose';
import { SingleFlightService } from '../common/scheduler/single-flight.service';
import { env } from '../config/env';
import { MigrationRecord } from './schemas/migration-record.schema';
import { MIGRATION_UNITS, type Migration, type MigrationRunSummary } from './migration.types';

/**
 * Ledgered migration runner (ADR-0001) — replaces the per-boot OnModuleInit
 * seed/backfill pattern. Reads the `migrations` ledger, runs only PENDING units
 * (a `once` unit absent from the ledger, or a `convergent` unit whose checksum
 * changed, or any unit whose last attempt `failed`) in registry order, and
 * records each outcome. Already-applied units are skipped instantly — no Mongo
 * round-trip per backfill on every boot.
 *
 * Invocation (ADR §3.5):
 *   - `npm run migrate` (CLI / CI-CD deploy step) → the production path.
 *   - opt-in `RUN_MIGRATIONS_ON_BOOT=true` (worker/all roles) → fresh-dev path.
 * The HTTP server boot no longer runs migrations unless that flag is set.
 *
 * Fail policy (ADR §6 decision 2): the CLI path is FAIL-CLOSED — a unit failure
 * throws so `migrate.ts` exits non-zero and halts the deploy. The opt-in boot
 * path catches + logs so a dev migration failure never crashes the app process.
 *
 * Concurrency (decision 4): the whole run is wrapped in the existing Redis
 * single-flight lock so concurrent web/worker instances never double-run.
 */
@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Migrations');

  constructor(
    @InjectModel(MigrationRecord.name)
    private readonly ledger: Model<MigrationRecord>,
    @Inject(MIGRATION_UNITS)
    private readonly units: Migration[],
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * Opt-in fresh-dev boot path. Default OFF — production runs migrations via the
   * explicit CLI/CI step, never inside HTTP-server boot. Only the worker/all
   * roles run them (a `web` role never mutates data at boot).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!env.migrations.runOnBoot) {
      this.logger.log(
        'RUN_MIGRATIONS_ON_BOOT=false — migrations run via `npm run migrate` / CI step, not on boot.',
      );
      return;
    }
    if (env.processRole === 'web') {
      this.logger.log('PROCESS_ROLE=web — skipping boot migrations (worker/all only).');
      return;
    }
    try {
      const summary = await this.runAll('boot');
      this.logger.log(
        `boot migrations: ${summary.applied.length} applied, ${summary.skipped.length} skipped.`,
      );
    } catch (err) {
      // Boot path is dev convenience — never crash the process on a failed
      // migration here (the CLI/CI path is the one that fails the deploy).
      this.logger.error(`boot migrations failed (non-fatal on boot): ${(err as Error).message}`);
    }
  }

  /**
   * Run all pending migrations under the single-flight lock. Returns an empty
   * summary (and runs nothing) when another instance already holds the lock.
   * Throws on the first unit failure (fail-closed) — callers that must not crash
   * (the boot path) catch it.
   */
  async runAll(trigger: 'cli' | 'boot'): Promise<MigrationRunSummary> {
    const { ran, result } = await this.singleFlight.runExclusive(
      'migration-runner',
      'run',
      () => this.applyPending(trigger),
      { ttlMs: 10 * 60_000 },
    );
    if (!ran) {
      this.logger.log('Migrations already running on another instance; skipped here.');
      return { applied: [], skipped: [], failed: [] };
    }
    // `ran` true ⇒ `result` is set; the fallback only satisfies the type.
    return result ?? { applied: [], skipped: [], failed: [] };
  }

  /**
   * Core decision loop (no lock — directly unit-tested). For each unit in order:
   * skip if already applied (and, for convergent, checksum unchanged); otherwise
   * run it, record the outcome, and on failure record `failed` + throw to stop.
   */
  async applyPending(trigger: 'cli' | 'boot' = 'cli'): Promise<MigrationRunSummary> {
    const summary: MigrationRunSummary = { applied: [], skipped: [], failed: [] };

    for (const unit of this.units) {
      const existing = await this.ledger.findOne({ name: unit.name }).lean();
      const isApplied = existing?.status === 'applied';
      const checksumUnchanged =
        unit.kind === 'once' ? true : (existing?.checksum ?? null) === (unit.checksum ?? null);

      if (isApplied && checksumUnchanged) {
        summary.skipped.push(unit.name);
        continue;
      }

      const start = Date.now();
      try {
        const result = await unit.run();
        const durationMs = Date.now() - start;
        await this.recordApplied(unit, durationMs, trigger);
        summary.applied.push(unit.name);
        this.logger.log(
          `migration ${unit.name} applied in ${durationMs}ms${
            result ? ` ${JSON.stringify(result)}` : ''
          }`,
        );
      } catch (err) {
        const durationMs = Date.now() - start;
        const message = (err as Error).message;
        await this.recordFailed(unit, durationMs, message, trigger).catch(() => undefined);
        summary.failed.push({ name: unit.name, error: message });
        this.logger.error(`migration ${unit.name} FAILED after ${durationMs}ms: ${message}`);
        // Fail-closed: stop the run so a bad migration halts the deploy and later
        // units don't apply on top of a half-migrated state.
        throw new Error(`Migration ${unit.name} failed: ${message}`);
      }
    }

    return summary;
  }

  /**
   * Pre-stamp the given migrations as applied WITHOUT running them. Used once on
   * an existing DB whose data already reflects the historical (idempotent) boot
   * backfills, so the first real run doesn't re-execute them. New/fresh DBs skip
   * this and let `applyPending` run everything in order.
   */
  async markBaseline(names: string[]): Promise<void> {
    for (const name of names) {
      const unit = this.units.find((u) => u.name === name);
      await this.ledger.updateOne(
        { name },
        {
          $set: {
            name,
            checksum: unit?.checksum ?? null,
            status: 'applied',
            appliedAt: new Date(),
            durationMs: 0,
            error: null,
            runner: this.runnerTag('baseline'),
          },
        },
        { upsert: true },
      );
      this.logger.log(`migration ${name} baselined (marked applied without running).`);
    }
  }

  /** Baseline every `once` unit in the registry (existing-DB first-run helper). */
  async baselineAllOnce(): Promise<void> {
    await this.markBaseline(this.units.filter((u) => u.kind === 'once').map((u) => u.name));
  }

  private async recordApplied(unit: Migration, durationMs: number, trigger: string): Promise<void> {
    await this.ledger.updateOne(
      { name: unit.name },
      {
        $set: {
          name: unit.name,
          checksum: unit.checksum ?? null,
          status: 'applied',
          appliedAt: new Date(),
          durationMs,
          error: null,
          runner: this.runnerTag(trigger),
        },
      },
      { upsert: true },
    );
  }

  private async recordFailed(
    unit: Migration,
    durationMs: number,
    message: string,
    trigger: string,
  ): Promise<void> {
    await this.ledger.updateOne(
      { name: unit.name },
      {
        $set: {
          name: unit.name,
          checksum: unit.checksum ?? null,
          status: 'failed',
          durationMs,
          error: message,
          runner: this.runnerTag(trigger),
        },
      },
      { upsert: true },
    );
  }

  private runnerTag(trigger: string): string {
    // os.hostname() (not process.env) so this stays clear of the no-process.env
    // lint rule — and works the same in CLI, CI, and boot contexts.
    return `${hostname() || 'local'}@${trigger}`;
  }
}
