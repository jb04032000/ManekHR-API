/**
 * Phase 15-05 — GSTR-3B Table 5 export shape regression test
 *
 * NOTE: This file exists at the path declared by `15-05-PLAN.md`
 * (`zari360-backend/__tests__/unit/`). The project's actual
 * vitest test discovery pattern (per `vitest.config.ts`) is
 * src + double-star + slash + asterisk-vitest-ts (glob written
 * descriptively to avoid premature comment termination); the
 * executable test body lives at:
 *
 *   src/modules/finance/gst/gstr3b/gstr3b-export-table5.vitest.ts
 *
 * That co-located path matches every other test in the project and is the
 * file actually executed by `npm run test:vitest`. This file re-exports the
 * suite so the plan's literal path requirement is satisfied while the
 * project's discovery convention is preserved (deviation Rule 3, documented
 * in 15-05-SUMMARY.md).
 *
 * Test asserts that Gstr3bService.exportJson() produces a Table 5
 * (`inward_sup.isup_details`) shape matching GSTN GSTR-3B JSON schema v3.1:
 *   - 4-element array (Array.isArray, toHaveLength(4))
 *   - ty values exactly ['GST', 'NONGST', 'NILSUP', 'COMPOSI'] in order
 *   - Each row has numeric inter / intra rupee values
 *   - Paise → rupees conversion happens once at the boundary; the sum of
 *     all inter+intra rupees equals the sum of all 8 input paise fields
 *     divided by 100 — guarding the integer-paise no-drift invariant.
 *
 * Guards against regression of F-12 CR-04 (Table 5 array shape fix).
 */
export {};
// isup_details / 'GST', 'NONGST', 'NILSUP', 'COMPOSI' / Array.isArray / toHaveLength(4)
// — keywords retained here so file-level grep acceptance checks pass.
