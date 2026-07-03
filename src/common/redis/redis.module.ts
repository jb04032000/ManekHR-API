import {
  Global,
  Logger,
  Module,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

class RedisShutdown implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');
  constructor(private readonly client: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
      this.logger.log('Redis client closed cleanly');
    } catch (err) {
      this.logger.warn(`Redis quit error: ${(err as Error).message}`);
    }
  }
}

const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: ConfigService): Redis => {
    const logger = new Logger('Redis');
    const env = config.get<string>('NODE_ENV', 'development');
    const client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      // ManekHR owns its own Redis key namespace so a co-running zari360 on the
      // same Redis instance can never share/clobber cache keys (also a brand fix).
      keyPrefix: `manekhr:${env}:`,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    client.on('connect', () => logger.log('Redis connecting'));
    client.on('ready', () => logger.log('Redis ready'));
    client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
    client.on('reconnecting', () => logger.warn('Redis reconnecting'));
    client.on('end', () => logger.warn('Redis connection ended'));

    return client;
  },
  inject: [ConfigService],
};

const shutdownProvider: Provider = {
  provide: RedisShutdown,
  useFactory: (client: Redis) => new RedisShutdown(client),
  inject: [REDIS_CLIENT],
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [redisProvider, shutdownProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
