import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { env } from '../../config/env';

export interface PostHogCaptureInput {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

export interface PostHogIdentifyInput {
  distinctId: string;
  properties?: Record<string, unknown>;
}

/**
 * Server-side PostHog wrapper. Empty `POSTHOG_KEY` = safe no-op (mirrors
 * Sentry empty-DSN pattern in `instrument.ts`). Use `capture(...)` for
 * meaningful writes and `identify(...)` to bind a Mongo `userId` distinct-id
 * to user properties so server events join FE pageview funnels.
 *
 * Naming convention: events use `<module>.<verb>_<noun>` snake_case (e.g.
 * `auth.signup_completed`, `salary.payroll_finalized`). See
 * `crewroster-backend/CLAUDE.md > Observability` for the binding rule.
 */
@Injectable()
export class PostHogService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostHogService.name);
  private readonly client: PostHog | null;
  readonly enabled: boolean;

  constructor() {
    this.enabled = Boolean(env.posthog.apiKey);
    this.client = this.enabled
      ? new PostHog(env.posthog.apiKey, {
          host: env.posthog.host,
          flushAt: 20,
          flushInterval: 10_000,
        })
      : null;
  }

  capture(input: PostHogCaptureInput): void {
    if (!this.client) return;
    try {
      this.client.capture({
        distinctId: input.distinctId,
        event: input.event,
        properties: input.properties,
      });
    } catch (err) {
      this.logger.warn(
        `PostHog capture failed for ${input.event}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  identify(input: PostHogIdentifyInput): void {
    if (!this.client) return;
    try {
      this.client.identify({
        distinctId: input.distinctId,
        properties: input.properties,
      });
    } catch (err) {
      this.logger.warn(`PostHog identify failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.shutdown();
      this.logger.log('PostHog client flushed cleanly');
    } catch (err) {
      this.logger.warn(`PostHog shutdown error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
