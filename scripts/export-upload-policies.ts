/**
 * export-upload-policies.ts — codegen: serialize the canonical upload policies
 * into a committed JSON artifact (`upload-policies.generated.json`).
 *
 * WHY: `src/modules/uploads/upload-policies.ts` is the single source of truth for
 * upload limits (mime lists, size caps, durations, aspect ratios, visibility,
 * plan overrides). The web app needs the same data for its friendly pre-check.
 * Instead of a hand-kept mirror (which silently drifts), the web mirror is
 * GENERATED from the JSON this script emits.
 *
 * FLOW (also documented at the top of upload-policies.ts):
 *   edit upload-policies.ts
 *     -> npm run export:upload-policies      (this script, writes the JSON)
 *     -> cd ../crewroster-web && npm run sync:upload-policies  (regen the mirror)
 *     -> commit all three artifacts together.
 *
 * Determinism: object keys are sorted recursively so the JSON diff only ever
 * reflects a real policy change, never key-ordering noise. Arrays keep their
 * authored order (mime order is meaningful — it drives the FE `accept` attr).
 *
 * The pure builder (`buildUploadPoliciesArtifact`) is exported and reused by
 * `__tests__/upload-policies.generated.vitest.ts` so the staleness test can
 * regenerate-and-compare in memory without writing any file.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CATEGORY_POLICIES, PLAN_OVERRIDES } from '../src/modules/uploads/upload-policies';

/** Absolute path of the committed artifact (repo-root sibling of package.json). */
export const ARTIFACT_PATH = resolve(__dirname, '..', 'upload-policies.generated.json');

/** Recursively sort object keys for a stable, diff-friendly serialization. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Build the canonical JSON string (with trailing newline). Pure — no IO — so the
 * staleness test can call it directly and string-compare against the committed
 * file. The `__generated` block is a header (JSON has no comments) naming the
 * source + the two regenerate commands.
 */
export function buildUploadPoliciesArtifact(): string {
  const artifact = {
    __generated: {
      note: 'GENERATED FILE — do not edit by hand. Edit the TS source and re-run the export.',
      source: 'crewroster-backend/src/modules/uploads/upload-policies.ts',
      regenerate: 'cd crewroster-backend && npm run export:upload-policies',
      webSync: 'cd crewroster-web && npm run sync:upload-policies',
    },
    categoryPolicies: CATEGORY_POLICIES,
    planOverrides: PLAN_OVERRIDES,
  };
  return `${JSON.stringify(sortDeep(artifact), null, 2)}\n`;
}

function main(): void {
  const json = buildUploadPoliciesArtifact();
  writeFileSync(ARTIFACT_PATH, json, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`upload-policies.generated.json written (${json.length} bytes) -> ${ARTIFACT_PATH}`);
}

// Run only when invoked directly (not when imported by the test).
if (require.main === module) {
  main();
}
