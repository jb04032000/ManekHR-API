/**
 * Upload policies — per-category file size + MIME-type limits.
 *
 * Layered as: global → per-category → (future) per-plan-tier override.
 * The resolver returns the *effective* policy by walking that cascade:
 * effective size = min of every layer's `maxBytes`; effective MIME list =
 * intersection of every layer's `mimeTypes` (or the most specific layer
 * when an inner layer is set).
 *
 * Why config-as-code (not DB-backed):
 *  - O(1) read, zero cache layer, zero ops surface.
 *  - The limits are domain-bound (a banner photo is a banner photo regardless
 *    of tenant); when product calls for per-tenant tuning, the resolver gets
 *    a DB-override layer added below `PLAN_OVERRIDES` and consumers don't
 *    change.
 *  - The category set is small + stable. Frequent live-tuning isn't expected.
 *
 * **Plan-tier overrides** are scaffolded but unwired this pass — the resolver
 * accepts `plan?: PlanTier` and the `PLAN_OVERRIDES` map is empty. The next
 * subscription-tier work fills it without touching call sites.
 *
 * **Per-workspace storage budget** (hard cap on aggregate `Workspace.storageUsage.bytes`)
 * is a different mechanism, deferred to the same subscription-tier work item.
 */

/** Allowed category names. Must match `validateCategory`'s allow-list. */
export const UPLOAD_CATEGORIES = [
  // Identity / account
  'avatars',
  // ERP-side
  'proofs',
  'passbooks',
  'qrcodes',
  'profiles',
  'branding',
  'documents',
  // ERP — Feedback widget photo attachments (private). Image-only, 1600px WebP
  // compressed client-side, lands on the PRIVATE bucket (a feedback screenshot
  // may show another user's data, so it is never world-readable; read paths sign
  // it via PrivateMediaService). Links to: src/modules/feedback.
  'erp-feedback-media',
] as const;

export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

/**
 * Image-specific constraints. Optional; only applied when the uploaded file
 * is an image (MIME prefix `image/`).
 */
export interface ImagePolicy {
  /** Minimum width in pixels. */
  minWidth?: number;
  /** Minimum height in pixels. */
  minHeight?: number;
  /** Maximum width in pixels. */
  maxWidth?: number;
  /** Maximum height in pixels. */
  maxHeight?: number;
  /**
   * Expected aspect ratio (width / height) with a tolerance band. e.g.
   * `{ ratio: 4, tolerance: 0.5 }` accepts a 4:1 banner with ±50% tolerance
   * (so 2:1 → 6:1 all pass). Strict squares: `{ ratio: 1, tolerance: 0.2 }`.
   *
   * Enforced SERVER-SIDE in `media-probe.ts` (header-only dimension read via
   * `image-size`, no `sharp` / decode), alongside the global edge + megapixel
   * decompression-bomb ceilings, plus the size + MIME hard cap. The FE
   * accept-attr + pre-check remain the friendly first line of defence.
   */
  aspectRatio?: { ratio: number; tolerance: number };
}

/** Duration constraint for audio / video uploads (seconds). */
export interface DurationPolicy {
  max: number;
}

/**
 * Client-side compression target. When set on a category's policy, the
 * web `uploadService` downscales + re-encodes the file in the browser
 * before posting. Backend is unaware of compression — it only sees the
 * already-shrunk bytes and applies the regular size/MIME guard. Documents
 * + audio + video categories OMIT this; only raster-image categories
 * (avatar, banner, portfolio, post photos) opt in.
 */
export interface CompressionPolicy {
  /** Resize so neither dimension exceeds these (preserves aspect). */
  maxWidth: number;
  maxHeight: number;
  /** Encoder quality 0–1 (JPEG / WebP). 0.85 is a good default. */
  quality: number;
  /** Target encoding. WebP for smaller payloads; falls back to JPEG. */
  format: 'image/webp' | 'image/jpeg';
}

/**
 * Storage visibility for a category.
 *  - `public`  — object lands on the world-readable public bucket and the upload
 *    response carries a permanent public URL (feed, products, profiles, ERP docs).
 *  - `private` — object lands on the PRIVATE bucket; the upload response + every
 *    stored reference is a canonical `r2-private://<key>` ref, never a public URL,
 *    and read paths mint a short-lived signed URL on the fly (chat + job-application
 *    files). See `r2-storage.service.ts` (presign) + `PrivateMediaService` (decorate).
 */
export type StorageVisibility = 'public' | 'private';

/** Per-category policy. */
export interface UploadPolicy {
  /** Hard byte cap for a single file. */
  maxBytes: number;
  /**
   * Where the object is stored + how it is served. Omitted = `public`
   * (the default for every legacy category — only the private categories below
   * opt in). Drives the storage adapter's bucket choice at upload time and the
   * canonical-ref-vs-public-URL decision.
   */
  visibility?: StorageVisibility;
  /**
   * Allowed MIME types. Full type ('image/jpeg') or wildcard ('image/*').
   * The resolver intersects layered lists when present.
   */
  mimeTypes: readonly string[];
  /** Optional image guards (enforced server-side in `media-probe.ts` + FE). */
  image?: ImagePolicy;
  /** Optional duration cap (enforced server-side in `media-probe.ts` + FE). */
  duration?: DurationPolicy;
  /** Optional FE-side compression target (image categories only). */
  compression?: CompressionPolicy;
}

/** Plan tiers — mirrors `subscriptions` module enum for future override layer. */
export type PlanTier = 'free' | 'starter' | 'pro' | 'enterprise';

const KB = 1024;
const MB = 1024 * KB;

/* ── MIME presets ─────────────────────────────────────────────────────── */

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const AUDIO_MIME = ['audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'] as const;
const VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
const PDF_MIME = ['application/pdf'] as const;
const DOC_MIME = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/* ── Global default ───────────────────────────────────────────────────── */

/**
 * Absolute floor — every upload must satisfy this even if a category sets
 * something looser. The category list is the union of every other policy's
 * MIME list so the global never silently denies something a category allows.
 */
const GLOBAL_POLICY: UploadPolicy = {
  maxBytes: 50 * MB,
  mimeTypes: [...IMAGE_MIME, ...AUDIO_MIME, ...VIDEO_MIME, ...DOC_MIME],
};

/* ── Per-category policies ────────────────────────────────────────────── */

export const CATEGORY_POLICIES: Record<UploadCategory, UploadPolicy> = {
  // Identity — avatars are small, square. Logos/avatars never need more than
  // an 800px edge for any display surface, so compress hard (client-side).
  avatars: {
    maxBytes: 1 * MB,
    mimeTypes: IMAGE_MIME,
    image: { aspectRatio: { ratio: 1, tolerance: 0.3 } },
    compression: { maxWidth: 800, maxHeight: 800, quality: 0.82, format: 'image/webp' },
  },

  // ERP — operational documents.
  proofs: { maxBytes: 5 * MB, mimeTypes: [...IMAGE_MIME, ...PDF_MIME] },
  passbooks: { maxBytes: 5 * MB, mimeTypes: [...IMAGE_MIME, ...PDF_MIME] },
  qrcodes: { maxBytes: 1 * MB, mimeTypes: IMAGE_MIME },
  profiles: { maxBytes: 5 * MB, mimeTypes: IMAGE_MIME },
  branding: { maxBytes: 5 * MB, mimeTypes: IMAGE_MIME },
  documents: { maxBytes: 10 * MB, mimeTypes: DOC_MIME },

  // ERP — Feedback widget photo attachments. Image-only, 5MB cap, 1600px WebP
  // compression client-side (a feedback screenshot does not need full res).
  // PRIVATE — a screenshot can contain another user's data; the upload response
  // is a canonical `r2-private://` ref and read paths mint a 1-hour signed URL
  // via PrivateMediaService. The 3-attachment
  // cap is enforced by the feedback DTO (ArrayMaxSize), not here (per-file policy).
  'erp-feedback-media': {
    maxBytes: 5 * MB,
    mimeTypes: IMAGE_MIME,
    compression: { maxWidth: 1600, maxHeight: 1600, quality: 0.82, format: 'image/webp' },
    visibility: 'private',
  },
};

/**
 * True when a category's effective policy stores its objects on the PRIVATE
 * bucket. The single source of truth consulted by the upload path (to pick the
 * bucket) and anywhere that needs to know whether a stored ref is a canonical
 * private ref vs a public URL. Defaults to public for any category that omits
 * `visibility`.
 */
export function isPrivateCategory(category: UploadCategory): boolean {
  return CATEGORY_POLICIES[category]?.visibility === 'private';
}

/**
 * **Compression presets — WIRED (2026-06-11).** Image categories now carry a
 * per-category `compression` target consumed by the web `uploadService`
 * (`crewroster-web/lib/services/image-compress.ts`). Backend stays unaware of
 * compression — it only ever sees the already-shrunk bytes and applies the
 * usual size/MIME/dimension guards.
 *
 * Current targets:
 *  - default 1600px WebP q0.82.
 *  -  800px — `avatars` (logos / small identity images).
 *  - ERP categories (proofs / passbooks / qrcodes / profiles / branding) and all
 *    document / audio / video categories OMIT compression on purpose — lossy
 *    re-encoding would harm QR scannability + financial-evidence legibility.
 *
 * Per-tier presets (free = tight, paid = looser / disabled) can later land via
 * `PLAN_OVERRIDES` below without touching call sites — the resolver already
 * honours a `compression: null` "disable" sentinel.
 *
 * ── SINGLE SOURCE OF TRUTH ────────────────────────────────────────────────
 * THIS FILE is the only hand-edited copy. The web mirror
 * (`crewroster-web/lib/upload-policies.ts`) is GENERATED, never hand-edited.
 * After changing any policy here:
 *   1. `cd crewroster-backend && npm run export:upload-policies`
 *        → regenerates the committed `upload-policies.generated.json` artifact.
 *   2. `cd crewroster-web && npm run sync:upload-policies`
 *        → regenerates `crewroster-web/lib/upload-policies.ts` from that JSON.
 *   3. Commit all three files together (this TS + the JSON + the web mirror).
 * A backend test (`__tests__/upload-policies.generated.vitest.ts`) fails CI if
 * the JSON is stale vs this file; a web test fails if the mirror drifts from
 * the JSON. So the two can never silently diverge.
 */

/* ── Plan-tier overrides (scaffold) ──────────────────────────────────── */

/**
 * Per-plan-tier overrides for specific categories. **Intentionally empty
 * until the subscription / plan-tier work lands** — the structure + types
 * + resolver merge are wired so plugging in is a one-block change.
 *
 * Each leaf accepts the full `Partial<UploadPolicy>` shape — anything
 * declared overrides the category default; anything omitted inherits.
 *
 * **Compression override semantics:**
 *  - `compression: undefined` (key absent) → inherit the category's
 *    compression policy.
 *  - `compression: null` → explicit "no compression" — file uploads raw
 *    (paid-tier full-quality path).
 *  - `compression: { ... }` → override with a different preset.
 *
 * Reference shape for future implementation:
 *
 *   pro: {
 *     avatars: { maxBytes: 3 * MB, compression: { ...higher quality... } },
 *   },
 *   enterprise: {
 *     avatars: { maxBytes: 5 * MB, compression: null },
 *   },
 */
// Exported so the codegen script (`scripts/export-upload-policies.ts`) can
// serialize it into the committed `upload-policies.generated.json` artifact that
// the web mirror is generated from. Keep it a plain data object (no functions)
// so it round-trips through JSON.
export const PLAN_OVERRIDES: Partial<
  Record<PlanTier, Partial<Record<UploadCategory, PlanLayerPolicy>>>
> = {};

/**
 * Plan-layer policy — same shape as `Partial<UploadPolicy>` plus the
 * `compression: null` sentinel meaning "explicitly disable for this
 * tier". `undefined` (key omitted) still means "inherit category".
 */
type PlanLayerPolicy = Omit<Partial<UploadPolicy>, 'compression'> & {
  compression?: CompressionPolicy | null;
};

/* ── Resolver ─────────────────────────────────────────────────────────── */

/**
 * Resolve the *effective* policy for a category, optionally narrowed by
 * the caller's plan tier. Cascades:
 *
 *   global  ←  category  ←  plan-tier-override
 *
 * Size: `min` across all layers.
 * MIME: intersection across all layers (or the most-specific list when
 *       only one layer specifies). A layer setting `mimeTypes: []` is
 *       treated as "inherit", not "deny all".
 * Image/duration: most-specific layer wins (plan > category).
 */
export function resolveUploadPolicy(category: UploadCategory, plan?: PlanTier): UploadPolicy {
  const cat = CATEGORY_POLICIES[category];
  const planLayer = plan ? (PLAN_OVERRIDES[plan]?.[category] ?? null) : null;

  // Plan REPLACES category for each field when set (paid tiers can RAISE
  // limits above the free default — earlier we min'd across all layers,
  // which clamped a pro avatar at the free 1MB cap because the cat was
  // tighter). Global cap remains an absolute hard floor — no plan can
  // exceed it.
  const baseMax = planLayer?.maxBytes ?? cat.maxBytes;
  const maxBytes = Math.min(GLOBAL_POLICY.maxBytes, baseMax);

  // MIME — plan can replace; otherwise category; otherwise global.
  // Intersection with global keeps the overall allow-list authoritative.
  const baseMimes = planLayer?.mimeTypes ?? cat.mimeTypes;
  const mimeTypes = baseMimes.filter((m) => GLOBAL_POLICY.mimeTypes.includes(m));

  // Image / duration — most-specific layer wins.
  const image = planLayer?.image ?? cat.image;
  const duration = planLayer?.duration ?? cat.duration;

  // Compression — plan layer can explicitly disable via `null`, override
  // via an object, or omit (key absent → inherit category). `'compression'
  // in planLayer` distinguishes "explicit null" from "key omitted".
  let compression: CompressionPolicy | undefined;
  if (planLayer && 'compression' in planLayer) {
    compression = planLayer.compression ?? undefined;
  } else {
    compression = cat.compression;
  }

  const out: UploadPolicy = { maxBytes, mimeTypes };
  if (image) out.image = image;
  if (duration) out.duration = duration;
  if (compression) out.compression = compression;
  // Visibility is a fixed storage property of the category (never plan-tuned).
  if (cat.visibility) out.visibility = cat.visibility;
  return out;
}

/* ── Validation ───────────────────────────────────────────────────────── */

export interface UploadFileLike {
  size: number;
  mimetype: string;
}

export interface PolicyViolation {
  reason: 'size' | 'mime' | 'missing';
  message: string;
}

/**
 * Pure validator: returns null when the file passes, or a structured
 * violation when it fails. The service translates this into a 413 / 415
 * `BadRequestException` with a human message.
 */
export function checkUploadPolicy(
  file: UploadFileLike | undefined | null,
  policy: UploadPolicy,
): PolicyViolation | null {
  if (!file) return { reason: 'missing', message: 'No file provided' };

  if (file.size > policy.maxBytes) {
    const cap = Math.round(policy.maxBytes / MB);
    return {
      reason: 'size',
      message: `File size exceeds the limit of ${cap} MB for this upload.`,
    };
  }

  // MIME matching honors wildcards ('image/*').
  const allowed = policy.mimeTypes.some((pattern) => {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      return file.mimetype.startsWith(prefix);
    }
    return pattern === file.mimetype;
  });
  if (!allowed) {
    return {
      reason: 'mime',
      message: `File type ${file.mimetype} is not allowed for this upload.`,
    };
  }

  return null;
}
