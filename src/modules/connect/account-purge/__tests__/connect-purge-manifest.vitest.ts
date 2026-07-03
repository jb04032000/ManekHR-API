/**
 * Connect content-purge MANIFEST completeness gate
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §A.12 / §3A).
 *
 * The purge service (ConnectContentPurgeService) is driven entirely by
 * `CONNECT_PURGE_MANIFEST`. A new `connect_*` collection that nobody classified
 * would be silently skipped by the purge — leaving the deleting user's data
 * behind. This suite is the BUILD GATE that prevents that:
 *
 *   - it discovers EVERY Connect collection straight from the source schemas
 *     (each `@Schema({ ... collection: '<name>' })` under `src/modules/connect`),
 *   - and FAILS if any discovered collection is missing from the manifest, or if
 *     the manifest names a collection that no longer exists, or if any entry is
 *     mis-configured for its action class.
 *
 * Pure filesystem + static analysis — no Mongo, no Nest. Adding a schema file
 * with an unclassified collection turns this suite red until it is classified.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, join } from 'path';
import {
  CONNECT_PURGE_MANIFEST,
  connectPurgeEntryFor,
  CONNECT_PURGE_CLASSES,
  type ConnectPurgeEntry,
} from '../connect-purge-manifest';

/** The Connect module root, resolved from the test runner's cwd (the backend). */
const CONNECT_ROOT = resolve(process.cwd(), 'src/modules/connect');

/** Recursively list every `*.schema.ts` file under a directory. */
function listSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSchemaFiles(full));
    } else if (name.endsWith('.schema.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every collection name declared via `@Schema({ collection: '<name>' })`. */
function discoverCollections(): string[] {
  const collections = new Set<string>();
  for (const file of listSchemaFiles(CONNECT_ROOT)) {
    const src = readFileSync(file, 'utf8');
    const re = /collection:\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) collections.add(m[1]);
  }
  return [...collections].sort();
}

describe('Connect purge manifest — completeness gate (§A.12)', () => {
  const discovered = discoverCollections();

  it('discovers the Connect collections from source (sanity: a non-trivial set)', () => {
    // If this ever drops to near-zero the discovery glob has broken (wrong cwd),
    // which would make the gate vacuously pass — guard against that.
    expect(discovered.length).toBeGreaterThan(40);
  });

  it('classifies EVERY discovered connect collection (build fails on an unclassified one)', () => {
    const unclassified = discovered.filter((c) => connectPurgeEntryFor(c) === undefined);
    expect(unclassified).toEqual([]);
  });

  it('has no manifest entry for a collection that no longer exists', () => {
    const stale = CONNECT_PURGE_MANIFEST.map((e) => e.collection).filter(
      (c) => !discovered.includes(c),
    );
    expect(stale).toEqual([]);
  });

  it('has exactly one manifest entry per collection (no duplicates)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of CONNECT_PURGE_MANIFEST) {
      if (seen.has(e.collection)) dupes.push(e.collection);
      seen.add(e.collection);
    }
    expect(dupes).toEqual([]);
  });

  it('every entry carries a known action class and a non-empty description', () => {
    for (const e of CONNECT_PURGE_MANIFEST) {
      expect(CONNECT_PURGE_CLASSES).toContain(e.klass);
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.model.length).toBeGreaterThan(0);
    }
  });

  it('every MUTATING entry declares HOW it mutates (no silent no-op deletes)', () => {
    // A delete/recompute/null/pull entry must say what it touches, or the engine
    // would silently leave the user's rows behind under a delete-looking class.
    const mutating = (e: ConnectPurgeEntry): boolean =>
      e.klass === 'own' ||
      e.klass === 'outbound' ||
      e.klass === 'recompute' ||
      e.klass === 'null-fk';
    for (const e of CONNECT_PURGE_MANIFEST.filter(mutating)) {
      const declaresWork =
        (e.deleteWhereUser?.length ?? 0) > 0 ||
        e.handler !== undefined ||
        (e.nullUserFields?.length ?? 0) > 0 ||
        (e.pullUserFromArrays?.length ?? 0) > 0 ||
        e.pullEmbedded !== undefined;
      expect(declaresWork, `${e.collection} (${e.klass}) declares no mutation`).toBe(true);
    }
  });

  it('every RETAINED entry records WHY it is retained (the basis for the audit trail)', () => {
    const retained = CONNECT_PURGE_MANIFEST.filter(
      (e) => e.klass === 'evidence' || e.klass === 'billing' || e.klass === 'config',
    );
    for (const e of retained) {
      expect(
        e.retainReason && e.retainReason.length > 0,
        `${e.collection} has no retainReason`,
      ).toBe(true);
    }
  });
});
