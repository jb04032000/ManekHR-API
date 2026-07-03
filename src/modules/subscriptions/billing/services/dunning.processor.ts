import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  DUNNING_QUEUE,
  DunningJobData,
  DunningService,
} from './dunning.service';

/**
 * BullMQ worker for the `billing-dunning` queue (D1g).
 *
 * Two job types:
 *   - `grace_reminder` — fires 1 day before grace expiry; sends a
 *     "last chance" email if the subscription is still in grace AND
 *     the stamp matches.
 *   - `grace_expiry` — fires at gracePeriodUntil; flips the
 *     subscription to `expired` if still in grace AND the stamp
 *     matches.
 *
 * Stale-job defence: every job carries the `gracePeriodUntilStamp`
 * the dunning service captured at scheduling time. If the customer
 * paid mid-grace and a fresh grace period started later for a
 * separate failure, the old job's stamp won't match the current
 * `gracePeriodUntil` and the work is skipped. No manual job
 * cancellation needed.
 *
 * Failure mode: a thrown error triggers BullMQ's default retry
 * (3 attempts with exponential backoff, set in app.module.ts). After
 * the final attempt the job lands on the failed-jobs DLQ for admin
 * inspection. Skipping a stale job is NOT an error.
 */
@Processor(DUNNING_QUEUE)
export class DunningProcessor extends WorkerHost {
  private readonly logger = new Logger(DunningProcessor.name);

  constructor(private readonly dunning: DunningService) {
    super();
  }

  async process(job: Job<DunningJobData>): Promise<void> {
    this.logger.log(
      `Dunning job ${job.id} type=${job.data.type} sub=${job.data.subscriptionId} attempt=${job.attemptsMade + 1}`,
    );

    if (job.data.type === 'grace_reminder') {
      await this.dunning.dispatchReminder(job.data);
      return;
    }
    if (job.data.type === 'grace_expiry') {
      await this.dunning.dispatchExpiry(job.data);
      return;
    }

    this.logger.warn(
      `Unknown dunning job type: ${(job.data as any).type} — skipping`,
    );
  }
}
