/**
 * connect-demo/images.ts — self-contained textile imagery for the Connect
 * demo seed and the auto-poster.
 *
 * Everything here returns an inline `data:` URI (base64-encoded SVG, or a tiny
 * embedded WAV/MP4 for voice/video). There are NO external asset files and NO
 * network calls, so the demo content renders identically on any machine, in
 * any environment, forever — and the seed stays a single `npm run` away.
 *
 * Images are *deterministic*: the same seed string always produces the same
 * picture. That keeps a persona's avatar / banner / portfolio stable across
 * re-runs (the seed is idempotent) and makes the feed look hand-made rather
 * than random-noisy.
 *
 * The motifs are drawn from the Surat / Gujarat textile trade the product
 * serves: zari borders, embroidery paisleys, woven fabric, sari drapes,
 * thread cones, embroidery-machine heads, etc. They read as "designed demo
 * tiles", which is honest — paired with the quiet sample-content notice in the
 * web app, nobody mistakes them for real photographs.
 */

/* ────────────────────────────────────────────────────────────────────────
 * Deterministic pseudo-randomness (seeded by a string)
 * ──────────────────────────────────────────────────────────────────────── */

/** FNV-1a string hash → 32-bit unsigned int. Stable across Node versions. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — tiny, fast, good enough for picking colours/positions. */
function rng(seed: string): () => number {
  let a = hashSeed(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length];
}

/* ────────────────────────────────────────────────────────────────────────
 * Encoding
 * ──────────────────────────────────────────────────────────────────────── */

/** Wrap raw SVG markup as a base64 data URI (bullet-proof for any content). */
export function svgDataUri(svg: string): string {
  const compact = svg.replace(/\n\s*/g, ' ').trim();
  return `data:image/svg+xml;base64,${Buffer.from(compact).toString('base64')}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Colour palettes — warm Indian-textile tones
 * ──────────────────────────────────────────────────────────────────────── */

/** [deep, mid, accent-gold] triplets that look good together. */
const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#7A1E3A', '#B23A66', '#E8C36B'], // maroon / rani pink / gold
  ['#142158', '#2A3F8F', '#E8C36B'], // royal blue / indigo / gold
  ['#1E5631', '#2F8F4E', '#E8C36B'], // emerald / leaf / gold
  ['#7A2E1E', '#B5552F', '#F0CF7A'], // rust / terracotta / gold
  ['#5B2A86', '#8A4FBE', '#E8C36B'], // purple / amethyst / gold
  ['#0E4D64', '#1C7C9C', '#E8C36B'], // teal / peacock / gold
  ['#8A1C1C', '#C0392B', '#F0CF7A'], // crimson / red / gold
  ['#33312E', '#5C574F', '#D9B45B'], // charcoal / taupe / antique gold
  ['#A23E48', '#D98C5F', '#F3D9A0'], // brick / saffron / cream
  ['#243B2F', '#3E6F52', '#D9B45B'], // forest / sage / gold
];

const GOLD = '#E8C36B';
const GOLD_DEEP = '#C9A227';

function palette(seed: string): readonly [string, string, string] {
  return pick(rng(seed + '|pal'), PALETTES);
}

/* ────────────────────────────────────────────────────────────────────────
 * Reusable SVG fragments
 * ──────────────────────────────────────────────────────────────────────── */

/** A paisley (keri / mango) motif path, the signature shape of zari work. */
function paisley(cx: number, cy: number, s: number, fill: string, op = 1): string {
  return (
    `<path transform="translate(${cx} ${cy}) scale(${s})" opacity="${op}" fill="${fill}" ` +
    `d="M0,-14 C10,-14 16,-6 16,3 C16,12 8,18 0,18 C-7,18 -12,12 -12,5 ` +
    `C-12,-1 -8,-5 -3,-5 C0,-5 3,-3 3,1 C3,4 1,6 -1,6 C-3,6 -4,4 -3,2" ` +
    `stroke="${fill}" stroke-width="0.6"/>`
  );
}

/** A small 8-point star / buti, scattered across embroidery grounds. */
function buti(cx: number, cy: number, s: number, fill: string, op = 1): string {
  const p: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 4) * i;
    const r = i % 2 === 0 ? s : s * 0.42;
    p.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return `<polygon points="${p.join(' ')}" fill="${fill}" opacity="${op}"/>`;
}

/** A horizontal zari border band (interlocking gold motifs on a deep ground). */
function zariBand(width: number, y: number, h: number, ground: string, seed: string): string {
  const r = rng(seed + '|band');
  const out: string[] = [`<rect x="0" y="${y}" width="${width}" height="${h}" fill="${ground}"/>`];
  // top + bottom gold rails
  out.push(
    `<rect x="0" y="${y}" width="${width}" height="${Math.max(2, h * 0.12)}" fill="${GOLD}"/>`,
  );
  out.push(
    `<rect x="0" y="${y + h - Math.max(2, h * 0.12)}" width="${width}" height="${Math.max(2, h * 0.12)}" fill="${GOLD}"/>`,
  );
  const step = Math.max(26, h * 0.9);
  for (let x = step / 2; x < width; x += step) {
    const flip = r() > 0.5 ? 1 : -1;
    out.push(paisley(x, y + h / 2, (h / 36) * 1.1, GOLD, 0.95));
    out.push(buti(x + step / 2, y + h / 2, h * 0.16 * flip, GOLD_DEEP, 0.9));
  }
  return out.join('');
}

/** A woven-fabric ground: diagonal warp/weft hatching over a base fill. */
function wovenGround(w: number, h: number, base: string, thread: string, seed: string): string {
  const r = rng(seed + '|weave');
  const lines: string[] = [`<rect width="${w}" height="${h}" fill="${base}"/>`];
  const gap = 7 + Math.floor(r() * 4);
  for (let i = -h; i < w; i += gap) {
    lines.push(
      `<line x1="${i}" y1="0" x2="${i + h}" y2="${h}" stroke="${thread}" stroke-width="1" opacity="0.10"/>`,
    );
  }
  for (let i = 0; i < w + h; i += gap) {
    lines.push(
      `<line x1="${i}" y1="0" x2="${i - h}" y2="${h}" stroke="#000000" stroke-width="1" opacity="0.05"/>`,
    );
  }
  return lines.join('');
}

/** Defs: a soft diagonal sheen gradient used to make fabric look lit. */
function sheen(id: string, c1: string, c2: string): string {
  return (
    `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/>` +
    `<stop offset="0.55" stop-color="${c2}"/>` +
    `<stop offset="1" stop-color="${c1}"/>` +
    `</linearGradient>`
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Public generators
 * ──────────────────────────────────────────────────────────────────────── */

/** Legacy flat swatch (kept so older references still resolve). */
export function swatch(hex: string): string {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="${hex}"/></svg>`,
  );
}

/**
 * Profile / company banner — a draped-fabric ground with a zari border running
 * across it. Wide 3:1 hero strip.
 */
export function banner(seed: string): string {
  const [deep, mid] = palette(seed);
  const w = 1200;
  const h = 400;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>${sheen('g', deep, mid)}</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    wovenGround(w, h, 'none' === deep ? mid : 'rgba(0,0,0,0)', '#ffffff', seed) +
    zariBand(w, h * 0.62, h * 0.26, deep, seed) +
    // scattered buti on the upper field
    Array.from({ length: 9 }, (_, i) =>
      buti(((i + 1) / 10) * w, h * 0.26 + (i % 2) * 26, 7, GOLD, 0.5),
    ).join('') +
    `</svg>`;
  return svgDataUri(svg);
}

/**
 * Square avatar — initials on a textile-tone disc with a fine gold ring.
 * Used for demo users' profile pictures.
 */
export function avatar(name: string): string {
  const seed = 'av|' + name;
  const [deep, mid] = palette(seed);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  const s = 240;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
    `<defs>${sheen('g', deep, mid)}</defs>` +
    `<rect width="${s}" height="${s}" fill="url(#g)"/>` +
    `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2 - 10}" fill="none" stroke="${GOLD}" stroke-width="4" opacity="0.85"/>` +
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Georgia, serif" ` +
    `font-size="96" fill="#FCF6E6" font-weight="600">${initials}</text>` +
    `</svg>`;
  return svgDataUri(svg);
}

/**
 * Company / storefront logo — a monogram in a gold-ringed roundel over a
 * woven ground, with a single paisley flourish. Square.
 */
export function logo(name: string): string {
  const seed = 'logo|' + name;
  const [deep, mid, gold] = palette(seed);
  const initials = name
    .replace(/[^A-Za-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  const s = 256;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
    `<rect width="${s}" height="${s}" rx="28" fill="${deep}"/>` +
    wovenGround(s, s, 'rgba(0,0,0,0)', mid, seed) +
    `<circle cx="${s / 2}" cy="${s / 2}" r="92" fill="${mid}" stroke="${gold}" stroke-width="5"/>` +
    paisley(s / 2, 54, 1.5, gold, 0.9) +
    `<text x="50%" y="54%" dy="0.32em" text-anchor="middle" font-family="Georgia, serif" ` +
    `font-size="84" fill="#FCF6E6" font-weight="700">${initials}</text>` +
    `</svg>`;
  return svgDataUri(svg);
}

/**
 * A portfolio / feed photo of finished embroidery work. Square-ish 3:2.
 * `label` is stitched along the bottom rail (e.g. "Bridal lehenga border").
 */
export function workPhoto(seed: string, label?: string): string {
  const [deep, mid, gold] = palette(seed);
  const r = rng(seed + '|work');
  const w = 900;
  const h = 600;
  const motifs: string[] = [];
  // a central paisley cluster
  for (let i = 0; i < 5; i += 1) {
    motifs.push(paisley(w / 2 + (i - 2) * 110, h / 2 - 20, 2.4 + r(), gold, 0.92));
  }
  // buti grid
  for (let gx = 90; gx < w - 60; gx += 120) {
    for (let gy = 70; gy < h - 140; gy += 120) {
      motifs.push(buti(gx, gy, 9, gold, 0.28 + r() * 0.2));
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>${sheen('g', deep, mid)}</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    wovenGround(w, h, 'rgba(0,0,0,0)', '#ffffff', seed) +
    motifs.join('') +
    zariBand(w, h - 90, 90, deep, seed) +
    (label
      ? `<text x="${w / 2}" y="${h - 30}" text-anchor="middle" font-family="Georgia, serif" font-size="34" ` +
        `fill="#FCF6E6">${escapeXml(label)}</text>`
      : '') +
    `</svg>`;
  return svgDataUri(svg);
}

/**
 * A product photo for a marketplace listing, themed by category so a
 * "thread cone" listing and a "saree" listing look different.
 */
export function productPhoto(category: string, seed: string): string {
  const [deep, mid, gold] = palette(seed);
  const w = 900;
  const h = 700;
  let subject = '';
  switch (category) {
    case 'raw-material':
      // stacked thread cones
      subject = [0, 1, 2, 3]
        .map((i) => {
          const x = 180 + i * 150;
          const c = pick(rng(seed + i), PALETTES)[1];
          return (
            `<polygon points="${x},520 ${x + 70},520 ${x + 50},300 ${x + 20},300" fill="${c}"/>` +
            `<ellipse cx="${x + 35}" cy="300" rx="15" ry="6" fill="${GOLD}"/>` +
            `<rect x="${x + 18}" y="430" width="34" height="70" fill="#fff" opacity="0.18"/>`
          );
        })
        .join('');
      break;
    case 'machinery':
      // an embroidery-machine head row
      subject = [0, 1, 2, 3, 4]
        .map((i) => {
          const x = 130 + i * 130;
          return (
            `<rect x="${x}" y="250" width="90" height="220" rx="8" fill="${mid}" stroke="${gold}" stroke-width="3"/>` +
            `<circle cx="${x + 45}" cy="300" r="22" fill="${deep}" stroke="${gold}" stroke-width="2"/>` +
            `<line x1="${x + 45}" y1="322" x2="${x + 45}" y2="470" stroke="${gold}" stroke-width="3"/>`
          );
        })
        .join('');
      break;
    case 'finished-goods':
    case 'embroidery-zari':
      // a folded sari stack with zari borders
      subject = [0, 1, 2]
        .map((i) => {
          const y = 250 + i * 90;
          const c = pick(rng(seed + 'sari' + i), PALETTES)[0];
          return (
            `<rect x="220" y="${y}" width="460" height="78" rx="6" fill="${c}"/>` +
            `<rect x="220" y="${y + 60}" width="460" height="14" fill="${GOLD}"/>` +
            paisley(260, y + 38, 1.0, GOLD, 0.9) +
            paisley(640, y + 38, 1.0, GOLD, 0.9)
          );
        })
        .join('');
      break;
    default:
      // generic bolt of fabric
      subject =
        `<rect x="200" y="250" width="500" height="240" rx="10" fill="${mid}"/>` +
        zariBand(500, 250, 60, deep, seed).replace('width="900"', 'width="500"');
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>${sheen('g', '#2A2622', '#3C352E')}</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<ellipse cx="${w / 2}" cy="560" rx="320" ry="40" fill="#000" opacity="0.25"/>` +
    subject +
    `</svg>`;
  return svgDataUri(svg);
}

/** A 16:9 video poster frame with a soft play glyph. */
export function videoPoster(seed: string, label?: string): string {
  const [deep, mid, gold] = palette(seed);
  const w = 1280;
  const h = 720;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>${sheen('g', deep, mid)}</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    wovenGround(w, h, 'rgba(0,0,0,0)', '#ffffff', seed) +
    Array.from({ length: 6 }, (_, i) => paisley(160 + i * 180, 200, 2.0, gold, 0.5)).join('') +
    `<circle cx="${w / 2}" cy="${h / 2}" r="74" fill="#000" opacity="0.35"/>` +
    `<polygon points="${w / 2 - 22},${h / 2 - 34} ${w / 2 - 22},${h / 2 + 34} ${w / 2 + 40},${h / 2}" fill="#FCF6E6"/>` +
    (label
      ? `<text x="${w / 2}" y="${h - 60}" text-anchor="middle" font-family="Georgia, serif" font-size="40" fill="#FCF6E6">${escapeXml(label)}</text>`
      : '') +
    `</svg>`;
  return svgDataUri(svg);
}

/** A document thumbnail (a page with ruled lines + a gold header band). */
export function documentThumb(title: string): string {
  const seed = 'doc|' + title;
  const [deep] = palette(seed);
  const w = 600;
  const h = 780;
  const lines = Array.from(
    { length: 14 },
    (_, i) =>
      `<rect x="70" y="${230 + i * 34}" width="${i % 4 === 3 ? 300 : 460}" height="10" rx="5" fill="#D9D4C7"/>`,
  ).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#F7F4EC"/>` +
    `<rect x="0" y="0" width="${w}" height="150" fill="${deep}"/>` +
    `<rect x="0" y="150" width="${w}" height="8" fill="${GOLD}"/>` +
    `<text x="70" y="95" font-family="Georgia, serif" font-size="40" fill="#FCF6E6">${escapeXml(
      title.slice(0, 22),
    )}</text>` +
    lines +
    `</svg>`;
  return svgDataUri(svg);
}

/* ────────────────────────────────────────────────────────────────────────
 * Audio / video binary stand-ins (tiny, valid, self-contained)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A valid, tiny silent WAV as a data URI — lets a voice post mount a real
 * <audio> element that seeks without erroring. The displayed length comes from
 * the post's `durationSec`, so the UI reads as a normal voice note.
 */
export function silentWavDataUri(): string {
  const sampleRate = 8000;
  const samples = 800; // 0.1s of silence
  const dataLen = samples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  // samples already zero (silence)
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

/**
 * Video URL for demo video posts. We keep a poster (always reliable) and an
 * optional real clip. If `CONNECT_DEMO_VIDEO_URL` is set we use it; otherwise
 * the video src falls back to the poster, so the card still renders a frame and
 * never shows a broken element.
 */
export function demoVideoUrl(posterUri: string): string {
  return process.env.CONNECT_DEMO_VIDEO_URL?.trim() || posterUri;
}

/* ────────────────────────────────────────────────────────────────────────
 * helpers
 * ──────────────────────────────────────────────────────────────────────── */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
