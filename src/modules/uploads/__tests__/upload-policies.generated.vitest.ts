/**
 * Staleness guard for the committed `upload-policies.generated.json` artifact.
 *
 * The web upload-policy mirror is GENERATED from that JSON (see
 * `scripts/export-upload-policies.ts`). If someone edits `upload-policies.ts`
 * but forgets to re-run `npm run export:upload-policies`, the JSON goes stale
 * and the web mirror would be regenerated from outdated data. This test fails
 * in that case.
 *
 * It regenerates the artifact IN MEMORY (the pure builder, no file write) and
 * string-compares it against the committed file, so CI never depends on a
 * filesystem write during the test run.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_PATH,
  buildUploadPoliciesArtifact,
} from '../../../../scripts/export-upload-policies';

describe('upload-policies.generated.json', () => {
  it('is up to date with the TS source (run `npm run export:upload-policies` if this fails)', () => {
    const committed = readFileSync(ARTIFACT_PATH, 'utf8');
    const regenerated = buildUploadPoliciesArtifact();
    expect(committed).toBe(regenerated);
  });
});
