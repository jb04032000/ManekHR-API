import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueMonitorService } from './queue-monitor.service';
import { FEED_FANOUT_QUEUE } from '../connect/feed/feed.constants';
import { DUNNING_QUEUE } from '../subscriptions/billing/services/dunning.service';

/**
 * Monitoring module (launch — Workstream F). Hosts the queue-backlog monitor.
 *
 * registerQueue here only creates PRODUCER handles (BullMQ Queue) bound to the
 * global BullModule connection so QueueMonitorService can read getJobCounts() —
 * it does NOT add processors/workers (those stay in the owning feature modules).
 * Registering an already-registered queue name in a second module is the existing
 * pattern in this repo (connect-feed-fanout is registered in two modules).
 *
 * ScheduleModule.forRoot() is registered once app-wide (SalaryModule), so the
 * @Cron in QueueMonitorService is discovered without re-registering it here.
 * SingleFlightService is @Global (scheduler.module.ts) so it injects directly.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: FEED_FANOUT_QUEUE },
      { name: DUNNING_QUEUE },
      { name: 'einvoice-retry' },
    ),
  ],
  providers: [QueueMonitorService],
})
export class MonitoringModule {}
