import { describe, expect, it } from 'vitest';
import { CATEGORY_POLICIES, checkUploadPolicy, resolveUploadPolicy } from '../upload-policies';

const MB = 1024 * 1024;

describe('resolveUploadPolicy', () => {
  it('returns the category policy when no plan is passed', () => {
    const p = resolveUploadPolicy('avatars');
    expect(p.maxBytes).toBe(CATEGORY_POLICIES.avatars.maxBytes);
    expect(p.mimeTypes).toContain('image/jpeg');
    expect(p.image?.aspectRatio?.ratio).toBe(1);
  });

  it('uses the tighter of (global, category) for size', () => {
    // connect-audio is 10MB; global is 50MB; effective = 10MB.
    expect(resolveUploadPolicy('connect-audio').maxBytes).toBe(10 * MB);
  });

  it('intersects MIME lists across layers', () => {
    // avatars policy is image-only; the global allows image/video/audio/doc.
    // Effective = image-only.
    const types = resolveUploadPolicy('avatars').mimeTypes;
    expect(types).toEqual(expect.arrayContaining(['image/jpeg', 'image/png']));
    expect(types).not.toContain('video/mp4');
    expect(types).not.toContain('audio/mpeg');
  });

  it('preserves the duration cap on connect-audio', () => {
    expect(resolveUploadPolicy('connect-audio').duration?.max).toBe(180);
  });

  it('caps marketplace product video at 60s, video-only, 50MB, no compression', () => {
    const p = resolveUploadPolicy('connect-product-video');
    expect(p.duration?.max).toBe(60);
    expect(p.maxBytes).toBe(50 * MB);
    expect(p.mimeTypes).toEqual(
      expect.arrayContaining(['video/mp4', 'video/webm', 'video/quicktime']),
    );
    expect(p.mimeTypes).not.toContain('image/jpeg');
    // Video passes through untouched (compression is image-only).
    expect(p.compression).toBeUndefined();
  });

  it('preserves the aspect-ratio guard on connect-banners', () => {
    const p = resolveUploadPolicy('connect-banners');
    expect(p.image?.aspectRatio?.ratio).toBe(4);
  });

  it('returns the category default when no plan override exists', () => {
    // PLAN_OVERRIDES is empty for now — every tier resolves to the
    // category default. Forward-compat check: when a tier-aware
    // compression preset lands later, this test will need updating.
    const noPlan = resolveUploadPolicy('avatars');
    expect(resolveUploadPolicy('avatars', 'free')).toEqual(noPlan);
    expect(resolveUploadPolicy('avatars', 'pro')).toEqual(noPlan);
    expect(resolveUploadPolicy('avatars', 'enterprise')).toEqual(noPlan);
  });
});

describe('compression targets (FE-consumed, mirrored to crewroster-web)', () => {
  it('applies the 1600px WebP default to feed/listing + portfolio/RFQ images', () => {
    for (const cat of ['connect-posts', 'connect-portfolio'] as const) {
      const c = resolveUploadPolicy(cat).compression;
      expect(c).toEqual({ maxWidth: 1600, maxHeight: 1600, quality: 0.82, format: 'image/webp' });
    }
  });

  it('allows banners a wider 2400px edge', () => {
    expect(resolveUploadPolicy('connect-banners').compression?.maxWidth).toBe(2400);
  });

  it('compresses avatars/logos hard (800px)', () => {
    expect(resolveUploadPolicy('avatars').compression?.maxWidth).toBe(800);
  });

  it('leaves ERP evidence + document/audio categories uncompressed', () => {
    for (const cat of ['proofs', 'passbooks', 'qrcodes', 'documents', 'connect-audio'] as const) {
      expect(resolveUploadPolicy(cat).compression).toBeUndefined();
    }
  });
});

describe('checkUploadPolicy', () => {
  const avatarPolicy = resolveUploadPolicy('avatars');

  it('returns null for a valid JPEG within the avatar cap', () => {
    const file = { size: 1 * MB, mimetype: 'image/jpeg' };
    expect(checkUploadPolicy(file, avatarPolicy)).toBeNull();
  });

  it('rejects an oversize file with reason=size', () => {
    const file = { size: 5 * MB, mimetype: 'image/jpeg' };
    const v = checkUploadPolicy(file, avatarPolicy);
    expect(v).not.toBeNull();
    expect(v?.reason).toBe('size');
    expect(v?.message).toMatch(/1 MB/);
  });

  it('rejects a wrong MIME with reason=mime', () => {
    const file = { size: 100 * 1024, mimetype: 'video/mp4' };
    const v = checkUploadPolicy(file, avatarPolicy);
    expect(v).not.toBeNull();
    expect(v?.reason).toBe('mime');
  });

  it('returns reason=missing when no file is provided', () => {
    expect(checkUploadPolicy(undefined, avatarPolicy)?.reason).toBe('missing');
    expect(checkUploadPolicy(null, avatarPolicy)?.reason).toBe('missing');
  });

  it('matches wildcard MIME patterns ("image/*")', () => {
    const wildcard = { maxBytes: 5 * MB, mimeTypes: ['image/*'] };
    expect(checkUploadPolicy({ size: 1, mimetype: 'image/avif' }, wildcard)).toBeNull();
    expect(checkUploadPolicy({ size: 1, mimetype: 'video/mp4' }, wildcard)?.reason).toBe('mime');
  });
});
