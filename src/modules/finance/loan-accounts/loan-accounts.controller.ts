import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { LoanAccountsService } from './loan-accounts.service';
import { CreateLoanAccountDto } from './dto/create-loan-account.dto';
import { ListLoanAccountsDto } from './dto/list-loan-accounts.dto';
import { RecordDisbursementDto } from './dto/record-disbursement.dto';
import { PrepayLoanDto } from './dto/prepay-loan.dto';
import { PreviewScheduleDto } from './dto/preview-schedule.dto';

/**
 * LoanAccountsController
 *
 * Route prefix: /workspaces/:wsId/finance/firms/:firmId/loan-accounts
 *
 * Endpoints:
 *   POST   /                          — create loan account + amortisation schedule
 *   GET    /                          — list loan accounts
 *   GET    /:id                       — single loan account
 *   GET    /:id/schedule              — full amortisation schedule
 *   POST   /:id/disbursement          — post disbursement ledger entry
 *   POST   /:id/prepay                — record a prepayment (shortens tenure)
 *   POST   /:id/run-emi               — manually trigger EMI for current month
 *   POST   /:id/close                 — close loan (foreclosure/full_repayment)
 *   POST   /:id/npa                   — mark loan as NPA
 *   POST   /:id/emi/:runMonth         — manually trigger EMI for a specific month
 *   DELETE /:id                       — soft-delete (only if no EMIs posted)
 */
@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/loan-accounts')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'banking_loan_accounts' })
export class LoanAccountsController {
  constructor(private readonly service: LoanAccountsService) {}

  /**
   * POST /preview-schedule — compute amortisation schedule without persisting.
   * Requires FINANCE.VIEW permission (read-only computation).
   * Must be declared before /:id routes to avoid NestJS routing conflict.
   */
  @Post('preview-schedule')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  previewSchedule(@Body() dto: PreviewScheduleDto) {
    return this.service.previewSchedule(dto);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateLoanAccountDto,
    @CurrentUser() user: any,
  ) {
    return this.service.create(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      dto,
      user._id ?? user.sub,
    );
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListLoanAccountsDto,
  ) {
    return this.service.findAll(new Types.ObjectId(wsId), new Types.ObjectId(firmId), query);
  }

  /** GET /:id — single loan account. Must be before /:id/schedule to avoid conflicts */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findById(new Types.ObjectId(wsId), new Types.ObjectId(firmId), id);
  }

  /** GET /:id/schedule — amortisation schedule for this loan */
  @Get(':id/schedule')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getSchedule(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.service.getSchedule(new Types.ObjectId(wsId), new Types.ObjectId(firmId), id);
  }

  /** POST /:id/disbursement — record disbursement and post Dr Bank / Cr Loan Liability */
  @Post(':id/disbursement')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  recordDisbursement(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: RecordDisbursementDto,
    @CurrentUser() user: any,
  ) {
    return this.service.recordDisbursement(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
  }

  /** POST /:id/close — close loan (foreclosure or full_repayment) */
  @Post(':id/close')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  close(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { closureType: 'foreclosure' | 'full_repayment' },
    @CurrentUser() user: any,
  ) {
    return this.service.close(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      body.closureType,
      user._id ?? user.sub,
    );
  }

  /** POST /:id/npa — mark loan as Non-Performing Asset */
  @Post(':id/npa')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  markNpa(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.markNpa(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
  }

  /**
   * POST /:id/prepay — record a loan prepayment.
   * Reduces principal outstanding, marks pending schedule rows as 'prepaid',
   * recomputes remaining schedule (preserves EMI, shortens tenure).
   */
  @Post(':id/prepay')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  prepay(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: PrepayLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.service.prepay(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
  }

  /**
   * POST /:id/run-emi — manually trigger EMI for the current calendar month.
   * Idempotent: returns { skipped: true } if already posted this month.
   * bankCoaCode in body: CoA code of bank to debit (defaults to '1002').
   */
  @Post(':id/run-emi')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  runEmiCurrentMonth(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { bankCoaCode?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.runEmiForCurrentMonth(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      body?.bankCoaCode ?? '1002',
      user._id ?? user.sub,
    );
  }

  /**
   * POST /:id/emi/:runMonth — manually trigger EMI posting for a specific month.
   * runMonth format: YYYY-MM
   * bankCoaCode in body: CoA code of bank account to debit (defaults to '1002').
   */
  @Post(':id/emi/:runMonth')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  runEmi(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Param('runMonth') runMonth: string,
    @Body() body: { bankCoaCode?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.runEmiForMonth(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      runMonth,
      body?.bankCoaCode ?? '1002',
      user._id ?? user.sub,
    );
  }

  /**
   * DELETE /:id — soft-delete a loan account.
   * Only allowed if no EMI has been posted (no LoanScheduleEntry with status='paid').
   */
  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  softDelete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.softDelete(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
  }
}
