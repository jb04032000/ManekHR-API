import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health module — liveness + readiness probes for the load balancer, container
 * healthchecks and the external uptime monitor.
 *
 * Depends on the root MongooseModule (connection) and the @Global RedisModule
 * (REDIS_CLIENT); both are already available app-wide, so this module only wires
 * its own controller + service. Registered in AppModule.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
