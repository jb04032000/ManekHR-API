import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { MigrationRunnerService } from './migrations/migration-runner.service';

/**
 * Migration CLI (ADR-0001) — the production / CI-CD path.
 *
 *   npm run migrate              run all pending migrations (fail-closed)
 *   npm run migrate -- --baseline   mark every `once` unit applied WITHOUT
 *                                   running it (one-time pre-stamp for an
 *                                   existing DB whose data already reflects the
 *                                   historical idempotent boot backfills)
 *
 * Exits non-zero on any migration failure so a CI-CD deploy step halts. Build a
 * standalone application context (no HTTP server) — same pattern as src/seed.ts.
 */
async function main(): Promise<void> {
  const baseline = process.argv.includes('--baseline');
  const logger = new Logger('Migrations');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error', 'fatal'],
  });
  // strict:false — the runner is provided by MigrationsModule, not the root.
  const runner = app.get(MigrationRunnerService, { strict: false });

  try {
    if (baseline) {
      await runner.baselineAllOnce();
      logger.log('Baseline complete — all one-shot migrations marked applied.');
    } else {
      const summary = await runner.runAll('cli');
      logger.log(
        `Migrations complete: ${summary.applied.length} applied, ${summary.skipped.length} skipped.`,
      );
    }
    await app.close();
    process.exit(0);
  } catch (err) {
    logger.error(`Migrations FAILED: ${(err as Error).message}`);
    await app.close();
    // Fail-closed: non-zero exit halts the deploy.
    process.exit(1);
  }
}

void main();
