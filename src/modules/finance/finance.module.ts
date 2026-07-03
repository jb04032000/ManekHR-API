import { Module } from '@nestjs/common';
import { FirmsModule } from './firms/firms.module';
import { LedgerModule } from './ledger/ledger.module';
import { PartiesModule } from './parties/parties.module';
import { ItemsModule } from './items/items.module';
import { VoucherSeriesModule } from './voucher-series/voucher-series.module';
import { AccountantInviteModule } from './accountant-invite/accountant-invite.module';
import { CashRegistersModule } from './cash-registers/cash-registers.module';
import { RecycleBinModule } from './recycle-bin/recycle-bin.module';
import { GstinModule } from './gstin/gstin.module';
import { SetupChecklistModule } from './setup-checklist/setup-checklist.module';
import { SalesModule } from './sales/sales.module';
import { PaymentsModule } from './payments/payments.module';
import { PurchasesModule } from './purchases/purchases.module';
import { FixedAssetsModule } from './fixed-assets/fixed-assets.module';
import { ExpensesModule } from './expenses/expenses.module';
import { RecurringExpenseModule } from './expenses/recurring/recurring-expense.module';
import { BankAccountsModule } from './bank-accounts/bank-accounts.module';
import { ChequesModule } from './cheques/cheques.module';
import { LoanAccountsModule } from './loan-accounts/loan-accounts.module';
import { JournalVouchersModule } from './journal-vouchers/journal-vouchers.module';
import { CreditNotesModule } from './credit-notes/credit-notes.module';
import { DebitNotesModule } from './debit-notes/debit-notes.module';
import { GrnReturnsModule } from './grn-returns/grn-returns.module';
import { RemindersModule } from './reminders/reminders.module';
import { InventoryModule } from './inventory/inventory.module';
import { ManufacturingModule } from './manufacturing/manufacturing.module';
import { JobWorkModule } from './job-work/job-work.module';
import { GstModule } from './gst/gst.module';
import { BankReconciliationModule } from './bank-reconciliation/bank-reconciliation.module';
import { ReportsModule } from './reports/reports.module';
import { TallyExportModule } from './tally-export/tally-export.module';
import { FiscalYearModule } from './fiscal-year/fiscal-year.module';
import { PartyPortalModule } from './party-portal/party-portal.module';
import { PrintI18nModule } from './sales/print-i18n/print-i18n.module';
import { PartyIntelligenceModule } from './party-intelligence/party-intelligence.module';
import { PurchaseBillRcmMigrationModule } from './purchases/purchase-bill/migrations/purchase-bill-rcm-migration.module';
import { SmartDefaultsModule } from './smart-defaults/smart-defaults.module';
import { OpeningBalanceModule } from './sales/ledger-posting/opening-balance.module';
import { HsnModule } from './hsn/hsn.module';
import { ReportCacheModule } from './report-cache/report-cache.module';
import { ImportModule } from './import/import.module';

@Module({
  imports: [
    FirmsModule,
    LedgerModule,
    PartiesModule,
    ItemsModule,
    VoucherSeriesModule,
    AccountantInviteModule,
    CashRegistersModule,
    RecycleBinModule,
    GstinModule,
    SetupChecklistModule,
    SalesModule,
    PaymentsModule,
    PurchasesModule,
    FixedAssetsModule,
    ExpensesModule,
    RecurringExpenseModule,
    BankAccountsModule,
    ChequesModule,
    LoanAccountsModule,
    JournalVouchersModule,
    CreditNotesModule,
    DebitNotesModule,
    GrnReturnsModule,
    RemindersModule,
    InventoryModule, // F-09 inventory deepening — registers all 15 sub-modules
    PurchaseBillRcmMigrationModule, // one-time RCM output-tax backfill (env-gated, inert until opt-in)
    ManufacturingModule, // F-10 manufacturing module
    JobWorkModule, // F-11 job-work and karigar linkage
    GstModule, // F-12 GST compliance suite
    BankReconciliationModule, // F-13 bank reconciliation
    ReportsModule, // F-14 reports and dashboards
    TallyExportModule, // F-15 Plan 02 — Tally XML export (FIN-15-01)
    FiscalYearModule, // F-15 Plan 03 — FY close + lock guard (FIN-15-02)
    PartyPortalModule, // F-15 Plan 04 — Customer Portal (FIN-15-03)
    PrintI18nModule, // F-15 Plan 05 — multi-language print catalogs (FIN-15-04)
    PartyIntelligenceModule, // F-16 Phase 17 Plan 01 — Party Intelligence + CRM (Wave-0 shells)
    SmartDefaultsModule, // Smart Defaults / Field Prediction — per-party last-used invoice settings pre-fill
    OpeningBalanceModule, // per-account opening balances (posts 'opening_balance' LedgerEntry, contra 3004)
    HsnModule, // D18 plain-language HSN/SAC search directory (textile-first seed)
    ReportCacheModule, // D17 report result cache (version bumped per posting; fast repeat reads)
    ImportModule, // D19 onboarding import (parties step; opening balances / items / invoices follow)
  ],
  exports: [
    FirmsModule,
    LedgerModule,
    PartiesModule,
    ItemsModule,
    VoucherSeriesModule,
    AccountantInviteModule,
    CashRegistersModule,
    RecycleBinModule,
    GstinModule,
    SetupChecklistModule,
    SalesModule,
    PaymentsModule,
    PurchasesModule,
    FixedAssetsModule,
    ExpensesModule,
    RecurringExpenseModule,
    BankAccountsModule,
    ChequesModule,
    LoanAccountsModule,
    JournalVouchersModule,
    CreditNotesModule,
    DebitNotesModule,
    GrnReturnsModule,
    RemindersModule,
    InventoryModule,
    ManufacturingModule,
    JobWorkModule,
    GstModule,
    BankReconciliationModule, // F-13 bank reconciliation
    ReportsModule, // F-14 reports and dashboards
    TallyExportModule, // F-15 Plan 02 — Tally XML export
    FiscalYearModule, // F-15 Plan 03 — FY close + lock guard
    PartyPortalModule, // F-15 Plan 04 — Customer Portal
    PrintI18nModule, // F-15 Plan 05 — multi-language print catalogs
    PartyIntelligenceModule, // F-16 Phase 17 Plan 01 — Party Intelligence + CRM
    SmartDefaultsModule, // Smart Defaults / Field Prediction — exports SmartDefaultsService for the sale-invoice post-write hook
  ],
})
export class FinanceModule {}
