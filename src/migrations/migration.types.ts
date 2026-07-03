/**
 * Migration unit contract for the ledgered runner (ADR-0001).
 * See docs/architecture/adr/0001-migration-ledger.md.
 */

export type MigrationKind = 'once' | 'convergent';

export interface Migration {
  /** Stable, ordered id (numbered prefix), e.g. `0001_connect_*`. Ledger key. */
  name: string;
  /**
   * `once`       — one-shot data migration; skipped forever once applied.
   * `convergent` — a seed whose payload may grow/change; re-applied only when
   *                `checksum` differs from the ledger (else skipped).
   */
  kind: MigrationKind;
  /** Seed-payload version. REQUIRED for `convergent`; bump when the seed changes. */
  checksum?: string;
  /** Runs the migration. Returns a small summary object that gets logged. */
  run: () => Promise<unknown>;
}

export interface MigrationRunSummary {
  applied: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

/**
 * DI token for the ordered array of migration units. Assembled in MigrationsModule
 * via a factory so each slice just appends to the registry (Connect first).
 */
export const MIGRATION_UNITS = Symbol('MIGRATION_UNITS');
