import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillsService } from './bills.service';
import { BillsController } from './bills.controller';
import { Bill, BillSchema } from './schemas/bill.schema';
import { BillsLifecycleService } from './bills-lifecycle.service';
import { BillsRetentionPurgeCron } from './crons/bills-retention-purge.cron';
import { UploadsModule } from '../uploads/uploads.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuditModule } from '../audit/audit.module';
import { Role, RoleSchema } from '../rbac/schemas/role.schema';
import { TeamMember, TeamMemberSchema } from '../team/schemas/team-member.schema';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';
// Finance collections the BillsLifecycleService + retention cron probe/read for
// the memberHasHistory gate (PurchaseBill, ExpenseVoucher, LedgerEntry). Registered
// by name token only (read-only probes) — no FinanceModule import, so no cycle.
import {
  PurchaseBill,
  PurchaseBillSchema,
} from '../finance/purchases/purchase-bill/purchase-bill.schema';
import { ExpenseVoucher, ExpenseVoucherSchema } from '../finance/expenses/expense-voucher.schema';
import {
  LedgerEntry,
  LedgerEntrySchema,
} from '../finance/sales/ledger-posting/ledger-entry.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Bill.name, schema: BillSchema },
      // Read-only models for the BillsController Owner/HR override resolution
      // (D1) + the lifecycle history gate + the retention purge cron. Re-
      // registering them is safe — @nestjs/mongoose reuses the existing
      // connection model; the schema index definitions are identical to the
      // owning module's, so no duplicate-index warning. Workspace +
      // WorkspaceMember come from WorkspacesModule's exported MongooseModule.
      { name: Role.name, schema: RoleSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: PurchaseBill.name, schema: PurchaseBillSchema },
      { name: ExpenseVoucher.name, schema: ExpenseVoucherSchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
    ]),
    UploadsModule,
    SubscriptionsModule,
    // Exports the Workspace + WorkspaceMember models used by the controller's
    // Owner/HR resolution.
    WorkspacesModule,
    // AuditService for the AP/AR money-trail (OQ-FB-3 → A: audit-trail-only SoD).
    AuditModule,
  ],
  controllers: [BillsController],
  providers: [
    BillsService,
    // Finance/Bills hardening Pillar 1: member-removal history gate + the
    // system-only retention purge (OFF by default).
    BillsLifecycleService,
    BillsRetentionPurgeCron,
  ],
  exports: [
    BillsService,
    // Exported so the Team module can drive the memberHasHistory gate
    // (TeamService.removePermanent) via moduleRef across the forwardRef cycle —
    // mirrors SalaryLifecycleService / AttendanceLifecycleService.
    BillsLifecycleService,
    MongooseModule,
  ],
})
export class BillsModule {}
