import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Bill } from './schemas/bill.schema';
import { PurchaseBill } from '../finance/purchases/purchase-bill/purchase-bill.schema';
import { ExpenseVoucher } from '../finance/expenses/expense-voucher.schema';
import { LedgerEntry } from '../finance/sales/ledger-posting/ledger-entry.schema';

/**
 * BillsLifecycleService — Finance/Bills hardening Pillar 1 (2026-06-15).
 *
 * Owns the Finance/Bills participation in the member Remove-vs-Delete policy
 * (DATA-MAP §1b). Mirrors SalaryLifecycleService / AttendanceLifecycleService:
 * a single `memberHasHistory()` probe that the Team permanent-delete gate ORs
 * in alongside the salary + attendance gates.
 *
 * There is intentionally NO `onMemberRemoved()` cascade here (unlike salary /
 * attendance). Per the spec (C1-B): Finance vouchers are not member-owned the
 * way salary records are, and a removed member's JWT/Redis-denylist already
 * stops their requests. The createdBy / postedBy / auditLog[].by FKs are
 * attribution on the financial record (which party acted), not personal data
 * about the member, and must keep resolving for audit integrity (they resolve
 * to "Deleted user" after Auth account erasure). So a member offboard performs
 * NO Finance write-lock and NO scrub — records stay read-intact.
 *
 * memberHasHistory is TRUE (OQ-FB-1 → A: any record, incl. draft-only, locks)
 * when, for (workspaceId, memberId), ANY of these exist:
 *   1. a legacy Bill created by the member (createdBy);
 *   2. a PurchaseBill the member POSTED (postedBy) OR CREATED (auditLog[0].by)
 *      — draft-only counts, per OQ-FB-1;
 *   3. an ExpenseVoucher created by the member (createdBy);
 *   4. a LedgerEntry posted by the member (postedBy) — the double-entry journal.
 * Any hit keeps that member permanently non-hard-deletable until the statutory
 * retention window lapses (the books must stay complete). This is correct and
 * expected for any production financial system.
 *
 * Dependency note:
 *   - reads its own Bill collection + the Finance PurchaseBill / ExpenseVoucher /
 *     LedgerEntry collections (registered by name token in BillsModule — read-
 *     only probes, no FinanceModule import, so no cycle).
 *   - Team module CALLS memberHasHistory via moduleRef across the
 *     TeamModule<->BillsModule resolution (lazy, strict:false), wired through
 *     BillsModule's export of BillsLifecycleService.
 */
@Injectable()
export class BillsLifecycleService {
  private readonly logger = new Logger(BillsLifecycleService.name);

  constructor(
    @InjectModel(Bill.name) private readonly billModel: Model<Bill>,
    @InjectModel(PurchaseBill.name)
    private readonly purchaseBillModel: Model<PurchaseBill>,
    @InjectModel(ExpenseVoucher.name)
    private readonly expenseVoucherModel: Model<ExpenseVoucher>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntry>,
  ) {}

  /**
   * DATA-MAP §3 (finance-specific, OQ-FB-1 → A). A member HAS finance history if
   * any one of the four probes hits for (workspaceId, memberId). If true, the
   * Team permanent-delete MUST be converted to "remove/offboard" — the books
   * must remain complete. Cheap: each probe is an indexed `exists` and we
   * short-circuit on the first hit.
   *
   * NOTE on filters:
   *   - Bill stores createdBy as an ObjectId; soft-deleted bills STILL count
   *     (a soft-deleted bill is retained statutory evidence, so it still binds
   *     the member) — no `isDeleted` filter here on purpose.
   *   - PurchaseBill: postedBy OR the first auditLog entry's `by` (the creator),
   *     so a draft-only never-posted bill the member created counts (OQ-FB-1).
   *     `isDeleted` is NOT filtered — a soft-deleted draft still attributes.
   *   - ExpenseVoucher uses createdBy; LedgerEntry uses postedBy.
   */
  async memberHasHistory(workspaceId: string, memberId: string): Promise<boolean> {
    const ws = new Types.ObjectId(String(workspaceId));
    const member = new Types.ObjectId(String(memberId));

    // Ordered cheapest/most-likely-first; `.exists()` short-circuits.
    const probes: Array<() => Promise<unknown>> = [
      // 1. Legacy Bill created by the member (any status, incl. soft-deleted).
      () => this.billModel.exists({ workspaceId: ws, createdBy: member }),
      // 2. PurchaseBill posted OR created (auditLog[0].by) by the member.
      () =>
        this.purchaseBillModel.exists({
          workspaceId: ws,
          $or: [{ postedBy: member }, { 'auditLog.0.by': member }],
        }),
      // 3. ExpenseVoucher created by the member.
      () => this.expenseVoucherModel.exists({ workspaceId: ws, createdBy: member }),
      // 4. LedgerEntry posted by the member (the double-entry journal).
      () => this.ledgerEntryModel.exists({ workspaceId: ws, postedBy: member }),
    ];

    for (const probe of probes) {
      const hit = await probe();
      if (hit) return true;
    }
    return false;
  }
}
