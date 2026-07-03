import { describe, it, expect } from 'vitest';
import {
  CATEGORY_POLICIES,
  isPrivateCategory,
  resolveUploadPolicy,
  UPLOAD_CATEGORIES,
} from '../upload-policies';
import { decidePrivateMediaMigration } from '../private-media.migration';
import {
  isPrivateRef,
  toPrivateRef,
  privateRefToKey,
  PRIVATE_REF_SCHEME,
} from '../private-media.ref';
import { signLocalPrivateKey, verifyLocalPrivateToken } from '../local-private-url';

describe('upload-policies visibility', () => {
  const PRIVATE = ['erp-feedback-media'] as const;

  it('marks exactly the feedback-attachment category private', () => {
    for (const c of PRIVATE) {
      expect(isPrivateCategory(c)).toBe(true);
      expect(resolveUploadPolicy(c).visibility).toBe('private');
    }
  });

  it('keeps every OTHER category public (incl. ERP docs)', () => {
    const publicOnes = UPLOAD_CATEGORIES.filter((c) => !PRIVATE.includes(c as never));
    for (const c of publicOnes) {
      expect(isPrivateCategory(c)).toBe(false);
      // public categories never carry a visibility flag in the resolved policy
      expect(resolveUploadPolicy(c).visibility).toBeUndefined();
    }
    // explicit guard for one we deliberately did NOT privatise
    expect(isPrivateCategory('documents')).toBe(false); // ERP docs stay public
  });

  it('the private category keeps its image-only mime list', () => {
    expect(CATEGORY_POLICIES['erp-feedback-media'].mimeTypes).toContain('image/webp');
    expect(CATEGORY_POLICIES['erp-feedback-media'].mimeTypes).not.toContain('application/pdf');
  });
});

describe('private-media canonical ref helpers', () => {
  it('round-trips key <-> ref', () => {
    const key = 'erp-feedback-media/172-ab12.webp';
    const ref = toPrivateRef(key);
    expect(ref).toBe(`${PRIVATE_REF_SCHEME}${key}`);
    expect(isPrivateRef(ref)).toBe(true);
    expect(privateRefToKey(ref)).toBe(key);
  });

  it('does not mistake a public URL for a ref', () => {
    expect(isPrivateRef('https://cdn.test/profiles/x.jpg')).toBe(false);
    expect(privateRefToKey('https://cdn.test/x.jpg')).toBeNull();
  });
});

describe('migration decision function', () => {
  const opts = { publicBaseUrl: 'https://cdn.zari360.test' };

  it('migrates a public URL on our base to a canonical ref', () => {
    const d = decidePrivateMediaMigration(
      'https://cdn.zari360.test/erp-feedback-media/1-a.webp',
      opts,
    );
    expect(d.action).toBe('migrate');
    expect(d.objectKey).toBe('erp-feedback-media/1-a.webp');
    expect(d.newRef).toBe('r2-private://erp-feedback-media/1-a.webp');
  });

  it('is idempotent: skips a value already migrated', () => {
    const d = decidePrivateMediaMigration('r2-private://erp-feedback-media/1-a.webp', opts);
    expect(d.action).toBe('skip-already-private');
  });

  it('skips empty / null values', () => {
    expect(decidePrivateMediaMigration(null, opts).action).toBe('skip-empty');
    expect(decidePrivateMediaMigration('', opts).action).toBe('skip-empty');
  });

  it('never touches an offsite URL', () => {
    expect(decidePrivateMediaMigration('https://evil.test/x.webm', opts).action).toBe(
      'skip-foreign',
    );
  });

  it('strips a query string when deriving the object key', () => {
    const d = decidePrivateMediaMigration(
      'https://cdn.zari360.test/erp-feedback-media/shot.webp?v=2',
      opts,
    );
    expect(d.objectKey).toBe('erp-feedback-media/shot.webp');
  });
});

describe('local-dev signed-URL token', () => {
  const secret = 'unit-secret';
  const key = 'erp-feedback-media/1-a.webp';

  it('a freshly minted token verifies', () => {
    const { exp, sig } = signLocalPrivateKey(key, secret, 1_000_000);
    expect(verifyLocalPrivateToken(key, exp, sig, secret, 1_000_000)).toBe(true);
  });

  it('rejects an expired token (1h TTL)', () => {
    const { exp, sig } = signLocalPrivateKey(key, secret, 1_000_000);
    // 2 hours later
    expect(verifyLocalPrivateToken(key, exp, sig, secret, 1_000_000 + 2 * 3600 * 1000)).toBe(false);
  });

  it('rejects a tampered key or signature', () => {
    const { exp, sig } = signLocalPrivateKey(key, secret, 1_000_000);
    expect(
      verifyLocalPrivateToken('erp-feedback-media/other.webp', exp, sig, secret, 1_000_000),
    ).toBe(false);
    expect(verifyLocalPrivateToken(key, exp, sig + '00', secret, 1_000_000)).toBe(false);
  });
});
