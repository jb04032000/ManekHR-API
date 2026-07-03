/**
 * Phase 17 / FIN-16-04 — Per-party P&L controller.
 *
 * Mounted at `/workspaces/:wsId/reports/parties/:partyId/pnl` per D-25
 * (matches the existing reports controller path conventions while staying
 * under the party-intelligence module registration).
 *
 * RBAC: AppModule.FINANCE + ModuleAction.VIEW (the existing reports
 * permission — this codebase has no separate REPORTS module enum value).
 * Subscription: party_intelligence_pnl sub-feature gate.
 *
 * Default period (D-25): current FY-to-date. Indian FY = 1 April → 31 March.
 * Custom range cap of 5 years enforced by PnlQueryDto.
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PartyPnlService, PartyPnlReport } from './party-pnl.service';
import { PnlQueryDto } from './dto/pnl-query.dto';

/**
 * Compute the start of the current Indian financial year (1 April).
 * If today is in Jan/Feb/Mar, the FY started on 1 April of the prior calendar
 * year; otherwise on 1 April of the current calendar year.
 */
function currentFyStart(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0=Jan
  const fyYear = m < 3 /* Jan-Mar */ ? y - 1 : y;
  return new Date(Date.UTC(fyYear, 3, 1, 0, 0, 0, 0)); // 1 April UTC
}

@ApiTags('Finance - Parties')
@Controller('workspaces/:wsId/reports/parties/:partyId/pnl')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class PartyPnlController {
  constructor(
    private readonly pnlService: PartyPnlService,
    @InjectModel('Party') private readonly partyModel: Model<any>,
  ) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.FINANCE,
    subFeature: 'party_intelligence_pnl',
  })
  async getPnl(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Query() dto: PnlQueryDto,
  ): Promise<PartyPnlReport> {
    if (!Types.ObjectId.isValid(wsId)) {
      throw new BadRequestException('Invalid workspace id');
    }
    if (!Types.ObjectId.isValid(partyId)) {
      throw new BadRequestException('Invalid party id');
    }

    // Resolve firmId from the party's workspace scope. The party-intelligence
    // module does not (yet) expose a @CurrentFirm decorator and the report
    // is partyId-scoped — partyId carries firmId via its document.
    const wsOid = new Types.ObjectId(wsId);
    const partyOid = new Types.ObjectId(partyId);
    const party = await this.partyModel.findOne({ _id: partyOid, workspaceId: wsOid }).lean();
    if (!party) {
      throw new NotFoundException('Party not found in workspace');
    }
    const firmId: Types.ObjectId = (party as any).firmId;

    const to = dto.to ? new Date(dto.to) : new Date();
    const from = dto.from ? new Date(dto.from) : currentFyStart(to);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format');
    }
    if (from > to) {
      throw new BadRequestException('from must be <= to');
    }
    // Defence-in-depth — DTO already enforces 5-year cap, but defaults
    // computed here also need the same guarantee.
    const spanYears = (to.getTime() - from.getTime()) / (365 * 24 * 60 * 60 * 1000);
    if (spanYears > 5) {
      throw new BadRequestException('Date range cannot exceed 5 years per request (D-25 cap)');
    }

    return this.pnlService.partyDirectPnl(wsId, firmId, partyOid, from, to);
  }
}
