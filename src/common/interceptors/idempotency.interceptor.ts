import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  IDEMPOTENT_METADATA_KEY,
  IdempotentOptions,
} from '../decorators/idempotent.decorator';

/**
 * Idempotency-Key request dedup.
 *
 * Activates only on routes decorated with `@Idempotent()`. Reads the
 * `Idempotency-Key` HTTP header — if present, the (userId, key) pair is used
 * to short-circuit retries:
 *   1. Cache hit → return the cached response immediately.
 *   2. Cache miss → run the handler, cache the response on success, return.
 *
 * Errors are NOT cached so a transient failure can be retried.
 *
 * Header format: alphanumeric + dash + underscore, 8..128 chars. Rejects
 * malformed values with 400 to discourage clients from passing
 * easily-collidable strings (e.g. user inputs).
 *
 * Concurrency note: two parallel requests with the same key may both reach
 * the handler — there is no in-flight lock in this v1. The DB-level unique
 * indexes on attendance writes are the last line of defence; client-side
 * retry timing rarely produces simultaneous duplicates.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private static readonly KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const opts = this.reflector.getAllAndOverride<IdempotentOptions>(
      IDEMPOTENT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!opts) return next.handle();

    const req = context.switchToHttp().getRequest();
    const headerValue = req.headers?.['idempotency-key'];
    const key = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!key) {
      // Header optional — legacy callers proceed unchanged.
      return next.handle();
    }
    if (!IdempotencyInterceptor.KEY_RE.test(key)) {
      throw new BadRequestException(
        'Idempotency-Key must be 8..128 chars, alphanumeric / dash / underscore',
      );
    }

    const userId = req.user?.sub ?? req.user?._id ?? req.user?.userId;
    if (!userId) {
      // Unauth route with idempotency makes no sense — skip silently.
      return next.handle();
    }

    const cacheKey = `idem:${userId}:${key}`;

    return from(this.redis.get(cacheKey)).pipe(
      switchMap((cached) => {
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            this.logger.log(
              `Idempotency hit user=${userId} key=${key}`,
            );
            return of(parsed.body);
          } catch {
            // Corrupt entry — drop and re-execute.
            void this.redis.del(cacheKey);
          }
        }

        return next.handle().pipe(
          tap((body) => {
            const ttl = opts.ttlSeconds ?? 24 * 60 * 60;
            void this.redis
              .set(
                cacheKey,
                JSON.stringify({
                  body,
                  completedAt: new Date().toISOString(),
                }),
                'EX',
                ttl,
              )
              .catch((err) =>
                this.logger.warn(
                  `Failed to cache idempotency entry for ${cacheKey}: ${err?.message ?? err}`,
                ),
              );
          }),
        );
      }),
    );
  }
}
