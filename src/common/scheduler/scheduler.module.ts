import { Global, Module } from '@nestjs/common';
import { SingleFlightService } from './single-flight.service';

/**
 * Global scheduler-support module (scheduler-contract ADR).
 *
 * Exports `SingleFlightService` so any module's scheduled job can wrap its body
 * in the Redis single-flight lock without a local provider. Depends only on the
 * global `REDIS_CLIENT` (provided by the global `RedisModule`).
 */
@Global()
@Module({
  providers: [SingleFlightService],
  exports: [SingleFlightService],
})
export class SchedulerModule {}
