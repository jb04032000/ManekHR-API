/**
 * Phase 17 / FIN-16-01 D-09 + FIN-16-05 D-29 — settings controller.
 *
 * Wave-1 Plan 04 added GET/PATCH `/workspaces/:wsId/settings/party-intelligence`.
 * Wave-1 Plan 06 (this) adds GET `/upcoming-greetings?days=30` for the
 * settings-page preview list (D-32).
 *
 * RBAC umbrella: `manage_party_intelligence` (covers RFM + greetings + GSTIN
 * cadence — single permission for any settings change).
 *
 * Subscription gate: `party_intelligence_rfm` (any of the 5 sub-features
 * grants access to settings page in practice; rfm is the umbrella key) for
 * read/PATCH; `party_intelligence_greetings` for the upcoming-greetings
 * preview specifically (Plan 06).
 */
import { Body, Controller, Get, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PartyIntelligenceSettingsService } from './party-intelligence-settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { GreetingsService } from '../greetings/greetings.service';

@ApiTags('Finance - Parties')
@Controller('workspaces/:wsId/settings/party-intelligence')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class PartyIntelligenceSettingsController {
  constructor(
    private readonly settings: PartyIntelligenceSettingsService,
    private readonly greetings: GreetingsService,
  ) {}

  @Get('/')
  @RequirePermissions(AppModule.FINANCE, 'manage_party_intelligence' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async getSettings(@Param('wsId') wsId: string): Promise<any> {
    return this.settings.getSettings(wsId);
  }

  @Patch('/')
  @RequirePermissions(AppModule.FINANCE, 'manage_party_intelligence' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async updateSettings(
    @Param('wsId') wsId: string,
    @Body() body: UpdateSettingsDto,
  ): Promise<{ updated: boolean }> {
    return this.settings.updateSettings(wsId, body);
  }

  /**
   * Phase 17 / FIN-16-05 D-32 — 30-day forward preview of upcoming greeting
   * dispatches. Used by settings page to let the owner see who will receive a
   * greeting and silence individual contacts before the cron fires.
   */
  @Get('/upcoming-greetings')
  @RequirePermissions(AppModule.FINANCE, 'manage_party_intelligence' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_greetings',
  })
  async upcomingGreetings(
    @Param('wsId') wsId: string,
    @Query('days') daysRaw?: string,
  ): Promise<{ items: any[] }> {
    const days = Math.max(1, Math.min(365, parseInt(daysRaw ?? '30', 10) || 30));
    const items = await this.greetings.upcomingGreetings(wsId, days);
    return { items };
  }
}
