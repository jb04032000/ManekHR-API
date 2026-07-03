import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { AudienceService } from '../services/audience.service';
import { AudienceEstimateDto } from '../dto/audience-estimate.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/**
 * `connect/ads/audience` -- audience size estimation before committing budget.
 *
 * Requires auth so estimates are not scraped anonymously. The result is a
 * privacy-floored reach count (never reveals segment sizes below 50 users).
 */
@LegacyUnclassified()
@Controller('connect/ads/audience')
@UseGuards(JwtAuthGuard)
export class AudienceController {
  constructor(private readonly audienceService: AudienceService) {}

  /**
   * Estimate reachable audience for a targeting spec.
   * Absent or empty targeting = broadest possible reach.
   */
  @Post('estimate')
  @Throttle({ 'ads-audience-estimate': { limit: 30, ttl: 60_000 } })
  estimate(@Body() dto: AudienceEstimateDto) {
    return this.audienceService.estimate(
      dto.targeting ?? { roles: [], sectors: [], districts: [], companySizes: [] },
    );
  }
}
