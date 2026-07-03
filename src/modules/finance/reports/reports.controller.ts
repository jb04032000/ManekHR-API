import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { FinancialStatementsService } from './services/financial-statements.service';
import { DashboardKpiService } from './services/dashboard-kpi.service';
import { GstRegistersService } from './services/gst-registers.service';
import { PartyLedgerService } from './services/party-ledger.service';
import { InventoryReportsService } from './services/inventory-reports.service';
import { ManufacturingReportsService } from './services/manufacturing-reports.service';
import { FixedAssetsReportsService } from './services/fixed-assets-reports.service';

@ApiTags('Finance - Reports')
@Controller('workspaces/:wsId/finance/firms/:firmId/reports')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
// Class-level gate covers the financial / dashboard / party / ledger reports
// (the bulk of endpoints). Specialised sections (GST, Inventory, Manufacturing,
// Fixed Assets) carry method-level gates ON TOP — the merged-requirements
// guard enforces both, so callers need reports_financial AND the specialised
// key. With the default tier policy (reports_financial Pro+, sub-keys Pro+),
// behavior matches expectations.
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'reports_financial' })
export class ReportsController {
  constructor(
    private readonly fsService: FinancialStatementsService,
    private readonly kpiService: DashboardKpiService,
    private readonly gstService: GstRegistersService,
    private readonly partyLedgerService: PartyLedgerService,
    private readonly inventoryService: InventoryReportsService,
    private readonly mfgService: ManufacturingReportsService,
    private readonly faService: FixedAssetsReportsService,
  ) {}

  private parseDates(dateFrom: string, dateTo: string): { from: Date; to: Date } {
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime()))
      throw new BadRequestException('Invalid date format. Use ISO 8601.');
    const diffDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 366)
      throw new BadRequestException('Date range cannot exceed 366 days per report request.');
    if (from > to) throw new BadRequestException('dateFrom must be before dateTo.');
    return { from, to };
  }

  // ── Statutory Financial Reports ─────────────────────────────────────────

  @Get('trial-balance')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getTrialBalance(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.fsService.getTrialBalance(wsId, firmId, from, to);
  }

  @Get('profit-loss')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getProfitLoss(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.fsService.getProfitLoss(wsId, firmId, from, to);
  }

  @Get('profit-loss-comparison')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getProfitLossComparison(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.fsService.getProfitLossComparison(wsId, firmId, from, to);
  }

  @Get('balance-sheet')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getBalanceSheet(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('asOfDate') asOfDate: string,
  ) {
    if (!asOfDate) throw new BadRequestException('asOfDate is required');
    const date = new Date(asOfDate);
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid asOfDate format');
    return this.fsService.getBalanceSheet(wsId, firmId, date);
  }

  @Get('cash-flow')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getCashFlow(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.fsService.getCashFlow(wsId, firmId, from, to);
  }

  @Get('ratio-analysis')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getRatioAnalysis(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.fsService.getRatioAnalysis(wsId, firmId, from, to);
  }

  @Get('ebitda')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getEbitda(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.fsService.getEbitda(wsId, firmId, from, to);
  }

  // ── Dashboard KPIs ─────────────────────────────────────────────────────

  @Get('dashboard/kpis')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getDashboardKpis(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.kpiService.getDashboardKpis(wsId, firmId);
  }

  @Get('dashboard/revenue-trend')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getRevenueTrend(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('mode') mode: 'current_fy' | 'last_12_months' = 'current_fy',
  ) {
    return this.kpiService.getRevenueTrend(wsId, firmId, mode);
  }

  // ── Consolidated Accounting Dashboard (purely additive) ──────────────────
  // One request that fans out to the KPI + financial-statement + aging reports so
  // the web "Accounting Dashboard" page paints in a single round-trip. Same class
  // guards apply (RequireSubscription reports_financial + RequirePermissions FINANCE
  // VIEW). Optional asOfDate overrides the balance-sheet/aging as-of; dateFrom/dateTo
  // override the trend/flow/ratio/EBITDA window (defaults to the current Indian FY).
  @Get('dashboard/accounting')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getAccountingDashboard(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    // Validate the optional period window with the same 366-day guard the other
    // dated reports use, so a caller can't request an unbounded span. When both
    // dateFrom and dateTo are supplied we reuse parseDates; otherwise the service
    // applies its current-FY defaults.
    const opts: { dateFrom?: Date; dateTo?: Date; asOfDate?: Date } = {};
    if (dateFrom && dateTo) {
      const { from, to } = this.parseDates(dateFrom, dateTo);
      opts.dateFrom = from;
      opts.dateTo = to;
    } else if (dateFrom || dateTo) {
      throw new BadRequestException('Provide both dateFrom and dateTo, or neither.');
    }
    if (asOfDate) {
      const d = new Date(asOfDate);
      if (isNaN(d.getTime())) throw new BadRequestException('Invalid asOfDate format');
      opts.asOfDate = d;
    }
    return this.kpiService.getAccountingDashboard(wsId, firmId, opts);
  }

  // ── R-08: GSTR-1 tabular register (delegates to Gstr1Service via GstRegistersService) ──

  @Get('gst/gstr1')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr1_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getGstr1Register(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('period') period: string,
  ) {
    if (!period) throw new BadRequestException('period is required (format MMYYYY)');
    return this.gstService.getGstr1Report(wsId, firmId, period);
  }

  // ── R-09: GSTR-3B summary (delegates to Gstr3bService via GstRegistersService) ──

  @Get('gst/gstr3b')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr3b_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getGstr3bSummary(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('period') period: string,
  ) {
    if (!period) throw new BadRequestException('period is required (format MMYYYY)');
    return this.gstService.getGstr3bReport(wsId, firmId, period);
  }

  // ── R-10: GST Output Tax Register ──────────────────────────────────────────

  @Get('gst/output-register')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr1_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getGstOutputRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.gstService.getGstOutputRegister(wsId, firmId, from, to);
  }

  // ── R-11: GST Input Tax Register ───────────────────────────────────────────

  @Get('gst/input-register')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr3b_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getGstInputRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.gstService.getGstInputRegister(wsId, firmId, from, to);
  }

  // ── R-12+R-13: ITC Reconciliation ─────────────────────────────────────────

  @Get('gst/itc-reconciliation')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr3b_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getItcReconciliation(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.gstService.getItcReconciliation(wsId, firmId, from, to);
  }

  // ── R-14: Capital Goods ITC Schedule ──────────────────────────────────────

  @Get('gst/capital-goods-itc')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr3b_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getCapitalGoodsItcSchedule(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.gstService.getCapitalGoodsItcSchedule(wsId, firmId);
  }

  // ── R-15: E-Invoice Register ───────────────────────────────────────────────

  @Get('gst/einvoice-register')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'einvoice_generation' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getEinvoiceRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.gstService.getEinvoiceRegister(wsId, firmId, from, to);
  }

  // ── R-16: E-Way Bill Register ──────────────────────────────────────────────

  @Get('gst/ewb-register')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'ewaybill_generation' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getEwbRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.gstService.getEwbRegister(wsId, firmId, from, to);
  }

  // ── R-18: Late-Fee Register ────────────────────────────────────────────────

  @Get('gst/late-fee-register')
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr3b_filing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getLateFeeRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.gstService.getLateFeeRegister(wsId, firmId, from, to);
  }

  // ── Party & Ledger ─────────────────────────────────────────────────────────

  // ── R-19: Party Statement ──────────────────────────────────────────────────

  @Get('party-statement')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getPartyStatement(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('partyId') partyId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    if (!partyId) throw new BadRequestException('partyId is required');
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getPartyStatement(wsId, firmId, partyId, from, to);
  }

  // ── R-20: Account Ledger ───────────────────────────────────────────────────

  @Get('account-ledger')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getAccountLedger(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('accountCode') accountCode: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    if (!accountCode) throw new BadRequestException('accountCode is required');
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getAccountLedger(wsId, firmId, accountCode, from, to);
  }

  // ── R-21: Daybook ──────────────────────────────────────────────────────────

  @Get('daybook')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getDaybook(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('page') page = '1',
    @Query('limit') limit = '100',
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getDaybook(wsId, firmId, from, to, +page, Math.min(+limit, 500));
  }

  // ── R-22: Receivables Aging ────────────────────────────────────────────────

  @Get('receivables-aging')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getReceivablesAging(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    const date = asOfDate ? new Date(asOfDate) : undefined;
    return this.partyLedgerService.getReceivablesAging(wsId, firmId, date);
  }

  // ── R-23: Payables Aging ───────────────────────────────────────────────────

  @Get('payables-aging')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getPayablesAging(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    const date = asOfDate ? new Date(asOfDate) : undefined;
    return this.partyLedgerService.getPayablesAging(wsId, firmId, date);
  }

  // ── R-24: Party-wise P&L ───────────────────────────────────────────────────

  @Get('party-pl')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getPartyPl(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('partyId') partyId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    if (!partyId) throw new BadRequestException('partyId is required');
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getPartyPl(wsId, firmId, partyId, from, to);
  }

  // ── R-24b: Party-wise P&L across ALL parties (sales vs purchases, net) ─────
  @Get('party-wise-pl')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getPartyWisePl(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('partyType') partyType?: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getPartyWisePl(wsId, firmId, from, to, partyType);
  }

  // ── R-25: Broker Commission Register ──────────────────────────────────────

  @Get('broker-commission')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getBrokerCommission(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getBrokerCommission(wsId, firmId, from, to);
  }

  // ── R-26 to R-32: Voucher Registers ───────────────────────────────────────

  @Get('registers/:type')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('type') type: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('page') page = '1',
    @Query('limit') limit = '100',
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.partyLedgerService.getRegister(
      wsId,
      firmId,
      type as 'sales' | 'purchases' | 'payments-in' | 'payments-out' | 'journals',
      from,
      to,
      +page,
      Math.min(+limit, 500),
    );
  }

  // ── Inventory Reports ────────────────────────────────────────────────────

  // ── R-33: Stock Summary ────────────────────────────────────────────────────

  @Get('inventory/stock-summary')
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'stock_summary' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getStockSummary(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.inventoryService.getStockSummary(wsId, firmId);
  }

  // ── R-34: Item Ledger ─────────────────────────────────────────────────────

  @Get('inventory/item-ledger')
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'stock_movements_view' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getItemLedger(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('itemId') itemId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('page') page = '1',
    @Query('limit') limit = '100',
  ) {
    if (!itemId) throw new BadRequestException('itemId is required');
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.inventoryService.getItemLedger(
      wsId,
      firmId,
      itemId,
      from,
      to,
      +page,
      Math.min(+limit, 500),
    );
  }

  // ── R-35: Item Profitability ───────────────────────────────────────────────

  @Get('inventory/item-profitability')
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'stock_summary' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getItemProfitability(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.inventoryService.getItemProfitability(wsId, firmId, from, to);
  }

  // ── R-36: Godown Stock ────────────────────────────────────────────────────

  @Get('inventory/godown-stock')
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'godowns' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getGodownStock(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('godownId') godownId?: string,
  ) {
    return this.inventoryService.getGodownStock(wsId, firmId, godownId);
  }

  // ── R-39: Wastage Register ────────────────────────────────────────────────

  @Get('inventory/wastage')
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'wastage' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getWastageRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('page') page = '1',
    @Query('limit') limit = '100',
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.inventoryService.getWastageRegister(
      wsId,
      firmId,
      from,
      to,
      +page,
      Math.min(+limit, 500),
    );
  }

  // ── R-40: Stock Transfer Register ─────────────────────────────────────────

  @Get('inventory/stock-transfer')
  @RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'stock_transfers' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getStockTransferRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('page') page = '1',
    @Query('limit') limit = '100',
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.inventoryService.getStockTransferRegister(
      wsId,
      firmId,
      from,
      to,
      +page,
      Math.min(+limit, 500),
    );
  }

  // ── Manufacturing Reports ────────────────────────────────────────────────

  // ── R-41: Manufacturing Voucher Register ──────────────────────────────────

  @Get('manufacturing/mv-register')
  @RequireSubscription({
    module: AppModule.MANUFACTURING,
    subFeature: 'manufacturing_voucher_register',
  })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getMvRegister(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('page') page = '1',
    @Query('limit') limit = '100',
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.mfgService.getMvRegister(wsId, firmId, from, to, +page, Math.min(+limit, 500));
  }

  // ── R-42: BoM Cost Analysis ────────────────────────────────────────────────

  @Get('manufacturing/bom-cost-analysis')
  @RequireSubscription({ module: AppModule.MANUFACTURING, subFeature: 'bom_costing' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getBomCostAnalysis(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.mfgService.getBomCostAnalysis(wsId, firmId, from, to);
  }

  // ── R-43: Job-Work Pending ────────────────────────────────────────────────

  @Get('manufacturing/job-work-pending')
  @RequireSubscription({ module: AppModule.JOB_WORK, subFeature: 'lots' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getJobWorkPending(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.mfgService.getJobWorkPending(wsId, firmId);
  }

  // ── R-44: Karigar Productivity ────────────────────────────────────────────

  @Get('manufacturing/karigar-productivity')
  @RequireSubscription({
    module: AppModule.MANUFACTURING,
    subFeature: 'manufacturing_voucher_register',
  })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getKarigarProductivity(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.mfgService.getKarigarProductivity(wsId, firmId, from, to);
  }

  // ── R-45: Machine Output ──────────────────────────────────────────────────

  @Get('manufacturing/machine-output')
  @RequireSubscription({
    module: AppModule.MANUFACTURING,
    subFeature: 'manufacturing_voucher_register',
  })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getMachineOutput(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('machineId') machineId?: string,
  ) {
    const { from, to } = this.parseDates(dateFrom, dateTo);
    return this.mfgService.getMachineOutput(wsId, firmId, from, to, machineId);
  }

  // ── Fixed Asset Reports ──────────────────────────────────────────────────

  // ── R-47: Fixed Asset Register ────────────────────────────────────────────

  @Get('fixed-assets/register')
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_reports' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getFixedAssetRegister(@Param('wsId') wsId: string, @Param('firmId') firmId: string) {
    return this.faService.getFixedAssetRegister(wsId, firmId);
  }

  // ── R-48: Depreciation Schedule ───────────────────────────────────────────

  @Get('fixed-assets/depreciation-schedule')
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'fixed_assets_reports' })
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  getDepreciationSchedule(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('assetId') assetId?: string,
  ) {
    return this.faService.getDepreciationSchedule(wsId, firmId, assetId);
  }
}
