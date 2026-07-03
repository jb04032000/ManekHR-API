/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InternalServerErrorException } from '@nestjs/common';

// ── AWS SDK mocks: capture command inputs + a send spy ───────────────────────
const sendSpy = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: sendSpy })),
  PutObjectCommand: vi.fn((input: any) => ({ __type: 'Put', input })),
  DeleteObjectCommand: vi.fn((input: any) => ({ __type: 'Delete', input })),
  GetObjectCommand: vi.fn((input: any) => ({ __type: 'Get', input })),
}));
const getSignedUrlMock = vi.fn().mockResolvedValue('https://signed.example/url?X-Amz=1');
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: any[]) => getSignedUrlMock(...args),
}));

import { R2StorageService } from '../services/r2-storage.service';

const PUBLIC_URL = 'https://cdn.zari360.test';
const PUBLIC_BUCKET = 'zari-public';
const PRIVATE_BUCKET = 'zari-private';

function buildConfig(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    'storage.r2.accountId': 'acct',
    'storage.r2.bucket': PUBLIC_BUCKET,
    'storage.r2.privateBucket': PRIVATE_BUCKET,
    'storage.r2.publicUrl': PUBLIC_URL,
    'storage.r2.accessKeyId': 'ak',
    'storage.r2.secretAccessKey': 'sk',
    ...overrides,
  };
  return { get: vi.fn((k: string) => base[k]) } as any;
}

const file = (name = 'cv.pdf') => ({
  originalname: name,
  buffer: Buffer.from('hello'),
  size: 5,
  mimetype: 'application/pdf',
});

describe('R2StorageService private bucket', () => {
  beforeEach(() => {
    sendSpy.mockClear();
    getSignedUrlMock.mockClear();
  });

  it('private upload stores on the PRIVATE bucket and returns a canonical ref (no public URL)', async () => {
    const svc = new R2StorageService(buildConfig());
    const res = await svc.uploadFile(file(), 'connect-job-resume', 'private');

    expect(res.url.startsWith('r2-private://connect-job-resume/')).toBe(true);
    expect(res.url).not.toContain(PUBLIC_URL); // never a public URL
    const putInput = sendSpy.mock.calls[0][0].input;
    expect(putInput.Bucket).toBe(PRIVATE_BUCKET);
  });

  it('public upload is byte-for-byte unchanged (public bucket + permanent URL)', async () => {
    const svc = new R2StorageService(buildConfig());
    const res = await svc.uploadFile(file('p.jpg'), 'connect-posts', 'public');

    expect(res.url.startsWith(`${PUBLIC_URL}/connect-posts/`)).toBe(true);
    const putInput = sendSpy.mock.calls[0][0].input;
    expect(putInput.Bucket).toBe(PUBLIC_BUCKET);
  });

  it('public upload carries a one-year immutable Cache-Control (unique names => safe)', async () => {
    const svc = new R2StorageService(buildConfig());
    await svc.uploadFile(file('p.jpg'), 'connect-posts', 'public');
    const putInput = sendSpy.mock.calls[0][0].input;
    expect(putInput.CacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('private upload carries a short private Cache-Control matching the 1h signed-URL TTL', async () => {
    const svc = new R2StorageService(buildConfig());
    await svc.uploadFile(file(), 'connect-job-resume', 'private');
    const putInput = sendSpy.mock.calls[0][0].input;
    expect(putInput.CacheControl).toBe('private, max-age=3600');
  });

  it('defaults to public when visibility is omitted (back-compat for legacy callers)', async () => {
    const svc = new R2StorageService(buildConfig());
    const res = await svc.uploadFile(file('a.jpg'), 'avatars');
    expect(res.url.startsWith(PUBLIC_URL)).toBe(true);
  });

  it('FAILS LOUDLY (no public fallback) when the private bucket is not configured', async () => {
    const svc = new R2StorageService(buildConfig({ 'storage.r2.privateBucket': '' }));
    await expect(svc.uploadFile(file(), 'connect-job-resume', 'private')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(sendSpy).not.toHaveBeenCalled(); // nothing was stored anywhere
  });

  it('deletes a canonical ref from the private bucket by key', async () => {
    const svc = new R2StorageService(buildConfig());
    await svc.deleteFile('r2-private://connect-inbox-media/1-a.webm');
    const delInput = sendSpy.mock.calls[0][0].input;
    expect(delInput.Bucket).toBe(PRIVATE_BUCKET);
    expect(delInput.Key).toBe('connect-inbox-media/1-a.webm');
  });

  it('deletes a public URL from the public bucket by stripped key', async () => {
    const svc = new R2StorageService(buildConfig());
    await svc.deleteFile(`${PUBLIC_URL}/connect-posts/x.jpg`);
    const delInput = sendSpy.mock.calls[0][0].input;
    expect(delInput.Bucket).toBe(PUBLIC_BUCKET);
    expect(delInput.Key).toBe('connect-posts/x.jpg');
  });

  it('signs a private ref via a presigned GET on the private bucket', async () => {
    const svc = new R2StorageService(buildConfig());
    const url = await svc.getSignedUrl('r2-private://connect-job-voice/v.webm');
    expect(url).toBe('https://signed.example/url?X-Amz=1');
    // presigner called with the GetObjectCommand for the private bucket + 1h TTL
    const [, command, opts] = getSignedUrlMock.mock.calls[0];
    expect(command.input.Bucket).toBe(PRIVATE_BUCKET);
    expect(command.input.Key).toBe('connect-job-voice/v.webm');
    expect(opts.expiresIn).toBe(3600);
  });

  it('refuses to sign a non-private value', async () => {
    const svc = new R2StorageService(buildConfig());
    await expect(svc.getSignedUrl('https://cdn.zari360.test/x.jpg')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
