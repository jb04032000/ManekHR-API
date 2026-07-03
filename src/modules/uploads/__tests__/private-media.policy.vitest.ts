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
  const PRIVATE = [
    'connect-inbox-media',
    'connect-job-resume',
    'connect-job-voice',
    'erp-feedback-media',
  ] as const;

  it('marks exactly the chat + job-application categories private', () => {
    for (const c of PRIVATE) {
      expect(isPrivateCategory(c)).toBe(true);
      expect(resolveUploadPolicy(c).visibility).toBe('private');
    }
  });

  it('keeps every OTHER category public (incl. feed voice + ERP docs)', () => {
    const publicOnes = UPLOAD_CATEGORIES.filter((c) => !PRIVATE.includes(c as never));
    for (const c of publicOnes) {
      expect(isPrivateCategory(c)).toBe(false);
      // public categories never carry a visibility flag in the resolved policy
      expect(resolveUploadPolicy(c).visibility).toBeUndefined();
    }
    // explicit guard for the two we deliberately did NOT privatise
    expect(isPrivateCategory('connect-audio')).toBe(false); // feed voice stays public
    expect(isPrivateCategory('documents')).toBe(false); // ERP docs stay public
  });

  it('job-application private categories keep the same size/mime/duration limits they replaced', () => {
    expect(CATEGORY_POLICIES['connect-job-resume'].mimeTypes).toContain('application/pdf');
    expect(CATEGORY_POLICIES['connect-job-voice'].duration?.max).toBe(180);
  });
});

describe('private-media canonical ref helpers', () => {
  it('round-trips key <-> ref', () => {
    const key = 'connect-inbox-media/172-ab12.webm';
    const ref = toPrivateRef(key);
    expect(ref).toBe(`${PRIVATE_REF_SCHEME}${key}`);
    expect(isPrivateRef(ref)).toBe(true);
    expect(privateRefToKey(ref)).toBe(key);
  });

  it('does not mistake a public URL for a ref', () => {
    expect(isPrivateRef('https://cdn.test/connect-posts/x.jpg')).toBe(false);
    expect(privateRefToKey('https://cdn.test/x.jpg')).toBeNull();
  });
});

describe('migration decision function', () => {
  const opts = { publicBaseUrl: 'https://cdn.zari360.test' };

  it('migrates a public URL on our base to a canonical ref', () => {
    const d = decidePrivateMediaMigration(
      'https://cdn.zari360.test/connect-inbox-media/1-a.webm',
      opts,
    );
    expect(d.action).toBe('migrate');
    expect(d.objectKey).toBe('connect-inbox-media/1-a.webm');
    expect(d.newRef).toBe('r2-private://connect-inbox-media/1-a.webm');
  });

  it('is idempotent: skips a value already migrated', () => {
    const d = decidePrivateMediaMigration('r2-private://connect-inbox-media/1-a.webm', opts);
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
      'https://cdn.zari360.test/connect-job-resume/cv.pdf?v=2',
      opts,
    );
    expect(d.objectKey).toBe('connect-job-resume/cv.pdf');
  });
});

describe('local-dev signed-URL token', () => {
  const secret = 'unit-secret';
  const key = 'connect-inbox-media/1-a.webm';

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
      verifyLocalPrivateToken('connect-inbox-media/other.webm', exp, sig, secret, 1_000_000),
    ).toBe(false);
    expect(verifyLocalPrivateToken(key, exp, sig + '00', secret, 1_000_000)).toBe(false);
  });
});
