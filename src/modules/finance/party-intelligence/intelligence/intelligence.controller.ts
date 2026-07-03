/**
 * Phase 17 / FIN-16-01..02 — Party Intelligence controller.
 *
 * Wave-1 Plan 03 added:
 *   - POST /workspaces/:wsId/parties/:partyId/intelligence/recheck-gstin (D-14)
 *
 * Wave-1 Plan 04 adds:
 *   - GET    /                       — read intelligence sub-doc
 *   - POST   /blacklist              — set BLACKLIST sticky (D-04)
 *   - DELETE /blacklist              — clear BLACKLIST
 *   - POST   /manual-segment         — one-cycle override (D-07)
 *   - DELETE /manual-segment         — clear override
 *
 * Plus a workspace-level rerun endpoint (separate @Controller declaration
 * below) at:
 *   - POST /workspaces/:wsId/parties/intelligence/rerun-rfm (D-07, 1/10min/ws)
 *
 * RBAC: AppModule.FINANCE + per-action permission via FINANCE_F16_PERMISSIONS.
 * Subscription: party_intelligence_rfm or party_intelligence_gstin_monitor
 * depending on endpoint.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { IntelligenceService } from './intelligence.service';
import { BlacklistDto } from './dto/blacklist.dto';
import { ManualSegmentDto } from './dto/manual-segment.dto';

/**
 * Per-party endpoints. Guarded by JWT + RBAC + Subscription.
 */
@ApiTags('Finance - Parties')
@Controller('workspaces/:wsId/parties/:partyId/intelligence')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  // ─── Plan 04 GET — read intelligence sub-doc ───────────────────────────

  @Get('/')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async getIntelligence(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
  ): Promise<any> {
    try {
      return await this.intelligence.getIntelligence(wsId, partyId);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      if (msg.includes('Party not found')) throw new NotFoundException(msg);
      throw err;
    }
  }

  // ─── Plan 04 BLACKLIST set/clear ───────────────────────────────────────

  @Post('blacklist')
  @RequirePermissions(AppModule.FINANCE, 'set_blacklist' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async setBlacklist(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Body() body: BlacklistDto,
    @CurrentUser() user: any,
  ): Promise<{ updated: boolean }> {
    const userId = user?.sub ?? user?._id ?? '';
    try {
      return await this.intelligence.setBlacklist(wsId, partyId, userId, body.reason);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      if (msg.includes('Party not found')) throw new NotFoundException(msg);
      throw err;
    }
  }

  @Delete('blacklist')
  @RequirePermissions(AppModule.FINANCE, 'set_blacklist' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async clearBlacklist(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @CurrentUser() user: any,
  ): Promise<{ updated: boolean }> {
    const userId = user?.sub ?? user?._id ?? '';
    try {
      return await this.intelligence.clearBlacklist(wsId, partyId, userId);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      if (msg.includes('Party not found')) throw new NotFoundException(msg);
      throw err;
    }
  }

  // ─── Plan 04 manual-segment set/clear ──────────────────────────────────

  @Post('manual-segment')
  @RequirePermissions(AppModule.FINANCE, 'manage_party_intelligence' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async setManualSegment(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Body() body: ManualSegmentDto,
  ): Promise<{ updated: boolean }> {
    try {
      return await this.intelligence.setManualSegment(wsId, partyId, body.segment);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      if (msg.includes('Party not found')) throw new NotFoundException(msg);
      if (msg.includes('Invalid manual segment')) throw new BadRequestException(msg);
      throw err;
    }
  }

  @Delete('manual-segment')
  @RequirePermissions(AppModule.FINANCE, 'manage_party_intelligence' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async clearManualSegment(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
  ): Promise<{ updated: boolean }> {
    return this.intelligence.clearManualSegment(wsId, partyId);
  }

  // ─── Plan 03 GSTIN re-check (preserved) ────────────────────────────────

  @Post('recheck-gstin')
  @RequirePermissions(AppModule.FINANCE, 'recheck_gstin' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_gstin_monitor',
  })
  async recheckGstin(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    status: 'updated' | 'queued';
    filings?: unknown;
    riskLevel?: string;
  }> {
    const userId = user?.sub ?? user?._id ?? '';
    let result;
    try {
      result = await this.intelligence.recheckGstin(wsId, partyId, userId);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      if (msg.includes('Party not found')) {
        throw new NotFoundException(msg);
      }
      if (msg.includes('no GSTIN')) {
        throw new BadRequestException(msg);
      }
      throw err;
    }

    if (result.status === 'rate_limited') {
      if (result.retryAfterSeconds && res?.setHeader) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
      }
      throw new HttpException(
        {
          message: 'Recheck rate-limited (1/hour/party)',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return {
      status: result.status,
      filings: result.filings,
      riskLevel: result.riskLevel,
    };
  }
}

/**
 * Workspace-level rerun endpoint — separate @Controller because the path is
 * party-AGNOSTIC. D-07: rate-limited 1/10min per workspace.
 *
 * Path: POST /workspaces/:wsId/parties/intelligence/rerun-rfm
 */
@ApiTags('Finance - Parties')
@Controller('workspaces/:wsId/parties/intelligence')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class IntelligenceRerunController {
  constructor(private readonly intelligence: IntelligenceService) {}

  @Post('rerun-rfm')
  @RequirePermissions(AppModule.FINANCE, 'manage_party_intelligence' as any)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_rfm',
  })
  async rerunRfm(
    @Param('wsId') wsId: string,
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    status: 'completed';
    updated: number;
    segmentChanges: number;
    durationMs: number;
  }> {
    const userId = user?.sub ?? user?._id ?? '';
    const result = await this.intelligence.triggerRerun(wsId, userId);
    if (result.status === 'rate_limited') {
      if (result.retryAfterSeconds && res?.setHeader) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
      }
      throw new HttpException(
        {
          message: 'Re-run rate-limited (1/10min/workspace)',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return {
      status: 'completed',
      updated: result.updated ?? 0,
      segmentChanges: result.segmentChanges ?? 0,
      durationMs: result.durationMs ?? 0,
    };
  }
}
