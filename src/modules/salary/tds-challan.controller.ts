import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { TdsChallanService } from './tds-challan.service';
// OQ-S1 Gap 3: TDS challans are statutory-filing artifacts (BSR / challan serial /
// deposit amounts) → HR+Owner only. SalaryService.assertSalaryComplianceExportAllowed
// is the shared HR-gate (owner OR salary.sensitive_view); reusing it keeps "who is
// HR" identical across the salary module.
import { SalaryService } from './salary.service';

type AuthenticatedRequest = {
  user: {
    sub: string;
  };
};

type CreateTdsChallanBody = {
  month?: number;
  year?: number;
  bsrCode?: string;
  bankName?: string;
  branchName?: string;
  challanSerialNo?: string;
  depositDate?: string;
  tdsTotalDeposited?: number;
  interestAmount?: number;
  feeAmount?: number;
  remarks?: string;
};

type UpdateTdsChallanBody = Partial<CreateTdsChallanBody>;

@Controller('workspaces/:workspaceId/salary/tds')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class TdsChallanController {
  constructor(
    private readonly tdsChallanService: TdsChallanService,
    private readonly salaryService: SalaryService,
  ) {}

  private validateCreateBody(body: CreateTdsChallanBody) {
    if (!body.month || body.month < 1 || body.month > 12) {
      throw new BadRequestException('month must be between 1 and 12');
    }

    if (!body.year) {
      throw new BadRequestException('year is required');
    }

    if (!body.bsrCode?.trim()) {
      throw new BadRequestException('bsrCode is required');
    }

    if (!/^\d{7}$/.test(body.bsrCode.trim())) {
      throw new BadRequestException('bsrCode must be a 7-digit code');
    }

    if (!body.challanSerialNo?.trim()) {
      throw new BadRequestException('challanSerialNo is required');
    }

    if (!body.depositDate) {
      throw new BadRequestException('depositDate is required');
    }

    if (typeof body.tdsTotalDeposited !== 'number' || Number.isNaN(body.tdsTotalDeposited)) {
      throw new BadRequestException('tdsTotalDeposited is required');
    }

    return {
      month: body.month,
      year: body.year,
      bsrCode: body.bsrCode.trim(),
      bankName: body.bankName?.trim(),
      branchName: body.branchName?.trim(),
      challanSerialNo: body.challanSerialNo.trim(),
      depositDate: body.depositDate,
      tdsTotalDeposited: body.tdsTotalDeposited,
      interestAmount: body.interestAmount ?? 0,
      feeAmount: body.feeAmount ?? 0,
      remarks: body.remarks?.trim(),
    };
  }

  private validateUpdateBody(body: UpdateTdsChallanBody) {
    if (body.month !== undefined && (body.month < 1 || body.month > 12)) {
      throw new BadRequestException('month must be between 1 and 12');
    }

    if (body.bsrCode !== undefined && !/^\d{7}$/.test(body.bsrCode.trim())) {
      throw new BadRequestException('bsrCode must be a 7-digit code');
    }

    return {
      ...body,
      bsrCode: body.bsrCode?.trim(),
      bankName: body.bankName?.trim(),
      branchName: body.branchName?.trim(),
      challanSerialNo: body.challanSerialNo?.trim(),
      remarks: body.remarks?.trim(),
    };
  }

  @Post('challans')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async createChallan(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateTdsChallanBody,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.createChallan(
      workspaceId,
      this.validateCreateBody(body),
      req.user.sub,
    );
  }

  @Put('challans/:challanId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async updateChallan(
    @Param('workspaceId') workspaceId: string,
    @Param('challanId') challanId: string,
    @Body() body: UpdateTdsChallanBody,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.updateChallan(
      workspaceId,
      challanId,
      this.validateUpdateBody(body),
      req.user.sub,
    );
  }

  @Delete('challans/:challanId')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async deleteChallan(
    @Param('workspaceId') workspaceId: string,
    @Param('challanId') challanId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    await this.tdsChallanService.deleteChallan(workspaceId, challanId);
    return { success: true };
  }

  @Get('challans/quarter')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async getChallansForQuarter(
    @Param('workspaceId') workspaceId: string,
    @Query('financialYear', ParseIntPipe) financialYear: number,
    @Query('quarter', ParseIntPipe) quarter: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.getChallansForQuarter(workspaceId, financialYear, quarter);
  }

  @Get('challans')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async getChallansForFy(
    @Param('workspaceId') workspaceId: string,
    @Query('financialYear', ParseIntPipe) financialYear: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.getChallansForFy(workspaceId, financialYear);
  }

  @Get('liability')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async getTdsLiabilityForMonth(
    @Param('workspaceId') workspaceId: string,
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.getTdsLiabilityForMonth(workspaceId, month, year);
  }

  @Get('summary')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async getTdsQuarterlySummary(
    @Param('workspaceId') workspaceId: string,
    @Query('financialYear', ParseIntPipe) financialYear: number,
    @Query('quarter', ParseIntPipe) quarter: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.getTdsQuarterlySummary(workspaceId, financialYear, quarter);
  }

  @Get('form24q')
  @RequirePermissions(AppModule.SALARY, ModuleAction.VIEW)
  @RequireSubscription({
    module: AppModule.SALARY,
    subFeature: 'tds_management',
  })
  async getForm24QData(
    @Param('workspaceId') workspaceId: string,
    @Query('financialYear', ParseIntPipe) financialYear: number,
    @Query('quarter', ParseIntPipe) quarter: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.salaryService.assertSalaryComplianceExportAllowed(workspaceId, req.user.sub);
    return this.tdsChallanService.getForm24QData(workspaceId, financialYear, quarter);
  }
}
