import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { env } from '../../config/env';

/**
 * Health / readiness probes for load balancers, container healthchecks and the
 * external uptime monitor. Liveness ("am I running?") is dependency-free so a
 * transient DB/Redis blip never makes an orchestrator kill an otherwise-healthy
 * process. Readiness ("can I serve traffic?") actively probes Mongo + Redis with
 * a hard timeout so a hung dependency can never make the probe itself hang.
 *
 * Cross-module links: injects the Mongoose connection (root MongooseModule) and
 * the shared ioredis client (common/redis/redis.module REDIS_CLIENT). Exposed by
 * HealthController at GET /api/health and GET /api/ready (both @Public()).
 */

export type DepStatus = 'up' | 'down';

export interface DependencyCheck {
  status: DepStatus;
  latencyMs: number;
  error?: string;
}

export interface LivenessResult {
  status: 'ok';
  uptimeSec: number;
  timestamp: string;
  processRole: string;
  version: string;
}

export interface ReadinessResult {
  status: 'ok' | 'error';
  checks: { mongo: DependencyCheck; redis: DependencyCheck };
}

@Injectable()
export class HealthService {
  // Per-dependency probe budget. A dependency that does not answer within this
  // window is reported `down` rather than allowed to stall the whole probe.
  private probeTimeoutMs = env.health.probeTimeoutMs;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Liveness — process is up and the event loop is responsive. Deliberately
   * touches NO external dependency: a failing DB must not flap liveness and
   * trigger a restart loop. Always 200.
   */
  liveness(): LivenessResult {
    return {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      processRole: env.processRole,
      version: process.env.npm_package_version || '0.0.0',
    };
  }

  /**
   * Readiness — can this instance actually serve traffic? Probes Mongo + Redis
   * in parallel; overall status is `ok` only when both are up. Returns the
   * per-dependency detail so the caller (controller) can answer 200/503 and an
   * operator can see WHICH dependency is down.
   */
  async readiness(): Promise<ReadinessResult> {
    const [mongo, redis] = await Promise.all([this.checkMongo(), this.checkRedis()]);
    const status: 'ok' | 'error' = mongo.status === 'up' && redis.status === 'up' ? 'ok' : 'error';
    return { status, checks: { mongo, redis } };
  }

  private async checkMongo(): Promise<DependencyCheck> {
    const started = Date.now();
    try {
      // Only `connected` (readyState 1) is ready. Any other state (disconnected,
      // connecting, disconnecting) means we are not ready to serve.
      if (this.connection.readyState !== ConnectionStates.connected) {
        return {
          status: 'down',
          latencyMs: Date.now() - started,
          error: `mongo connection readyState=${this.connection.readyState} (expected 1)`,
        };
      }
      const db = this.connection.db;
      if (!db) {
        return {
          status: 'down',
          latencyMs: Date.now() - started,
          error: 'mongo connection has no active database handle',
        };
      }
      // Active ping against the app DB (not admin) so it works on Atlas with a
      // least-privilege user. Raced against the probe timeout.
      await this.withTimeout(db.command({ ping: 1 }), 'mongo');
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    const started = Date.now();
    try {
      const reply = await this.withTimeout(this.redis.ping(), 'redis');
      if (reply !== 'PONG') {
        return {
          status: 'down',
          latencyMs: Date.now() - started,
          error: `redis ping returned unexpected reply: ${String(reply)}`,
        };
      }
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Reject after probeTimeoutMs so a wedged socket can never hang the probe.
  private withTimeout<T>(p: PromiseLike<T>, dep: string): Promise<T> {
    return Promise.race([
      Promise.resolve(p),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${dep} probe timed out after ${this.probeTimeoutMs}ms`)),
          this.probeTimeoutMs,
        ).unref?.(),
      ),
    ]);
  }
}
