/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../health.controller';
import type { ReadinessResult } from '../health.service';

function makeController(svc: Partial<{ liveness: any; readiness: any }>) {
  return new HealthController(svc as any);
}

describe('HealthController', () => {
  it('liveness returns the service liveness payload (always 200)', () => {
    const payload = {
      status: 'ok',
      uptimeSec: 5,
      timestamp: 't',
      processRole: 'all',
      version: '1.0.0',
    };
    const ctrl = makeController({ liveness: () => payload });

    expect(ctrl.liveness()).toBe(payload);
  });

  it('readiness returns the payload when both dependencies are up', async () => {
    const ready: ReadinessResult = {
      status: 'ok',
      checks: { mongo: { status: 'up', latencyMs: 1 }, redis: { status: 'up', latencyMs: 1 } },
    };
    const ctrl = makeController({ readiness: () => Promise.resolve(ready) });

    await expect(ctrl.readiness()).resolves.toBe(ready);
  });

  it('readiness throws 503 (ServiceUnavailableException) carrying the failing-dependency detail', async () => {
    const ready: ReadinessResult = {
      status: 'error',
      checks: {
        mongo: { status: 'down', latencyMs: 3000, error: 'timed out' },
        redis: { status: 'up', latencyMs: 1 },
      },
    };
    const ctrl = makeController({ readiness: () => Promise.resolve(ready) });

    await expect(ctrl.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);

    // The thrown payload must preserve the per-dependency detail so the global
    // exception filter surfaces WHICH dependency is down at the response top level.
    try {
      await ctrl.readiness();
      throw new Error('expected readiness to throw');
    } catch (e) {
      const res = (e as ServiceUnavailableException).getResponse() as any;
      expect(res.success).toBe(false);
      expect(res.status).toBe('error');
      expect(res.checks.mongo.status).toBe('down');
    }
  });
});
