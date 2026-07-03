/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrivateMediaService } from '../services/private-media.service';

const ACCOUNT = 'acct123';
const PRIVATE_BUCKET = 'zari-private';

function build(provider: 'r2' | 'local' = 'local') {
  const configService: any = {
    get: vi.fn((key: string) => {
      if (key === 'storage.provider') return provider;
      if (key === 'storage.r2.accountId') return ACCOUNT;
      if (key === 'storage.r2.privateBucket') return PRIVATE_BUCKET;
      return undefined;
    }),
  };
  // Stub storage whose getSignedUrl echoes the ref so we can assert it was used.
  const storage: any = {
    getSignedUrl: vi.fn((ref: string) => Promise.resolve(`SIGNED(${ref})`)),
  };
  // Provider decides which stub the service picks; pass the same stub for both
  // and select with `provider` so the active one is `storage`.
  const svc = new PrivateMediaService(
    configService,
    provider === 'local' ? storage : ({} as any),
    provider === 'r2' ? storage : ({} as any),
  );
  return { svc, storage };
}

describe('PrivateMediaService.decorate / signMany', () => {
  let f: ReturnType<typeof build>;
  beforeEach(() => {
    f = build('local');
  });

  it('signs a private ref into a fresh URL', async () => {
    const ref = 'r2-private://connect-inbox-media/1-a.webm';
    await expect(f.svc.decorate(ref)).resolves.toBe(`SIGNED(${ref})`);
    expect(f.storage.getSignedUrl).toHaveBeenCalledWith(ref);
  });

  it('passes a public URL through untouched (never signs it)', async () => {
    const url = 'https://cdn.test/connect-posts/x.jpg';
    await expect(f.svc.decorate(url)).resolves.toBe(url);
    expect(f.storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it('passes null/empty through', async () => {
    await expect(f.svc.decorate(null)).resolves.toBeNull();
    await expect(f.svc.decorate(undefined)).resolves.toBeNull();
  });

  it('signMany dedups: one sign per distinct ref, public values ignored', async () => {
    const ref = 'r2-private://connect-inbox-media/dup.webm';
    const map = await f.svc.signMany([ref, ref, 'https://cdn.test/p.jpg', null]);
    expect(f.storage.getSignedUrl).toHaveBeenCalledTimes(1);
    expect(map.get(ref)).toBe(`SIGNED(${ref})`);
    expect(map.size).toBe(1);
  });

  it('degrades safe: a signing failure returns the raw ref, never throws', async () => {
    f.storage.getSignedUrl.mockRejectedValueOnce(new Error('r2 down'));
    const ref = 'r2-private://connect-inbox-media/x.webm';
    await expect(f.svc.decorate(ref)).resolves.toBe(ref);
  });
});

describe('PrivateMediaService.normalizeIncomingRef', () => {
  const { svc } = build('r2');

  it('leaves a canonical ref unchanged (idempotent)', () => {
    const ref = 'r2-private://connect-job-voice/x.webm';
    expect(svc.normalizeIncomingRef(ref)).toBe(ref);
  });

  it('leaves a public / foreign URL unchanged (validation handles it)', () => {
    expect(svc.normalizeIncomingRef('https://cdn.test/connect-posts/x.jpg')).toBe(
      'https://cdn.test/connect-posts/x.jpg',
    );
  });

  it('collapses a path-style R2 presigned URL back to the canonical ref', () => {
    const signed = `https://${ACCOUNT}.r2.cloudflarestorage.com/${PRIVATE_BUCKET}/connect-job-voice/x.webm?X-Amz-Signature=abc`;
    expect(svc.normalizeIncomingRef(signed)).toBe('r2-private://connect-job-voice/x.webm');
  });

  it('collapses a virtual-hosted R2 presigned URL (no bucket in path)', () => {
    const signed = `https://${ACCOUNT}.r2.cloudflarestorage.com/connect-job-voice/x.webm?X-Amz-Signature=abc`;
    expect(svc.normalizeIncomingRef(signed)).toBe('r2-private://connect-job-voice/x.webm');
  });

  it('collapses a local-dev signed URL (key in query)', () => {
    const localSvc = build('local').svc;
    const url =
      'http://localhost:3000/uploads/private-dev?key=connect-job-voice%2Fx.webm&exp=1&sig=deadbeef';
    expect(localSvc.normalizeIncomingRef(url)).toBe('r2-private://connect-job-voice/x.webm');
  });
});
