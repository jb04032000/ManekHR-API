import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { minuteBucket } from '../../common/scheduler/period-key';
import { FEED_FANOUT_QUEUE } from '../connect/feed/feed.constants';
import { DUNNING_QUEUE } from '../subscriptions/billing/services/dunning.service';
import { env } from '../../config/env';
import { evaluateQueueBacklog, QueueCounts } from './queue-backlog.util';

// The einvoice retry queue has no exported constant (registered with a string
// literal in einvoice.module.ts) — mirror that literal here.
const EINVOICE_RETRY_QUEUE = 'einvoice-retry';

/**
 * Queue-backlog monitor (launch monitoring — Workstream F, alert item 3 "queue
 * backlog"). Every minute it samples the three BullMQ queues' depths via
 * getJobCounts() and, when a queue breaches its threshold (or is stalled with no
 * active worker), emits a structured warn/error log AND a Sentry message so it
 * rides the same alerting as application errors.
 *
 * Process-role: this is a @Cron, so it only runs on the worker/all role — the web
 * role stops every cron at boot (main.ts). Single-flight (Redis, per-minute
 * bucket) collapses it to one run across N workers so a multi-worker deploy
 * alerts once, not N times.
 *
 * Cross-module links: reads the queue handles owned by connect/feed (fanout),
 * subscriptions/billing (dunning) and finance/sales/einvoice (retry) — registered
 * as producer handles in MonitoringModule, NOT new processors. Pure decisioning
 * lives in queue-backlog.util (unit-tested); this service is the glue.
 */
@Injectable()
export class QueueMonitorService {
  private readonly logger = new Logger('QueueMonitor');

  constructor(
    @InjectQueue(FEED_FANOUT_QUEUE) private readonly feedQueue: Queue,
    @InjectQueue(DUNNING_QUEUE) private readonly dunningQueue: Queue,
    @InjectQueue(EINVOICE_RETRY_QUEUE) private readonly einvoiceQueue: Queue,
    private readonly singleFlight: SingleFlightService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'queue-backlog-monitor' })
  async monitor(): Promise<void> {
    if (!env.queueMonitor.enabled) return;
    // Sub-hour cadence -> minuteBucket; single-flight so only one worker checks.
    await this.singleFlight.runExclusive('queue.backlog_monitor', minuteBucket(), () =>
      this.check(),
    );
  }

  private async check(): Promise<void> {
    const thresholds = {
      waiting: env.queueMonitor.waitingThreshold,
      failed: env.queueMonitor.failedThreshold,
    };
    const queues: Array<[string, Queue]> = [
      [FEED_FANOUT_QUEUE, this.feedQueue],
      [DUNNING_QUEUE, this.dunningQueue],
      [EINVOICE_RETRY_QUEUE, this.einvoiceQueue],
    ];

    for (const [name, queue] of queues) {
      try {
        const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        const counts: QueueCounts = {
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
        };
        const verdict = evaluateQueueBacklog(name, counts, thresholds);
        if (!verdict.alert) continue;

        const msg =
          `Queue "${name}" ${verdict.level.toUpperCase()}: ${verdict.reasons.join('; ')} ` +
          `(active ${counts.active}, delayed ${counts.delayed})`;
        if (verdict.level === 'critical') this.logger.error(msg);
        else this.logger.warn(msg);

        // Empty SENTRY_DSN -> no-op (mirrors the rest of the app). On a real DSN
        // this routes through the standard Sentry alert rules.
        Sentry.captureMessage(msg, {
          level: verdict.level === 'critical' ? 'error' : 'warning',
          tags: { module: 'queue-monitor', queue: name },
          extra: { counts, thresholds },
        });
      } catch (err) {
        // A monitor must never throw back into the scheduler. A transient Redis
        // hiccup reading counts is itself worth a warn, not a crash.
        this.logger.warn(
          `Queue "${name}" depth check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
