import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  Req,
  Delete,
  Put,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { SalaryService } from './salary.service';
import {
  UpdateSalaryRecordDto,
  RecordPaymentDto,
  BulkRecordPaymentDto,
  CreateIncrementDto,
  CreateSalaryAdjustmentDto,
  ReverseSalaryAdjustmentDto,
  ReversePaymentDto,
  GetSalaryRecordsPaginatedDto,
  GetSalaryShiftSummariesDto,
  GetPaymentRegisterDto,
  SetBasePayBodyDto,
  SetBasePaySalaryConfigDto,
  GetTaxDeclarationQueryDto,
  UpsertTaxDeclarationDto,
  GetTdsPreviewQueryDto,
  EditAdvanceRecoveryPlanDto,
  EarlyPayoffAdvanceRecoveryPlanDto,
  PreviewAdvanceScheduleDto,
} from './dto/salary.dto';
import { UpdatePayrollConfigDto } from './dto/update-payroll-config.dto';
import {
  UpdateDisbursementRulesDto,
  UpdateSalaryLossConfigDto,
  UpdateAttendanceRulesDto,
} from './dto/update-disbursement-rules.dto';
import {
  CreateSalaryComponentTemplateDto,
  UpdateSalaryComponentTemplateDto,
  SeedComponentTemplateDto,
} from './dto/salary-component-template.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { PreviewPieceRateQueryDto } from './dto/preview-piece-rate-query.dto';
import { SALARY_PERMISSIONS } from '../rbac/permissions.constants';
import { stripSalarySensitiveFields } from './salary-read-filter';
// OQ-S3: strips employer TAN/PAN + PF/ESI codes from payroll-config for non-HR.
import { stripPayrollConfigSensitiveFields } from './payroll-config-read-filter';
import { LoanService } from './loan.service';
import {
  CreateLoanDto,
  PreviewLoanScheduleDto,
  ApproveLoanDto,
  SkipInstallmentDto,
  PauseResumeLoanDto,
  EarlyPayoffLoanDto,
  TopUpLoanDto,
  WriteOffLoanDto,
} from './dto/loan.dto';
import { CommissionService } from './commission.service';
import {
  RecordCommissionEntriesDto,
  CommissionYtdQueryDto,
  ListCommissionEntriesQueryDto,
  CreateCommissionScheduleDto,
  UpdateCommissionScheduleDto,
  DisburseScheduleDto,
  ListSchedulesQueryDto,
} from './dto/commission.dto';
import { BonusService } from './bonus.service';
import {
  PreviewStatutoryBonusDto,
  RunStatutoryBonusDto,
  RecordFestivalBonusDto,
  BonusSummaryQueryDto,
  UpdateBonusConfigDto,
} from './dto/bonus.dto';
import { CashLedgerService } from './cash-ledger.service';
import {
  RecordLedgerEntriesDto,
  LedgerQueryDto,
  WorkspaceBalanceQueryDto,
  SettleDto,
} from './dto/cash-ledger.dto';

type EnsureSalaryRecordBody = {
  teamMemberId?: string;
  month?: number;
  year?: number;
};

type SendPayslipEmailBody = {
  salaryId?: string;
};

type SendBulkPayslipEmailsBody = {
  items?: Array<{ salaryId?: string }>;
};

type TriggerBulkEmailBody = {
  month?: number;
  year?: number;
};

type InitiateFnfBody = {
  lastWorkingDate?: string;
  noticePeriodDays?: number;
  noticeServedDays?: number;
  leaveBalanceDays?: number;
  otherAdditions?: Array<{ description: string; amount: number }>;
  otherDeductions?: Array<{ description: string; amount: number }>;
  notes?: string;
  resignationReason?: string;
};

type AuthenticatedRequest = {
  user: {
    sub: string;
  };
};

const HOURLY_ONLY_SET_BASE_PAY_FIELDS = ['finalMonthlyOverride', 'dailyHours'] as const;

const MONTHLY_ONLY_SET_BASE_PAY_FIELDS = [
  'ctcAmount',
  'componentTemplateId',
  'componentOverrides',
] as const;

const DEPRECATED_SET_BASE_PAY_FIELDS = ['workingDays'] as const;

function hasOwnKey(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

@Controller('workspaces/:workspaceId/salary')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class SalaryController {
  private readonly logger = new Logger(SalaryController.name);

  constructor(
    private readonly salaryService: SalaryService,
    private readonly loanService: LoanService,
    private readonly commissionService: CommissionService,
    private readonly bonusService: BonusService,
    private readonly cashLedgerService: CashLedgerService,
  ) {}

  private validateSetBasePayBody(
    workspaceId: string,
    body: SetBasePayBodyDto,
  ): SetBasePayBodyDto & {
    teamMemberId: string;
    salaryConfig: SetBasePaySalaryConfigDto;
  } {
    if (!body.teamMemberId) {
      throw new BadRequestException('teamMemberId is required');
    }

    if (!body.salaryConfig || typeof body.salaryConfig !== 'object') {
      throw new BadRequestException('salaryConfig is required');
    }

    const salaryConfig = body.salaryConfig;
    if (
      salaryConfig.salaryAmount === undefined ||
      typeof salaryConfig.salaryAmount !== 'number' ||
      Number.isNaN(salaryConfig.salaryAmount) ||
      !salaryConfig.salaryType
    ) {
      throw new BadRequestException(
        'salaryConfig.salaryAmount and salaryConfig.salaryType are required',
      );
    }

    if (salaryConfig.salaryType !== 'monthly' && salaryConfig.salaryType !== 'hourly') {
      throw new BadRequestException('salaryConfig.salaryType must be monthly or hourly');
    }

    const invalidFields =
      salaryConfig.salaryType === 'hourly'
        ? MONTHLY_ONLY_SET_BASE_PAY_FIELDS.filter((field) => hasOwnKey(salaryConfig, field))
        : HOURLY_ONLY_SET_BASE_PAY_FIELDS.filter((field) => hasOwnKey(salaryConfig, field));

    const deprecatedFields = DEPRECATED_SET_BASE_PAY_FIELDS.filter((field) =>
      hasOwnKey(salaryConfig, field),
    );

    const incompatibleFields = [...invalidFields, ...deprecatedFields];

    if (
      !salaryConfig.salaryDayBasis ||
      !['fixed_month_days', 'calendar_month_days'].includes(salaryConfig.salaryDayBasis)
    ) {
      throw new BadRequestException(
        'salaryConfig.salaryDayBasis must be fixed_month_days or calendar_month_days',
      );
    }

    if (
      !salaryConfig.attendancePayMode ||
      !['default', 'enabled', 'disabled'].includes(salaryConfig.attendancePayMode)
    ) {
      throw new BadRequestException(
        'salaryConfig.attendancePayMode must be default, enabled, or disabled',
      );
    }

    if (salaryConfig.salaryDayBasis === 'fixed_month_days') {
      if (
        salaryConfig.fixedMonthDays === undefined ||
        salaryConfig.fixedMonthDays === null ||
        typeof salaryConfig.fixedMonthDays !== 'number' ||
        Number.isNaN(salaryConfig.fixedMonthDays) ||
        salaryConfig.fixedMonthDays < 1 ||
        salaryConfig.fixedMonthDays > 31
      ) {
        throw new BadRequestException(
          'salaryConfig.fixedMonthDays is required for fixed_month_days and must be between 1 and 31',
        );
      }
    } else if (
      hasOwnKey(salaryConfig, 'fixedMonthDays') &&
      salaryConfig.fixedMonthDays !== undefined &&
      salaryConfig.fixedMonthDays !== null
    ) {
      throw new BadRequestException(
        'salaryConfig.fixedMonthDays must be omitted for calendar_month_days',
      );
    }

    if (incompatibleFields.length > 0) {
      this.logger.warn(
        `[salary/set-base-pay] rejected incompatible salary config ${JSON.stringify({
          workspaceId,
          employeeId: body.teamMemberId,
          salaryType: salaryConfig.salaryType,
          invalidFields: incompatibleFields,
        })}`,
      );
      throw new BadRequestException(
        `salaryConfig for ${salaryConfig.salaryType} salary cannot include: ${incompatibleFields.join(', ')}`,
      );
    }

    return {
      ...body,
      teamMemberId: body.teamMemberId,
      salaryConfig,
    };
  }

  @Post('generate')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'generate_payroll',
  })
  generatePayroll(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.salaryService.generatePayroll(workspaceId, parseInt(month), parseInt(year));
  }

  @Get()
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getSalaryRecords(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getSalaryRecords(
      workspaceId,
      parseInt(month),
      parseInt(year),
      req.user.sub,
    );
  }

  @Get('paginated')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getSalaryRecordsPaginated(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query() query: GetSalaryRecordsPaginatedDto,
    @Req() req: AuthenticatedRequest,
  ) {
    this.logger.log(
      `[salary/paginated] request workspace=${workspaceId} month=${month} year=${year} page=${query.page ?? 1} limit=${query.limit ?? 50} search=${query.search ?? ''} status=${query.status ?? 'all'} sortBy=${query.sortBy ?? 'name'} sortOrder=${query.sortOrder ?? 'asc'}`,
    );

    return this.salaryService.getSalaryRecordsPaginated(
      workspaceId,
      parseInt(month),
      parseInt(year),
      {
        page: query.page,
        limit: query.limit,
        search: query.search,
        shiftId: query.shiftId,
        teamMemberId: query.teamMemberId,
        status: query.status,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        userId: req.user.sub,
      },
    );
  }

  @Get('overview')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getPayrollOverview(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    this.logger.log(
      `[salary/overview] request workspace=${workspaceId} month=${month} year=${year}`,
    );

    return this.salaryService.getPayrollOverview(workspaceId, parseInt(month), parseInt(year));
  }

  @Get('gratuity')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'gratuity_tracking',
  })
  getWorkspaceGratuitySummary(@Param('workspaceId') workspaceId: string) {
    return this.salaryService.getWorkspaceGratuitySummary(workspaceId);
  }

  @Get('gratuity/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'gratuity_tracking',
  })
  getGratuityLedger(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getGratuityLedger(workspaceId, teamMemberId, req.user.sub);
  }

  @Get('fnf')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'fnf_settlement',
  })
  getWorkspaceFnfList(@Param('workspaceId') workspaceId: string) {
    return this.salaryService.getWorkspaceFnfList(workspaceId);
  }

  @Get('fnf/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'fnf_settlement',
  })
  getFnfSettlement(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getFnfSettlement(workspaceId, teamMemberId, req.user.sub);
  }

  @Post('fnf/:teamMemberId/initiate')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'fnf_settlement',
  })
  initiateFnf(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Body() body: InitiateFnfBody,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.lastWorkingDate) {
      throw new BadRequestException('lastWorkingDate is required');
    }

    return this.salaryService.initiateFnf(
      workspaceId,
      teamMemberId,
      {
        lastWorkingDate: body.lastWorkingDate,
        noticePeriodDays: body.noticePeriodDays ?? 0,
        noticeServedDays: body.noticeServedDays ?? 0,
        // Omitted → FnfService auto-computes from the leave balance. An explicit
        // value (incl. 0) is a manual override.
        leaveBalanceDays: body.leaveBalanceDays,
        otherAdditions: body.otherAdditions || [],
        otherDeductions: body.otherDeductions || [],
        notes: body.notes || '',
        resignationReason: body.resignationReason || '',
      },
      req.user.sub,
    );
  }

  @Post('fnf/:teamMemberId/finalise')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'fnf_settlement',
  })
  finaliseFnf(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.finaliseFnf(workspaceId, teamMemberId, req.user.sub);
  }

  // OQ-S1: statutory exports (ECR / ESI challan / bank file) carry employee PAN,
  // UAN, ESI IP and bank account numbers. The `@RequirePermissions(VIEW,'all')`
  // route guard still admits Managers, so we add an explicit HR+Owner service gate
  // (assertSalaryComplianceExportAllowed) — a Manager gets 403 SALARY_EXPORT_FORBIDDEN.
  @Get('compliance/ecr')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'compliance_exports',
  })
  async getEcrExport(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.salaryService.getEcrExport(workspaceId, parseInt(month), parseInt(year));
  }

  @Get('compliance/esi-challan')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'compliance_exports',
  })
  async getEsiChallanExport(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.salaryService.getEsiChallanExport(workspaceId, parseInt(month), parseInt(year));
  }

  @Get('compliance/bank-file')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'compliance_exports',
  })
  async getBankFileExport(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.salaryService.getBankFileExport(workspaceId, parseInt(month), parseInt(year));
  }

  @Get('by-shift-summary')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getSalaryShiftSummaries(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query() query: GetSalaryShiftSummariesDto,
  ) {
    this.logger.log(
      `[salary/shift-summary] request workspace=${workspaceId} month=${month} year=${year} search=${query.search ?? ''} status=${query.status ?? 'all'}`,
    );

    return this.salaryService.getSalaryShiftSummaries(
      workspaceId,
      parseInt(month),
      parseInt(year),
      {
        search: query.search,
        teamMemberId: query.teamMemberId,
        status: query.status,
      },
    );
  }

  @Patch(':recordId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({ module: AppModule.SALARY, subFeature: 'edit_salary' })
  updateSalaryRecord(
    @Param('workspaceId') workspaceId: string,
    @Param('recordId') recordId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateSalaryRecordDto,
  ) {
    return this.salaryService.updateSalaryRecord(workspaceId, recordId, dto, req.user.sub);
  }

  @Post('ensure-record')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({ module: AppModule.SALARY, subFeature: 'edit_salary' })
  ensureSalaryRecord(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: EnsureSalaryRecordBody,
  ) {
    if (!body.teamMemberId || body.month === undefined || body.year === undefined) {
      throw new BadRequestException('teamMemberId, month, and year are required');
    }

    if (body.month < 1 || body.month > 12) {
      throw new BadRequestException('month must be between 1 and 12');
    }

    return this.salaryService.ensureSingleEmployeeRecord(
      workspaceId,
      body.teamMemberId,
      body.month,
      body.year,
      new Types.ObjectId(req.user.sub),
    );
  }

  @Patch('set-base-pay')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({ module: AppModule.SALARY, subFeature: 'edit_salary' })
  setBasePay(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: SetBasePayBodyDto,
  ) {
    const validatedBody = this.validateSetBasePayBody(workspaceId, body);

    return this.salaryService.setBasePay(
      workspaceId,
      validatedBody.teamMemberId,
      validatedBody.salaryConfig,
      validatedBody.salaryRecordUpdate,
      new Types.ObjectId(req.user.sub),
    );
  }

  @Patch(':salaryId/lock')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({ module: AppModule.SALARY, subFeature: 'edit_salary' })
  lockSalaryRecord(
    @Param('workspaceId') workspaceId: string,
    @Param('salaryId') salaryId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.lockSalaryRecord(
      workspaceId,
      salaryId,
      new Types.ObjectId(req.user.sub),
    );
  }

  @Patch(':salaryId/unlock')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({ module: AppModule.SALARY, subFeature: 'edit_salary' })
  unlockSalaryRecord(
    @Param('workspaceId') workspaceId: string,
    @Param('salaryId') salaryId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.unlockSalaryRecord(
      workspaceId,
      salaryId,
      new Types.ObjectId(req.user.sub),
    );
  }

  @Post(':salaryId/adjustments')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'salary_adjustments_create',
  })
  createAdjustment(
    @Param('workspaceId') workspaceId: string,
    @Param('salaryId') salaryId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateSalaryAdjustmentDto,
  ) {
    return this.salaryService.createAdjustment(workspaceId, salaryId, req.user.sub, dto);
  }

  @Get(':salaryId/adjustments')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'salary_adjustments_view',
  })
  listAdjustmentsForSalary(
    @Param('workspaceId') workspaceId: string,
    @Param('salaryId') salaryId: string,
  ) {
    return this.salaryService.listAdjustmentsForSalary(workspaceId, salaryId);
  }

  @Post('adjustments/:adjustmentId/reverse')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'salary_adjustments_reverse',
  })
  reverseAdjustment(
    @Param('workspaceId') workspaceId: string,
    @Param('adjustmentId') adjustmentId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: ReverseSalaryAdjustmentDto,
  ) {
    return this.salaryService.reverseAdjustment(workspaceId, adjustmentId, req.user.sub, dto);
  }

  @Get('adjustments/:adjustmentId/audit')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'salary_adjustments_view_audit',
  })
  getAdjustmentAuditTrail(
    @Param('workspaceId') workspaceId: string,
    @Param('adjustmentId') adjustmentId: string,
  ) {
    return this.salaryService.getAdjustmentAuditTrail(workspaceId, adjustmentId);
  }

  @Post('payments')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'record_payment',
  })
  recordPayment(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RecordPaymentDto,
  ) {
    return this.salaryService.recordPayment(workspaceId, req.user.sub, dto);
  }

  @Post('payments/bulk')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'bulk_payments',
  })
  recordBulkPayment(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: BulkRecordPaymentDto,
  ) {
    return this.salaryService.recordBulkPayment(workspaceId, req.user.sub, dto);
  }

  @Get('payments')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getPayments(@Param('workspaceId') workspaceId: string, @Query('salaryId') salaryId?: string) {
    return this.salaryService.getPayments(workspaceId, salaryId);
  }

  @Get('payments/register')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getPaymentRegister(
    @Param('workspaceId') workspaceId: string,
    @Query() query: GetPaymentRegisterDto,
  ) {
    this.logger.log(
      `[salary/payments-register] request workspace=${workspaceId} month=${query.month ?? ''} year=${query.year ?? ''} page=${query.page ?? 1} limit=${query.limit ?? 25} search=${query.search ?? ''} status=${query.status ?? 'all'} teamMemberId=${query.teamMemberId ?? ''}`,
    );

    return this.salaryService.getPaymentRegister(workspaceId, {
      month: query.month,
      year: query.year,
      page: query.page,
      limit: query.limit,
      search: query.search,
      status: query.status,
      teamMemberId: query.teamMemberId,
    });
  }

  @Post('payslip-data')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_generation',
  })
  async getPayslipData(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { salaryIds: string[] },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.salaryIds || !Array.isArray(body.salaryIds) || body.salaryIds.length === 0) {
      throw new BadRequestException('salaryIds array is required');
    }

    if (body.salaryIds.length > 50) {
      throw new BadRequestException('Maximum 50 payslips per request');
    }

    const results = await this.salaryService.getPayslipData(workspaceId, body.salaryIds);

    // Salary A3: strip PII from each item's record.teamMemberId sub-object.
    // getPayslipData builds teamMemberId as an explicit object including
    // bankDetails/upiDetails/preferredMethod (for the self payslip download
    // path). We filter here in the admin handler so the self path
    // (getOwnPayslipDownload) remains untouched and the worker's own PDF
    // still has bank details.
    const sens = await this.salaryService.resolveSalarySensitiveCtx(workspaceId, req.user.sub);
    for (const item of results) {
      const teamMemberId = item.record.teamMemberId;
      if (teamMemberId && typeof teamMemberId === 'object') {
        const m = teamMemberId as Record<string, unknown>;
        const memberId = m._id != null ? String(m._id) : '';
        stripSalarySensitiveFields(m, {
          isOwner: sens.isOwner,
          isOwnRecord: sens.ownTeamMemberId != null && sens.ownTeamMemberId === memberId,
          canViewSensitive: sens.canViewSensitive,
        });
      }
    }

    return results;
  }

  @Post('send-payslip-email')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_generation',
  })
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_email',
  })
  sendPayslipEmail(
    @Param('workspaceId') workspaceId: string,
    @Body() body: SendPayslipEmailBody,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.salaryId) {
      throw new BadRequestException('salaryId is required');
    }

    return this.salaryService.sendPayslipEmail(workspaceId, body.salaryId, req.user.sub);
  }

  @Get('monthly-task-status')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getMonthlyTaskStatus(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (!m || !y || m < 1 || m > 12) {
      throw new BadRequestException('Valid month (1-12) and year are required');
    }
    return this.salaryService.getMonthlyTaskStatus(workspaceId, m, y);
  }

  @Post('send-payslip-email/bulk')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_generation',
  })
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_email',
  })
  sendBulkPayslipEmails(
    @Param('workspaceId') workspaceId: string,
    @Body() body: SendBulkPayslipEmailsBody,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException('items array is required');
    }

    const invalidItem = body.items.find((item) => !item.salaryId);

    if (invalidItem) {
      throw new BadRequestException('Each item requires salaryId');
    }

    return this.salaryService.sendBulkPayslipEmails(
      workspaceId,
      body.items.map((item) => item.salaryId),
      req.user.sub,
    );
  }

  // â”€â”€ Async Bulk Email Payslips (server-side PDF) â”€â”€â”€

  @Post('bulk-email-payslips')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_generation',
  })
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_email',
  })
  triggerBulkPayslipEmails(
    @Param('workspaceId') workspaceId: string,
    @Body() body: TriggerBulkEmailBody,
  ) {
    if (!body.month || !body.year) {
      throw new BadRequestException('month and year are required');
    }

    return this.salaryService.triggerBulkPayslipEmails(workspaceId, body.month, body.year);
  }

  @Get('bulk-email-payslips/:jobId/status')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getBulkEmailJobStatus(@Param('workspaceId') workspaceId: string, @Param('jobId') jobId: string) {
    return this.salaryService.getBulkEmailJobStatus(workspaceId, jobId);
  }

  @Post('bulk-email-payslips/:jobId/cancel')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  cancelBulkEmailJob(@Param('workspaceId') workspaceId: string, @Param('jobId') jobId: string) {
    return this.salaryService.cancelBulkEmailJob(workspaceId, jobId);
  }

  // NOTE: static route 'advances/:teamMemberId/balance' must be declared
  // BEFORE 'advances/:teamMemberId' so Nest's router does not treat the
  // literal "balance" segment as a teamMemberId value.
  @Get('advances/:teamMemberId/balance')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  getAdvanceBalanceSummary(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getAdvanceBalanceSummary(workspaceId, teamMemberId, req.user.sub);
  }

  @Get('advances/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  getOutstandingAdvances(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getOutstandingAdvances(workspaceId, teamMemberId, req.user.sub);
  }

  // -------------------------------------------------------------------------
  // Advance Recovery Plan endpoints (Task 5)
  //
  // ROUTE ORDER: static routes (preview, detail/:planId) are declared BEFORE
  // the param route (advance-plans/:teamMemberId) so Nest's router does not
  // treat the literal "preview" segment as a teamMemberId value.
  // -------------------------------------------------------------------------

  @Post('advance-plans/preview')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'advance_payments',
  })
  previewAdvanceSchedule(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PreviewAdvanceScheduleDto,
  ) {
    return this.salaryService.previewAdvanceSchedule(workspaceId, dto);
  }

  @Get('advance-plans/detail/:planId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'advance_payments',
  })
  getAdvanceRecoveryPlanDetail(
    @Param('workspaceId') workspaceId: string,
    @Param('planId') planId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getAdvanceRecoveryPlanDetail(workspaceId, planId, req.user.sub);
  }

  @Get('advance-plans/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'advance_payments',
  })
  getAdvanceRecoveryPlans(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getAdvanceRecoveryPlans(workspaceId, teamMemberId, req.user.sub);
  }

  @Patch('advance-plans/:planId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'advance_payments',
  })
  editAdvanceRecoveryPlan(
    @Param('workspaceId') workspaceId: string,
    @Param('planId') planId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: EditAdvanceRecoveryPlanDto,
  ) {
    return this.salaryService.editAdvanceRecoveryPlan(workspaceId, planId, req.user.sub, dto);
  }

  @Post('advance-plans/:planId/early-payoff')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'advance_payments',
  })
  earlyPayoffAdvanceRecoveryPlan(
    @Param('workspaceId') workspaceId: string,
    @Param('planId') planId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: EarlyPayoffAdvanceRecoveryPlanDto,
  ) {
    return this.salaryService.earlyPayoffAdvanceRecoveryPlan(
      workspaceId,
      planId,
      req.user.sub,
      dto,
    );
  }

  @Post('payments/:paymentId/reverse')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'reverse_payment',
  })
  reversePayment(
    @Param('workspaceId') workspaceId: string,
    @Param('paymentId') paymentId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: ReversePaymentDto,
  ) {
    return this.salaryService.reversePayment(workspaceId, paymentId, req.user.sub, dto);
  }

  @Get('payments/:paymentId/audit')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getPaymentAuditTrail(
    @Param('workspaceId') workspaceId: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.salaryService.getPaymentAuditTrail(workspaceId, paymentId);
  }

  @Get('history/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  getLedgerHistory(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getLedgerHistory(workspaceId, teamMemberId, req.user.sub);
  }

  @Get('history/:teamMemberId/payslip/:salaryId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'payslip_generation',
  })
  getOwnPayslipDownload(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Param('salaryId') salaryId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getOwnPayslipDownload(
      workspaceId,
      teamMemberId,
      salaryId,
      req.user.sub,
    );
  }

  @Get('form16/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'form16_generation',
  })
  getForm16Data(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Query() query: GetTaxDeclarationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getForm16Data(
      workspaceId,
      teamMemberId,
      query.financialYear,
      req.user.sub,
    );
  }

  @Post('increments')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'salary_increments',
  })
  addIncrement(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateIncrementDto,
  ) {
    return this.salaryService.addIncrement(workspaceId, req.user.sub, dto);
  }

  @Get('increments')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  getIncrements(
    @Param('workspaceId') workspaceId: string,
    @Query('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getIncrements(workspaceId, teamMemberId, req.user.sub);
  }

  @Delete('increments/:id')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'salary_increments',
  })
  deleteIncrement(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.salaryService.deleteIncrement(workspaceId, id);
  }

  @Get('tax-declaration/:teamMemberId/tds-preview')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'statutory_tds',
  })
  getTdsPreview(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Query() query: GetTdsPreviewQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getTdsPreview(
      workspaceId,
      teamMemberId,
      query.month,
      query.year,
      req.user.sub,
    );
  }

  @Get('tax-declaration/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'statutory_tds',
  })
  getTaxDeclaration(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Query() query: GetTaxDeclarationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.getTaxDeclaration(
      workspaceId,
      teamMemberId,
      query.financialYear,
      req.user.sub,
    );
  }

  // OQ-S6 (security-review fix HIGH-1): gated on the DEDICATED self-service action
  // `salary.declare_tax` (scope=self) — NOT salary.edit. The seeded Worker/Karigar
  // role carries NO salary.edit grant, so the previous EDIT@self gate 403'd a real
  // worker in RolesGuard before this route ever ran, leaving OQ-S6 inert. The new
  // action mirrors REQUEST_ADVANCE: Worker holds declare_tax@self (self path),
  // HR holds declare_tax@all and Owner bypasses (the all path), so a single route
  // serves both. The service (upsertTaxDeclaration) resolves self-vs-all on
  // `declare_tax`: a self-scoped worker may only write their own FY and cannot set
  // the lock flag; HR/Owner (all) may write anyone and lock at the cutoff.
  @Put('tax-declaration/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.DECLARE_TAX, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'statutory_tds',
  })
  upsertTaxDeclaration(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpsertTaxDeclarationDto,
  ) {
    return this.salaryService.upsertTaxDeclaration(workspaceId, teamMemberId, dto, req.user.sub);
  }

  // OQ-S3: PayrollConfig is readable by Managers (they run payroll), but the
  // `deductor` (employer TAN/PAN) and `statutory` registration codes (PF/ESI) are
  // statutory-sensitive employer identity. We strip them for non-HR callers via
  // the config-read-filter (mirrors the salary PII read-filter). HR+Owner get all.
  @Get('payroll-config')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  async getPayrollConfig(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const config = await this.salaryService.getPayrollConfig(workspaceId);
    const sens = await this.salaryService.resolveSalarySensitiveCtx(workspaceId, req.user.sub);
    // Convert to a plain object so the strip never mutates a live document.
    const plain =
      config && typeof (config as { toObject?: unknown }).toObject === 'function'
        ? (config as unknown as { toObject: () => Record<string, unknown> }).toObject()
        : (config as unknown as Record<string, unknown>);
    stripPayrollConfigSensitiveFields(plain, {
      isOwner: sens.isOwner,
      canViewSensitive: sens.canViewSensitive,
    });
    return plain;
  }

  @Put('payroll-config')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'statutory_compliance',
  })
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'lwf_tracking',
  })
  updatePayrollConfig(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdatePayrollConfigDto,
  ) {
    return this.salaryService.updatePayrollConfig(workspaceId, dto);
  }

  @Get('component-templates')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  listComponentTemplates(@Param('workspaceId') workspaceId: string) {
    return this.salaryService.listComponentTemplates(workspaceId);
  }

  @Post('component-templates')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  createComponentTemplate(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateSalaryComponentTemplateDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.createComponentTemplate(workspaceId, dto, req.user.sub);
  }

  @Post('component-templates/seed')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  seedComponentTemplate(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SeedComponentTemplateDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.salaryService.seedComponentTemplate(workspaceId, dto.templateKey, req.user.sub);
  }

  @Put('component-templates/:templateId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  updateComponentTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateSalaryComponentTemplateDto,
  ) {
    return this.salaryService.updateComponentTemplate(workspaceId, templateId, dto);
  }

  @Delete('component-templates/:templateId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  deleteComponentTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.salaryService.deleteComponentTemplate(workspaceId, templateId);
  }

  // OQ-S1: the canonical bank-file rows carry employee bank account numbers →
  // HR+Owner only (same gate as the compliance exports above).
  @Get('bank-file')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'compliance_exports',
  })
  async getBankFileRows(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.salaryService.getBankFileRowsCanonical(
      workspaceId,
      parseInt(month),
      parseInt(year),
    );
  }

  // â”€â”€ Phase 23 (D-06 / D-11) â€” Piece-Rate Preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // GET /workspaces/:workspaceId/salary/piece-rate/preview
  //   ?teamMemberId=&month=&year=
  //
  // Returns a live computation of piece-rate earnings for the given worker
  // and month. Throws 400 PIECE_RATE_NOT_CONFIGURED when the worker has no
  // pieceRateConfig and 400 PAYROLL_MONTH_LOCKED when the month is already
  // locked. Permission: salary.piece_rate.manage; sub-feature gate:
  // piece_rate_payroll on MACHINES (D-10).
  @Get('piece-rate/preview')
  @RequirePermissions(AppModule.SALARY, SALARY_PERMISSIONS.MANAGE_PIECE_RATE)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'piece_rate_payroll',
  })
  previewPieceRateEarnings(
    @Param('workspaceId') workspaceId: string,
    @Query() q: PreviewPieceRateQueryDto,
  ) {
    return this.salaryService.previewPieceRateEarnings(workspaceId, {
      teamMemberId: q.teamMemberId,
      month: Number(q.month),
      year: Number(q.year),
    });
  }

  // ---------------------------------------------------------------------------
  // Employer Loan endpoints (Slice 2)
  //
  // ROUTE ORDER: static routes (preview, dashboard, detail/:loanId) are
  // declared BEFORE the param routes (loans/:teamMemberId) so Nest's router
  // does not treat literal segments as teamMemberId / loanId values.
  // Pattern mirrors the advance-plan route ordering at line 822.
  //
  // All routes are under the prefix loans/ within the existing
  // /api/workspaces/:workspaceId/salary/ controller.
  // Spec: phase-2-loan-module.md section 5.3
  // ---------------------------------------------------------------------------

  @Post('loans/preview')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  previewLoanSchedule(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PreviewLoanScheduleDto,
  ) {
    return this.loanService.previewLoanSchedule(workspaceId, dto);
  }

  @Get('loans/dashboard')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  getLoanDashboard(
    @Param('workspaceId') workspaceId: string,
    @Query('loanType') loanType?: string,
    @Query('status') status?: string,
  ) {
    return this.loanService.loanDashboard(workspaceId, { loanType, status });
  }

  @Get('loans/detail/:loanId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  getLoanDetail(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.loanService.getLoanDetail(workspaceId, loanId, req.user.sub);
  }

  @Post('loans')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  createLoan(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateLoanDto,
  ) {
    return this.loanService.createLoan(workspaceId, dto, req.user.sub);
  }

  @Get('loans/:teamMemberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  listLoans(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.loanService.listLoans(workspaceId, teamMemberId, req.user.sub);
  }

  @Get('loans/:teamMemberId/outstanding')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  getOutstandingLoanAmount(
    @Param('workspaceId') workspaceId: string,
    @Param('teamMemberId') teamMemberId: string,
  ) {
    return this.loanService.getOutstandingLoanAmount(workspaceId, teamMemberId);
  }

  // ---------------------------------------------------------------------------
  // Loan lifecycle endpoints (Slice 3)
  //
  // All routes require EDIT all + loan_management sub-feature.
  // Spec: phase-2-loan-module.md section 5.3 + Slice C decomposition.
  // ---------------------------------------------------------------------------

  @Post('loans/:loanId/approve')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  approveLoan(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: ApproveLoanDto,
  ) {
    return this.loanService.approveLoan(workspaceId, loanId, req.user.sub, dto);
  }

  @Post('loans/:loanId/skip-installment')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  skipLoanInstallment(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: SkipInstallmentDto,
  ) {
    return this.loanService.skipInstallment(workspaceId, loanId, req.user.sub, dto);
  }

  @Patch('loans/:loanId/pause-resume')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  pauseResumeLoan(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: PauseResumeLoanDto,
  ) {
    return this.loanService.pauseResumeLoan(workspaceId, loanId, req.user.sub, dto);
  }

  @Post('loans/:loanId/early-payoff')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  earlyPayoffLoan(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: EarlyPayoffLoanDto,
  ) {
    return this.loanService.earlyPayoffLoan(workspaceId, loanId, req.user.sub, dto);
  }

  @Post('loans/:loanId/top-up')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  topUpLoan(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: TopUpLoanDto,
  ) {
    return this.loanService.topUpLoan(workspaceId, loanId, req.user.sub, dto);
  }

  @Post('loans/:loanId/write-off')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'loan_management',
  })
  writeOffLoan(
    @Param('workspaceId') workspaceId: string,
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: WriteOffLoanDto,
  ) {
    return this.loanService.writeOffLoan(workspaceId, loanId, req.user.sub, dto);
  }

  // ---------------------------------------------------------------------------
  // Commission / Incentive endpoints (Phase 3B)
  //
  // ROUTE ORDER: static routes (entries, ytd, schedules static sub-paths)
  // declared BEFORE param routes (schedules/:scheduleId) to prevent Nest
  // treating literal segments as schedule IDs.
  //
  // All write endpoints: EDIT all + commissionTracking feature (enforced in
  // service). All read endpoints: VIEW all.
  // Spec: phase-3-bonus-commission-ledger.md section 4B
  // ---------------------------------------------------------------------------

  /**
   * POST /salary/commission/entries
   * Bulk-capable structured commission/incentive create.
   * Posts one SalaryAdjustment per entry (single ledger; identical rows to
   * the Record Payment modal's "Add commission" quick-add).
   */
  @Post('commission/entries')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'commission_tracking',
  })
  recordCommissionEntries(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RecordCommissionEntriesDto,
  ) {
    return this.commissionService.recordCommissionEntries(workspaceId, dto, req.user.sub);
  }

  /**
   * GET /salary/commission/entries
   * List commission/incentive SalaryAdjustment rows.
   * Supports filter by teamMemberId, month, year, category.
   */
  @Get('commission/entries')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  listCommissionEntries(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListCommissionEntriesQueryDto,
  ) {
    return this.commissionService.listCommissionEntries(workspaceId, query);
  }

  /**
   * GET /salary/commission/ytd
   * Year-to-date commission + incentive totals.
   * Aggregates from SalaryAdjustment rows (single source; includes both
   * modal-entered and structured-section entries).
   */
  @Get('commission/ytd')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getCommissionYtd(
    @Param('workspaceId') workspaceId: string,
    @Query() query: CommissionYtdQueryDto,
  ) {
    return this.commissionService.getCommissionYtd(workspaceId, query);
  }

  /**
   * GET /salary/commission/schedules
   * List commission schedule rules (not the money rows).
   */
  @Get('commission/schedules')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  listCommissionSchedules(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListSchedulesQueryDto,
  ) {
    return this.commissionService.listSchedules(workspaceId, query);
  }

  /**
   * POST /salary/commission/schedules
   * Create a recurring commission schedule rule.
   */
  @Post('commission/schedules')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'commission_tracking',
  })
  createCommissionSchedule(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateCommissionScheduleDto,
  ) {
    return this.commissionService.createSchedule(workspaceId, dto, req.user.sub);
  }

  /**
   * GET /salary/commission/schedules/:scheduleId
   * Single schedule with disbursement log.
   */
  @Get('commission/schedules/:scheduleId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getCommissionSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('scheduleId') scheduleId: string,
  ) {
    return this.commissionService.getSchedule(workspaceId, scheduleId);
  }

  /**
   * PATCH /salary/commission/schedules/:scheduleId
   * Update amount, dates, note, or pause/resume status.
   */
  @Patch('commission/schedules/:scheduleId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'commission_tracking',
  })
  updateCommissionSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('scheduleId') scheduleId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateCommissionScheduleDto,
  ) {
    return this.commissionService.updateSchedule(workspaceId, scheduleId, dto, req.user.sub);
  }

  /**
   * DELETE /salary/commission/schedules/:scheduleId
   * Soft-delete (sets status='completed').
   */
  @Delete('commission/schedules/:scheduleId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'commission_tracking',
  })
  deleteCommissionSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('scheduleId') scheduleId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.commissionService.deleteSchedule(workspaceId, scheduleId, req.user.sub);
  }

  /**
   * POST /salary/commission/schedules/:scheduleId/disburse
   * Manually trigger disbursement for a specific period.
   * Idempotent: re-submitting the same month+year returns the existing
   * adjustmentId and wasAlreadyDisbursed=true.
   */
  @Post('commission/schedules/:scheduleId/disburse')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'commission_tracking',
  })
  disburseCommissionSchedule(
    @Param('workspaceId') workspaceId: string,
    @Param('scheduleId') scheduleId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: DisburseScheduleDto,
  ) {
    return this.commissionService.disburseSchedule(
      workspaceId,
      scheduleId,
      dto,
      req.user.sub,
      false,
    );
  }

  // ---------------------------------------------------------------------------
  // Bonus endpoints (Phase 3A)
  //
  // ROUTE ORDER: static sub-paths (config, preview, run, festival, summary, runs)
  // declared BEFORE param routes (runs/:runId) to prevent Nest treating literals
  // as run IDs.
  //
  // All write endpoints: EDIT all + bonus_tracking subscription feature.
  // All read endpoints: VIEW all.
  // Spec: phase-3-bonus-commission-ledger.md section 4A (Bonus Module)
  // ---------------------------------------------------------------------------

  /**
   * GET /salary/bonus/config
   * Get the workspace statutory bonus policy.
   */
  @Get('bonus/config')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getBonusConfig(@Param('workspaceId') workspaceId: string) {
    return this.bonusService.getBonusConfig(workspaceId);
  }

  /**
   * PATCH /salary/bonus/config
   * Update statutory bonus policy (HR/Owner only).
   * CONFIRM ALL THRESHOLD CHANGES WITH YOUR CA BEFORE SAVING.
   */
  @Patch('bonus/config')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'bonus_tracking',
  })
  updateBonusConfig(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateBonusConfigDto,
  ) {
    return this.bonusService.updateBonusConfig(workspaceId, dto, req.user.sub);
  }

  /**
   * POST /salary/bonus/preview
   * Run the statutory engine for a given FY. Returns per-member breakdown
   * WITHOUT writing any data. Safe to call repeatedly.
   */
  @Post('bonus/preview')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  previewStatutoryBonus(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: PreviewStatutoryBonusDto,
  ) {
    return this.bonusService.previewStatutoryBonus(workspaceId, dto);
  }

  /**
   * POST /salary/bonus/run
   * Persist bonus SalaryAdjustment rows for all eligible members for a FY.
   * Creates a BonusRun entity (rules/summary only; money in SalaryAdjustment).
   * Idempotent per (member, FY): re-run skips already-paid members.
   * Handles countsAsStatutory festival shortfall to avoid double-obligation.
   */
  @Post('bonus/run')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'bonus_tracking',
  })
  runStatutoryBonus(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RunStatutoryBonusDto,
  ) {
    return this.bonusService.runStatutoryBonus(workspaceId, dto, req.user.sub);
  }

  /**
   * POST /salary/bonus/festival
   * Record festival / discretionary bonus for one or many members.
   * Creates bonus SalaryAdjustment rows (single ledger).
   * Set countsAsStatutory=true to satisfy the statutory obligation so the
   * statutory run does not double-post for the same FY.
   */
  @Post('bonus/festival')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'bonus_tracking',
  })
  recordFestivalBonus(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RecordFestivalBonusDto,
  ) {
    return this.bonusService.recordFestivalBonus(workspaceId, dto, req.user.sub);
  }

  /**
   * GET /salary/bonus/summary
   * Per-member and workspace bonus totals for the year (from bonus SalaryAdjustments).
   * Single source: includes all entry points without double-counting.
   */
  @Get('bonus/summary')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getBonusSummary(@Param('workspaceId') workspaceId: string, @Query() query: BonusSummaryQueryDto) {
    return this.bonusService.getBonusSummary(workspaceId, query);
  }

  /**
   * GET /salary/bonus/runs
   * List all BonusRun entities for a workspace (optional FY and type filter).
   */
  @Get('bonus/runs')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  listBonusRuns(
    @Param('workspaceId') workspaceId: string,
    @Query('financialYear') financialYear?: string,
    @Query('bonusType') bonusType?: string,
  ) {
    return this.bonusService.listBonusRuns(workspaceId, {
      financialYear: financialYear ? parseInt(financialYear, 10) : undefined,
      bonusType,
    });
  }

  /**
   * GET /salary/bonus/runs/:runId
   * Single BonusRun with per-member rows and back-references to adjustment IDs.
   */
  @Get('bonus/runs/:runId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getBonusRun(@Param('workspaceId') workspaceId: string, @Param('runId') runId: string) {
    return this.bonusService.getBonusRun(workspaceId, runId);
  }

  // ---------------------------------------------------------------------------
  // Cash Ledger / Daily-Wage Ledger endpoints (Phase 3C)
  //
  // CONCEPT: per-worker running baki/udhaar account for daily-wage and
  // piece-rate karigars. Intentionally SEPARATE from AdvanceRecoveryPlan
  // (formal monthly-salary advance). See cash-ledger.service.ts for the
  // distinction.
  //
  // ROUTE ORDER: static routes (entries, balances, settle) declared BEFORE
  // param routes (ledger/:memberId) to prevent Nest treating literal segments
  // as member IDs.
  //
  // All write endpoints: EDIT all + dailyWageLedger feature (enforced in service).
  // All read endpoints: VIEW all.
  // Spec: phase-3-bonus-commission-ledger.md section 4C
  // ---------------------------------------------------------------------------

  /**
   * POST /salary/ledger/entries
   * Bulk-capable create for earning, draw, and adjustment entries.
   * Up to 50 entries per call (matches UI bulk-entry form limit).
   * Settlement entries are created via POST /salary/ledger/settle.
   */
  @Post('ledger/entries')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'daily_wage_ledger',
  })
  recordLedgerEntries(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RecordLedgerEntriesDto,
  ) {
    return this.cashLedgerService.recordEntries(workspaceId, dto, req.user.sub);
  }

  /**
   * GET /salary/ledger/balances
   * Workspace-level balance board: per-worker current balance.
   * Default filter: non-zero balances only.
   * Positive = owner owes worker (baki). Negative = worker overdrawn (udhaar).
   */
  @Get('ledger/balances')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  getWorkspaceLedgerBalances(
    @Param('workspaceId') workspaceId: string,
    @Query() query: WorkspaceBalanceQueryDto,
  ) {
    return this.cashLedgerService.getWorkspaceBalances(workspaceId, query);
  }

  /**
   * POST /salary/ledger/settle
   * Settle one or many workers up to a cutoff date.
   * Creates a settlement entry, marks covered earning/draw entries as settled,
   * and returns the settled amount + a minimum-wage flag per worker.
   * The minimum-wage flag is a WARNING only; it does not block settlement.
   */
  @Post('ledger/settle')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'daily_wage_ledger',
  })
  settleLedger(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: SettleDto,
  ) {
    return this.cashLedgerService.settle(workspaceId, dto, req.user.sub);
  }

  /**
   * GET /salary/ledger/:memberId
   * Per-member ledger entries with running balance over an optional date range.
   *
   * OQ-S7: scope relaxed to 'self' so a Karigar can read their OWN running
   * balance (baki/udhaar) — transparency reduces disputes. Writes stay
   * Manager-only ('all'). The self-vs-all narrowing is enforced server-side via
   * SalaryService.assertSalaryLedgerReadAllowed (reuses the salary.view scope
   * resolver), so a self-scoped worker can never read another member's ledger.
   */
  @Get('ledger/:memberId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'self')
  async getMemberLedger(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Query() query: LedgerQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryLedgerReadAllowed(workspaceId, req.user.sub, memberId);
    return this.cashLedgerService.getMemberLedger(workspaceId, memberId, query);
  }

  /**
   * PATCH /salary/ledger/entries/:entryId
   * Correct an open entry: update amount, date, or note.
   * Settled entries and settlement-type entries are immutable.
   */
  @Patch('ledger/entries/:entryId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'daily_wage_ledger',
  })
  updateLedgerEntry(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: { amount?: number; date?: string; note?: string },
  ) {
    return this.cashLedgerService.updateEntry(workspaceId, entryId, body, req.user.sub);
  }

  /**
   * DELETE /salary/ledger/entries/:entryId
   * Soft-delete an open entry by creating a counter-adjustment.
   * The original entry is preserved for audit trail.
   * Settled entries and settlement-type entries cannot be soft-deleted.
   */
  @Delete('ledger/entries/:entryId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'daily_wage_ledger',
  })
  softDeleteLedgerEntry(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.cashLedgerService.softDeleteEntry(workspaceId, entryId, req.user.sub);
  }

  // ---------------------------------------------------------------------------
  // D-10: COA cash/bank account picker endpoint
  // ---------------------------------------------------------------------------

  /**
   * GET /workspaces/:workspaceId/salary/coa-accounts
   *
   * Returns the workspace's cash/bank COA accounts for the Pay drawer picker.
   * Also returns the last-used account for pre-selection and a financeConfigured
   * flag — when false the UI shows a "Set up Finance module" banner (D-07).
   */
  @Get('coa-accounts')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW, 'all')
  listCoaCashBankAccounts(@Param('workspaceId') workspaceId: string) {
    return this.salaryService.listCoaCashBankAccounts(workspaceId);
  }

  // ---------------------------------------------------------------------------
  // D-01 / D-03 owner-only config PATCH endpoints
  // ---------------------------------------------------------------------------

  @Patch('disbursement-rules')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  updateDisbursementRules(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateDisbursementRulesDto,
  ) {
    return this.salaryService.updateDisbursementRules(workspaceId, dto);
  }

  @Patch('salary-loss-config')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  updateSalaryLossConfig(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateSalaryLossConfigDto,
  ) {
    return this.salaryService.updateSalaryLossConfig(workspaceId, dto);
  }

  @Patch('attendance-rules')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  updateAttendanceRules(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateAttendanceRulesDto,
  ) {
    return this.salaryService.updateAttendanceRules(workspaceId, dto);
  }
}
