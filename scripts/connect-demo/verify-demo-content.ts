/**
 * connect:demo:verify — fast, DB-free integrity check for the demo content.
 *
 * Validates the content bank (unique persona keys / mobiles / handles, valid
 * intents / categories / units / wage types, every reference resolves) and the
 * imagery + media builder (every generator returns a well-formed data URI; all
 * five post kinds build valid media). Touches no database and no schemas, so it
 * runs anywhere in milliseconds. Exit code is non-zero on any failure.
 *
 *   Run:  npm run connect:demo:verify
 */
import * as img from './images';
import {
  PERSONAS,
  COMPANY_PAGES,
  STOREFRONTS,
  LISTINGS,
  JOBS,
  RFQS,
  POSTS,
  MARKET_TOPICS,
} from './content';
import { buildPostMedia, slugify } from './helpers';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.log('  FAIL:', name);
  }
}
function isDataUri(s: string): boolean {
  return typeof s === 'string' && s.startsWith('data:');
}
function svgOk(uri: string): boolean {
  if (!uri.startsWith('data:image/svg+xml;base64,')) return isDataUri(uri);
  const b64 = uri.slice('data:image/svg+xml;base64,'.length);
  const svg = Buffer.from(b64, 'base64').toString('utf8');
  return (
    svg.includes('<svg') &&
    svg.includes('</svg>') &&
    !svg.includes('NaN') &&
    !svg.includes('undefined')
  );
}

const LISTING_CATEGORIES = [
  'weaving',
  'dyeing',
  'printing',
  'embroidery-zari',
  'job-work',
  'raw-material',
  'machinery',
  'finished-goods',
];
const UNITS = ['per-meter', 'per-piece', 'per-kg', 'per-set', 'per-dozen', 'per-order'];
const INTENTS = ['workshop_owner', 'karigar', 'buyer', 'explorer'];
const WAGE = ['hourly', 'daily', 'piece', 'monthly'];

// ── content integrity ──────────────────────────────────────────────────
const keys = new Set<string>();
const mobiles = new Set<string>();
const handles = new Set<string>();
for (const p of PERSONAS) {
  check(`persona key unique: ${p.key}`, !keys.has(p.key));
  keys.add(p.key);
  check(`mobile unique: ${p.mobile}`, !mobiles.has(p.mobile));
  mobiles.add(p.mobile);
  const h = `${slugify(p.name)}-demo`;
  check(`handle unique: ${h}`, !handles.has(h));
  handles.add(h);
  check(`intent valid: ${p.key}`, INTENTS.includes(p.intent));
  check(`avatar ok: ${p.key}`, svgOk(img.avatar(p.name)));
  if (!p.sparse) check(`banner ok: ${p.key}`, svgOk(img.banner(p.key)));
}
const personaKeys = keys;
for (const c of COMPANY_PAGES) {
  check(`page owner exists: ${c.key}`, personaKeys.has(c.ownerKey));
  check(`logo ok: ${c.key}`, svgOk(img.logo(c.name)));
}
for (const s of STOREFRONTS) check(`store owner exists: ${s.key}`, personaKeys.has(s.ownerKey));
for (const l of LISTINGS) {
  check(`listing category valid: ${l.title}`, LISTING_CATEGORIES.includes(l.category));
  check(`listing unit valid: ${l.title}`, UNITS.includes(l.unit));
  check(`listing owner exists: ${l.title}`, personaKeys.has(l.ownerKey));
  check(`product photo ok: ${l.title}`, svgOk(img.productPhoto(l.category, l.ownerKey)));
}
for (const j of JOBS) {
  check(`job wage valid: ${j.title}`, WAGE.includes(j.wageType));
  check(`job owner exists: ${j.title}`, personaKeys.has(j.ownerKey));
}
for (const r of RFQS) {
  check(`rfq unit valid: ${r.title}`, UNITS.includes(r.unit));
  check(`rfq buyer exists: ${r.title}`, personaKeys.has(r.buyerKey));
}

// ── post media building (all kinds) ────────────────────────────────────
const kinds = new Set<string>();
for (let i = 0; i < POSTS.length; i += 1) {
  const ps = POSTS[i];
  kinds.add(ps.kind);
  check(`post author exists: ${i}`, personaKeys.has(ps.authorKey));
  const built = buildPostMedia(ps, `k|${i}`);
  if (ps.kind === 'photo') {
    check(`photo has media: ${i}`, built.media.length >= 1);
    check(
      `photo media uris ok: ${i}`,
      built.media.every((m) => svgOk(m.url as string) && m.type === 'image'),
    );
  } else if (ps.kind === 'video') {
    check(
      `video media: ${i}`,
      built.media.length === 1 &&
        built.media[0].type === 'video' &&
        isDataUri(built.media[0].posterUrl as string),
    );
  } else if (ps.kind === 'document') {
    check(`document media: ${i}`, built.media.length === 1 && built.media[0].type === 'document');
  } else if (ps.kind === 'voice') {
    check(`voice audio: ${i}`, !!built.audio && isDataUri((built.audio as { url: string }).url));
  }
}
check('covers text', kinds.has('text'));
check('covers photo', kinds.has('photo'));
check('covers video', kinds.has('video'));
check('covers document', kinds.has('document'));
check('covers voice', kinds.has('voice'));

// ── audio + doc + poster generators ────────────────────────────────────
check('silent wav valid', img.silentWavDataUri().startsWith('data:audio/wav;base64,'));
check('doc thumb ok', svgOk(img.documentThumb('Rate list')));
check('video poster ok', svgOk(img.videoPoster('seedx', 'Floor')));
check('work photo ok', svgOk(img.workPhoto('seedy', 'Panel')));

console.log(
  `\nSMOKE: ${PERSONAS.length} personas · ${COMPANY_PAGES.length} pages · ${STOREFRONTS.length} stores · ` +
    `${LISTINGS.length} listings · ${JOBS.length} jobs · ${RFQS.length} rfqs · ${POSTS.length} posts · ` +
    `${MARKET_TOPICS.length} topics`,
);
console.log(failures === 0 ? 'SMOKE: ALL CHECKS PASSED ✅' : `SMOKE: ${failures} FAILURE(S) ❌`);
process.exit(failures === 0 ? 0 : 1);
