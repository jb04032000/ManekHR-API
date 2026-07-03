import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * `RedisIoAdapter` — backs Socket.IO with the Redis pub/sub adapter so the
 * Connect feed gateway fans events out across every backend instance
 * (`docs/connect/phases/phase-3-feed.md` B6).
 *
 * `connectToRedis` is best-effort: if Redis is unreachable it throws, the
 * caller logs it, and the gateway runs on the default in-memory adapter — a
 * single-instance deploy is fully functional without Redis.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  /** Connect a pub + sub client and build the Redis adapter. Throws if Redis is down. */
  async connectToRedis(host: string, port: number, password?: string): Promise<void> {
    const pub = new Redis({
      host,
      port,
      password,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    const sub = pub.duplicate();
    await pub.connect();
    await sub.connect();
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
