import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { HealthService, LivenessResult, ReadinessResult } from './health.service';

/**
 * Liveness + readiness probes. @Public() at class level short-circuits all four
 * global guards (JwtAuthGuard, PinUnlockGuard, RolesGuard, PlatformAccessGuard)
 * so an orchestrator / uptime monitor reaches these without a token.
 *
 * Routes (global '/api' prefix applies): GET /api/health, GET /api/ready.
 * Cross-module link: delegates to HealthService which probes Mongo + Redis.
 */
@Public()
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Liveness: process is up. No dependency I/O — always 200. Used for container
  // liveness + the external uptime monitor.
  @Get('health')
  liveness(): LivenessResult {
    return this.health.liveness();
  }

  // Readiness: Mongo + Redis reachable. 200 when ready; 503 when not, so the
  // load balancer pulls this instance out of rotation. The global
  // HttpExceptionFilter forwards the `success:false` payload verbatim (including
  // `checks`) so the operator sees which dependency is down.
  @Get('ready')
  async readiness(): Promise<ReadinessResult> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException({
        success: false,
        message: 'Service not ready',
        ...result,
      });
    }
    return result;
  }
}
