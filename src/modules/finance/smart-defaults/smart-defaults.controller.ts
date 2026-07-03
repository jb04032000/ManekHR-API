/**
 * Smart Defaults / Field Prediction read controller.
 *
 * GET /workspaces/:wsId/finance/firms/:firmId/smart-defaults?partyId=...
 *   → SmartDefaultsService.getForParty(wsId, firmId, partyId)
 *
 * Returns the remembered new-invoice pre-fill for a party:
 *   { dueDays?, placeOfSupplyStateCode?, itemRates: { [itemId]: ratePaise } }
 *
 * When partyId is omitted (no party chosen yet) it returns an empty shape —
 * there is nothing to pre-fill without a party context.
 *
 * Guards: global JwtAuthGuard + RolesGuard (APP_GUARD) require an RBAC marker;
 * this read uses the existing Finance VIEW permission (mirrors PartyPnlController
 * — the codebase has no separate smart-defaults permission). ThrottlerGuard +
 * the 'finance-read' tier caps interactive re-fetch / render-loop polling.
 * Read-only → OTel span only (in the service), no PostHog, no audit.
 *
 * Tenant scope: wsId + firmId are validated as ObjectIds and passed straight to
 * the service, which filters every query by both.
 *
 * Links to: SmartDefaultsService, GetSmartDefaultsDto, field-prediction-memory.schema.
 */
import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { SmartDefaultsService, PartyDefaults } from './smart-defaults.service';
import { GetSmartDefaultsDto } from './dto/get-smart-defaults.dto';

@Controller('workspaces/:wsId/finance/firms/:firmId/smart-defaults')
@UseGuards(JwtAuthGuard, RolesGuard, ThrottlerGuard)
export class SmartDefaultsController {
  constructor(private readonly service: SmartDefaultsService) {}

  @Get()
  @Throttle({ 'finance-read': { limit: 60, ttl: 60_000 } })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async get(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: GetSmartDefaultsDto,
  ): Promise<PartyDefaults> {
    if (!Types.ObjectId.isValid(wsId)) {
      throw new BadRequestException('Invalid workspace id');
    }
    if (!Types.ObjectId.isValid(firmId)) {
      throw new BadRequestException('Invalid firm id');
    }
    // No party chosen yet → nothing to pre-fill.
    if (!query.partyId) {
      return { itemRates: {} };
    }
    return this.service.getForParty(wsId, firmId, query.partyId);
  }
}
