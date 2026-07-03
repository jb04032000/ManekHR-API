// Build the canonical India State -> District reference (india-geo.ts) for
// Connect location targeting + capture, and write IDENTICAL mirrors into both
// repos (backend + web). Run: `node scripts/india-geo/build-india-geo.mjs`.
//
// Source: india-states-districts.source.json (sab99r/Indian-States-And-Districts,
// community dataset, ~2018 vintage: pre Ladakh-split / pre DNH+DD merge).
// 35 states/UTs, 722 districts; Gujarat (the live market) verified at 33.
// To refresh with newer/official data: replace the source JSON with an export
// from the official LGD directory (lgdirectory.gov.in) keeping the same
// { states: [{ state, districts: [] }] } shape, then re-run this script.
//
// The two generated files MUST stay byte-identical (FE sends a slug; BE matches
// on the same slug). A vitest in each repo guards integrity (counts + unique
// slugs). Do NOT hand-edit the generated india-geo.ts files.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '../../../');
const SOURCE = resolve(scriptDir, 'india-states-districts.source.json');
const OUT_BE = resolve(workspaceRoot, 'crewroster-backend/src/modules/connect/geo/india-geo.ts');
const OUT_WEB = resolve(workspaceRoot, 'crewroster-web/features/connect/geo/india-geo.ts');

/** Lowercase, ascii-fold, non-alphanumeric -> single dash, trim dashes. */
function slugify(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const raw = JSON.parse(readFileSync(SOURCE, 'utf8'));
const states = [];
for (const s of raw.states) {
  const isUT = /\((UT|NCT)\)/i.test(s.state);
  const name = s.state.replace(/\s*\((UT|NCT)\)\s*/i, '').trim();
  const slug = slugify(name);
  const seen = new Set();
  const districts = [];
  for (const d of s.districts) {
    const dName = d.trim();
    let dSlug = slugify(dName);
    if (!dSlug || seen.has(dSlug)) continue; // drop blanks + within-state dup slugs
    seen.add(dSlug);
    districts.push({ slug: dSlug, name: dName });
  }
  districts.sort((a, b) => a.name.localeCompare(b.name));
  states.push({ slug, name, isUT, districts });
}
states.sort((a, b) => a.name.localeCompare(b.name));

// Integrity guards at build time.
const stateSlugs = new Set();
for (const s of states) {
  if (stateSlugs.has(s.slug)) throw new Error(`duplicate state slug: ${s.slug}`);
  stateSlugs.add(s.slug);
}
const districtCount = states.reduce((n, s) => n + s.districts.length, 0);
const guj = states.find((s) => s.slug === 'gujarat');
if (!guj || guj.districts.length !== 33) {
  throw new Error(`Gujarat sanity check failed (expected 33 districts, got ${guj?.districts.length})`);
}

const body = states
  .map((s) => {
    const ds = s.districts.map((d) => `      { slug: '${d.slug}', name: ${JSON.stringify(d.name)} },`).join('\n');
    return `  {\n    slug: '${s.slug}',\n    name: ${JSON.stringify(s.name)},\n    isUT: ${s.isUT},\n    districts: [\n${ds}\n    ],\n  },`;
  })
  .join('\n');

const header = `/**
 * india-geo.ts - GENERATED canonical India State -> District reference for
 * Connect location targeting + capture. DO NOT HAND-EDIT.
 *
 * Regenerate: backend \`node scripts/india-geo/build-india-geo.mjs\` (writes this
 * file in BOTH repos identically). Source + refresh instructions live there.
 *
 * Coverage: ${states.length} states/UTs, ${districtCount} districts (~2018 community
 * snapshot: pre Ladakh-split / pre DNH+DD merge). Gujarat (live market) = 33.
 * Refresh from the official LGD directory when broader coverage is needed.
 *
 * Keyed by SLUG (lowercased, ascii). The web sends a slug; the backend matches
 * targeting on the same slug. This file MUST stay identical in both repos - a
 * vitest in each guards counts + unique slugs.
 */

export interface GeoDistrict {
  readonly slug: string;
  readonly name: string;
}

export interface GeoState {
  readonly slug: string;
  readonly name: string;
  readonly isUT: boolean;
  readonly districts: readonly GeoDistrict[];
}

export const INDIA_GEO: readonly GeoState[] = [
${body}
];
`;

writeFileSync(OUT_BE, header);
writeFileSync(OUT_WEB, header);
console.log(`wrote ${states.length} states / ${districtCount} districts to:`);
console.log(`  ${OUT_BE}`);
console.log(`  ${OUT_WEB}`);
