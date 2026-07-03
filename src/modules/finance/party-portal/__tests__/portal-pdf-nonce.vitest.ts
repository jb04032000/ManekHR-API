import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PortalPdfNonceService } from '../portal-pdf-nonce.service';

/**
 * Nonce service tests — uses an in-memory Redis stub injected via the
 * REDIS_CLIENT DI token (matches production wiring in RedisModule).
 */
class FakeRedis {
  private store = new Map<string, { v: string; exp: number }>();
  async setex(k: string, ttl: number, v: string) {
    this.store.set(k, { v, exp: Date.now() + ttl * 1000 });
    return 'OK';
  }
  async get(k: string) {
    const e = this.store.get(k);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this.store.delete(k);
      return null;
    }
    return e.v;
  }
  async set(k: string, v: string, _opt?: any) {
    const e = this.store.get(k);
    const exp = e?.exp ?? Date.now() + 900_000;
    this.store.set(k, { v, exp });
    return 'OK';
  }
}

const PORTAL_SECRET = 'unit-test-secret-32-bytes-1234567';

function makeCfg(): ConfigService {
  return {
    get: (key: string, fallback?: any) => {
      if (key === 'PORTAL_TOKEN_SECRET') return PORTAL_SECRET;
      return fallback;
    },
    getOrThrow: (key: string) => {
      if (key === 'PORTAL_TOKEN_SECRET') return PORTAL_SECRET;
      throw new Error(`missing ${key}`);
    },
  } as unknown as ConfigService;
}

describe('PortalPdfNonceService', () => {
  let svc: PortalPdfNonceService;
  const invoiceId = '507f1f77bcf86cd799439011';
  const partyId = '507f1f77bcf86cd799439012';

  beforeAll(() => {
    svc = new PortalPdfNonceService(makeCfg(), new FakeRedis() as any);
  });

  it('sign → consume happy path', async () => {
    const r = await svc.sign(invoiceId, partyId);
    expect(r.url).toMatch(/sig=[0-9a-f]+&exp=\d+&n=[0-9a-f-]+/);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const m = r.url.match(/sig=([0-9a-f]+)&exp=(\d+)&n=([0-9a-f-]+)/);
    if (!m) throw new Error('regex did not match');
    await expect(
      svc.consumeNonce(invoiceId, partyId, m[1], m[2], m[3]),
    ).resolves.toBeUndefined();
  });

  it('second use → 410 Gone', async () => {
    const r = await svc.sign(invoiceId, partyId);
    const m = r.url.match(/sig=([0-9a-f]+)&exp=(\d+)&n=([0-9a-f-]+)/)!;
    await svc.consumeNonce(invoiceId, partyId, m[1], m[2], m[3]);
    await expect(
      svc.consumeNonce(invoiceId, partyId, m[1], m[2], m[3]),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('tampered sig → 401', async () => {
    const r = await svc.sign(invoiceId, partyId);
    const m = r.url.match(/sig=([0-9a-f]+)&exp=(\d+)&n=([0-9a-f-]+)/)!;
    const bad = 'f'.repeat(m[1].length);
    await expect(
      svc.consumeNonce(invoiceId, partyId, bad, m[2], m[3]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('past exp → 401', async () => {
    // Construct expired URL by hand: sign normally, then re-call with past exp.
    const r = await svc.sign(invoiceId, partyId);
    const m = r.url.match(/sig=([0-9a-f]+)&exp=(\d+)&n=([0-9a-f-]+)/)!;
    const pastExp = String(Math.floor(Date.now() / 1000) - 60);
    await expect(
      svc.consumeNonce(invoiceId, partyId, m[1], pastExp, m[3]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
