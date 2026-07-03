/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing HealthService so the
// @InjectConnection() parameter decorator is a no-op under vitest's transform
// (mirrors the established pattern in auth.service.audit.vitest.ts). The
// Connection is supplied as a plain mock — Mongoose is never really used here.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    InjectConnection: () => noop(),
    InjectModel: () => () => noop(),
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  };
});

import { HealthService } from '../health.service';

// A Mongoose-Connection-shaped mock. readyState 1 = connected; db.command is
// the active ping we race against the probe timeout.
function mockConnection(opts: {
  readyState?: number;
  command?: () => Promise<unknown>;
  noDb?: boolean;
}): any {
  return {
    readyState: opts.readyState ?? 1,
    db: opts.noDb ? undefined : { command: opts.command ?? (() => Promise.resolve({ ok: 1 })) },
  };
}

// An ioredis-shaped mock — only ping() is exercised by the health probe.
function mockRedis(ping: () => Promise<unknown>): any {
  return { ping };
}

describe('HealthService', () => {
  describe('liveness', () => {
    it('always reports ok with process metadata (never touches DB/Redis)', () => {
      const conn = mockConnection({
        readyState: 0, // even if DB is down, liveness must still be ok
        command: () => Promise.reject(new Error('db down')),
      });
      const redis = mockRedis(() => Promise.reject(new Error('redis down')));
      const svc = new HealthService(conn, redis);

      const res = svc.liveness();

      expect(res.status).toBe('ok');
      expect(typeof res.uptimeSec).toBe('number');
      expect(res.uptimeSec).toBeGreaterThanOrEqual(0);
      expect(typeof res.timestamp).toBe('string');
      expect(() => new Date(res.timestamp).toISOString()).not.toThrow();
      expect(typeof res.processRole).toBe('string');
      expect(typeof res.version).toBe('string');
    });
  });

  describe('readiness', () => {
    it('reports ok when Mongo and Redis are both reachable', async () => {
      const conn = mockConnection({ readyState: 1 });
      const redis = mockRedis(() => Promise.resolve('PONG'));
      const svc = new HealthService(conn, redis);

      const res = await svc.readiness();

      expect(res.status).toBe('ok');
      expect(res.checks.mongo.status).toBe('up');
      expect(res.checks.redis.status).toBe('up');
      expect(res.checks.mongo.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.checks.redis.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports error with mongo down when the connection is not in the connected state', async () => {
      const conn = mockConnection({ readyState: 2 }); // 2 = connecting
      const redis = mockRedis(() => Promise.resolve('PONG'));
      const svc = new HealthService(conn, redis);

      const res = await svc.readiness();

      expect(res.status).toBe('error');
      expect(res.checks.mongo.status).toBe('down');
      expect(res.checks.mongo.error).toContain('2');
      // Redis is still probed independently and stays up.
      expect(res.checks.redis.status).toBe('up');
    });

    it('reports mongo down when the ping command rejects', async () => {
      const conn = mockConnection({
        readyState: 1,
        command: () => Promise.reject(new Error('not authorized')),
      });
      const redis = mockRedis(() => Promise.resolve('PONG'));
      const svc = new HealthService(conn, redis);

      const res = await svc.readiness();

      expect(res.status).toBe('error');
      expect(res.checks.mongo.status).toBe('down');
      expect(res.checks.mongo.error).toContain('not authorized');
    });

    it('reports redis down when ping rejects', async () => {
      const conn = mockConnection({ readyState: 1 });
      const redis = mockRedis(() => Promise.reject(new Error('ECONNREFUSED')));
      const svc = new HealthService(conn, redis);

      const res = await svc.readiness();

      expect(res.status).toBe('error');
      expect(res.checks.redis.status).toBe('down');
      expect(res.checks.redis.error).toContain('ECONNREFUSED');
      expect(res.checks.mongo.status).toBe('up');
    });

    it('reports redis down when ping returns an unexpected reply', async () => {
      const conn = mockConnection({ readyState: 1 });
      const redis = mockRedis(() => Promise.resolve('WAT'));
      const svc = new HealthService(conn, redis);

      const res = await svc.readiness();

      expect(res.status).toBe('error');
      expect(res.checks.redis.status).toBe('down');
    });

    it('does not hang when a dependency probe never resolves — it times out and marks it down', async () => {
      const conn = mockConnection({
        readyState: 1,
        command: () => new Promise(() => {}), // never resolves
      });
      const redis = mockRedis(() => Promise.resolve('PONG'));
      const svc = new HealthService(conn, redis);
      // Shrink the probe timeout so the test is fast.
      (svc as any).probeTimeoutMs = 30;

      const started = Date.now();
      const res = await svc.readiness();
      const elapsed = Date.now() - started;

      expect(res.status).toBe('error');
      expect(res.checks.mongo.status).toBe('down');
      expect(res.checks.mongo.error?.toLowerCase()).toContain('timed out');
      // Should resolve shortly after the 30ms timeout, never hang.
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
