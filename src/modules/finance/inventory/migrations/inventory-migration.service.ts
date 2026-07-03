import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Document, Model, Types } from 'mongoose';
import { env } from '../../../../config/env';
import { Firm } from '../../firms/firm.schema';
import { Item } from '../../items/item.schema';
import { Godown, GodownDocument } from '../godowns/godown.schema';
import { GodownBalance, GodownBalanceDocument } from '../godown-balances/godown-balance.schema';
import { StockMovement, StockMovementDocument } from '../stock-movements/stock-movement.schema';
import {
  ItemValuationLayer,
  ItemValuationLayerDocument,
} from '../valuation/item-valuation-layer.schema';
import { Account } from '../../ledger/account.schema';
// Single source of truth for the new ledgers — backfilled here for existing firms
// (new firms get them at creation via AccountsService.seedFromTemplate).
import { commonComplianceSeeds, textileDelta } from '../../ledger/seeds';

// Firm and Item schemas use the legacy `extends Document` pattern;
// create local aliases so the constructor injection stays type-safe.
type FirmDocument = Firm & Document;
type ItemDocument = Item & Document;
type AccountDocument = Account & Document;

@Injectable()
export class InventoryMigrationService {
  private readonly logger = new Logger(InventoryMigrationService.name);

  constructor(
    @InjectModel(Firm.name) private readonly firmModel: Model<FirmDocument>,
    @InjectModel(Item.name) private readonly itemModel: Model<ItemDocument>,
    @InjectModel(Godown.name)
    private readonly godownModel: Model<GodownDocument>,
    @InjectModel(GodownBalance.name)
    private readonly balanceModel: Model<GodownBalanceDocument>,
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovementDocument>,
    @InjectModel(ItemValuationLayer.name)
    private readonly layerModel: Model<ItemValuationLayerDocument>,
    @InjectModel(Account.name)
    private readonly accountModel: Model<AccountDocument>,
  ) {}

  /**
   * Inventory backfills for existing firms. Run by the ledgered migration runner
   * (ADR-0001 Slice 2), unit `0009_finance_inventory_backfill` — was an
   * onModuleInit hook that ran on EVERY boot. Do NOT re-add a boot hook on merge.
   * Body unchanged. Throws on failure so the runner records it failed + halts
   * the deploy (replaces the old swallow-and-log-on-boot).
   */
  async run(): Promise<void> {
    await this.seedMainGodownForAllFirms();
    await this.seedNewCoaAccountsForExistingFirms();
    await this.seedComplianceAndTextileCoaForExistingFirms();
    await this.seedGodownBalancesFromQtyOnHand();
    await this.seedOpeningStockMovements();
    this.logger.log('Inventory backfill migration complete');
  }

  private async seedMainGodownForAllFirms(): Promise<void> {
    // For each firm with NO Godown documents → create Main Godown (idempotent: check exists first)
    const firms = await this.firmModel.find({ isDeleted: { $ne: true } }).lean();
    for (const firm of firms) {
      const existing = await this.godownModel.exists({
        workspaceId: firm.workspaceId,
        firmId: new Types.ObjectId(String(firm._id)),
      });
      if (existing) continue;
      await this.godownModel.create({
        workspaceId: firm.workspaceId,
        firmId: new Types.ObjectId(String(firm._id)),
        name: 'Main Godown',
        code: 'GDN-001',
        isDefault: true,
        isActive: true,
        isDeleted: false,
      });
      this.logger.log(`Seeded Main Godown for firm ${String(firm._id)}`);
    }
  }

  private async seedNewCoaAccountsForExistingFirms(): Promise<void> {
    // Upsert 3 new COA accounts per firm:
    //   5018  Wastage & Damage Expense  (expense)
    //   2018  Cess Payable              (liability)
    //   1012  Cess Receivable           (asset)
    const newAccounts = [
      { code: '5018', name: 'Wastage & Damage Expense', type: 'expense' },
      { code: '2018', name: 'Cess Payable', type: 'liability' },
      { code: '1012', name: 'Cess Receivable', type: 'asset' },
      // Salary Advance re-coded 1013 → 1014 (1013 collided with service-firm WIP).
      // Kept here for source consistency; the dedicated convergent backfill
      // seedSalaryAdvanceCoaForExistingFirms (migration 0038) is what actually
      // reaches firms on already-migrated DBs, since this unit (0009) is `once`.
      { code: '1014', name: 'Salary Advance', type: 'asset' },
      { code: '2019', name: 'Salary Payable', type: 'liability' },
    ];

    const firms = await this.firmModel.find({ isDeleted: { $ne: true } }).lean();

    for (const firm of firms) {
      for (const acct of newAccounts) {
        try {
          const existing = await this.accountModel
            .findOne({
              workspaceId: firm.workspaceId,
              firmId: new Types.ObjectId(String(firm._id)),
              code: acct.code,
            })
            .lean();
          if (existing) continue;

          await this.accountModel.create({
            workspaceId: firm.workspaceId,
            firmId: new Types.ObjectId(String(firm._id)),
            code: acct.code,
            name: acct.name,
            type: acct.type,
            isFromTemplate: false,
            isSystem: false,
            isDeleted: false,
          });
          this.logger.log(`Seeded CoA ${acct.code} (${acct.name}) for firm ${String(firm._id)}`);
        } catch (err: unknown) {
          const msg =
            err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
          this.logger.warn(
            `Failed CoA seed for firm ${String(firm._id)} code ${acct.code}: ${msg}`,
          );
        }
      }
    }

    // F-10 backfill — Manufacturing Cost Variance (5060) for existing manufacturing firms
    try {
      const manufacturingFirms = await this.firmModel
        .find({ businessType: 'manufacturing', isDeleted: { $ne: true } })
        .lean();
      for (const firm of manufacturingFirms) {
        const exists = await this.accountModel.exists({
          workspaceId: firm.workspaceId,
          firmId: new Types.ObjectId(String(firm._id)),
          code: '5060',
        });
        if (!exists) {
          await this.accountModel.create({
            workspaceId: firm.workspaceId,
            firmId: new Types.ObjectId(String(firm._id)),
            code: '5060',
            name: 'Manufacturing Cost Variance',
            group: 'Manufacturing',
            subGroup: 'Production Costs',
            type: 'expense',
            isFromTemplate: true,
            isSystem: false,
            isDeleted: false,
          });
          this.logger.log(`F-10 backfill: seeded 5060 for firm ${String(firm._id)}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`F-10 backfill 5060 failed: ${msg}`);
    }

    // F-11 backfill — Job-Work Service Income (4020) for existing manufacturing firms
    try {
      const manufacturingFirms = await this.firmModel
        .find({ businessType: 'manufacturing', isDeleted: { $ne: true } })
        .lean();
      for (const firm of manufacturingFirms) {
        const exists = await this.accountModel.exists({
          workspaceId: firm.workspaceId,
          firmId: new Types.ObjectId(String(firm._id)),
          code: '4020',
        });
        if (!exists) {
          await this.accountModel.create({
            workspaceId: firm.workspaceId,
            firmId: new Types.ObjectId(String(firm._id)),
            code: '4020',
            name: 'Job-Work Service Income',
            group: 'Income',
            subGroup: 'Service Income',
            type: 'income',
            isFromTemplate: true,
            isSystem: false,
            isDeleted: false,
          });
          this.logger.log(`F-11 backfill: seeded 4020 for firm ${String(firm._id)}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`F-11 backfill 4020 failed: ${msg}`);
    }
  }

  /**
   * Convergent backfill (migration 0038): ensure the Salary Advance asset account
   * (code 1014) exists for EVERY existing firm. The salary→ledger bridge posts
   * advance payments as Dr 1014 / Cr cash; without this account the posting throws
   * "account 1014 not found" and is swallowed, so advances never reach the ledger.
   *
   * Why a dedicated convergent unit (not folded into 0009): unit 0009 is `once`
   * and is already ledgered `applied` on existing deployments, so editing its body
   * (we re-coded 1013→1014 there) does NOT re-run it. This convergent unit re-runs
   * whenever its checksum changes, so already-migrated DBs still get 1014.
   *
   * Idempotent and non-destructive: creates 1014 only when missing; never touches
   * the legacy 1013 rows (service-firm WIP, or the empty 'Salary Advance' created
   * by the old 0009 backfill).
   */
  async seedSalaryAdvanceCoaForExistingFirms(): Promise<{ seeded: number }> {
    let seeded = 0;
    const firms = await this.firmModel.find({ isDeleted: { $ne: true } }).lean();
    for (const firm of firms) {
      try {
        const exists = await this.accountModel.exists({
          workspaceId: firm.workspaceId,
          firmId: new Types.ObjectId(String(firm._id)),
          code: '1014',
        });
        if (exists) continue;
        await this.accountModel.create({
          workspaceId: firm.workspaceId,
          firmId: new Types.ObjectId(String(firm._id)),
          code: '1014',
          name: 'Salary Advance',
          group: 'Current Assets',
          subGroup: 'Loans & Advances',
          type: 'asset',
          isFromTemplate: true,
          isSystem: false,
          isDeleted: false,
        });
        seeded += 1;
        this.logger.log(`0038 backfill: seeded 1014 Salary Advance for firm ${String(firm._id)}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(`0038 backfill 1014 failed for firm ${String(firm._id)}: ${msg}`);
      }
    }
    this.logger.log(`0038 Salary Advance backfill complete (${seeded} firms seeded)`);
    return { seeded };
  }

  /**
   * Backfill the new compliance ledgers (capital-goods ITC, section-wise TDS,
   * asset-disposal gain/loss, loan interest) onto EVERY existing firm, plus the
   * textile-trade ledgers (fabric stock, job-work split, dalali/kasar/vyaj) onto
   * existing 'textile' firms. Idempotent: each account is created only if its code
   * is not already present for the firm, so it never alters user-touched accounts.
   * Codes are read from ledger/seeds so this never drifts from the seed templates.
   */
  private async seedComplianceAndTextileCoaForExistingFirms(): Promise<void> {
    const firms = await this.firmModel.find({ isDeleted: { $ne: true } }).lean();

    for (const firm of firms) {
      // Composition firms cannot claim ITC — skip the capital-goods ITC ledger for them.
      const isComposition = firm.businessType === 'composition';
      const compliance = isComposition
        ? commonComplianceSeeds.filter((a) => a.code !== '1103')
        : commonComplianceSeeds;
      const toSeed =
        firm.businessType === 'textile' ? [...compliance, ...textileDelta] : compliance;

      for (const acct of toSeed) {
        try {
          const existing = await this.accountModel
            .findOne({
              workspaceId: firm.workspaceId,
              firmId: new Types.ObjectId(String(firm._id)),
              code: acct.code,
            })
            .lean();
          if (existing) continue;

          await this.accountModel.create({
            workspaceId: firm.workspaceId,
            firmId: new Types.ObjectId(String(firm._id)),
            code: acct.code,
            name: acct.name,
            group: acct.group,
            subGroup: acct.subGroup,
            type: acct.type,
            isFromTemplate: true,
            // Honor the seed's isSystem (e.g. 3004 Opening Balance Equity is a
            // protected contra, not user-deletable).
            isSystem: acct.isSystem ?? false,
            isDeleted: false,
          });
          this.logger.log(
            `CoA backfill: seeded ${acct.code} (${acct.name}) for firm ${String(firm._id)}`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          this.logger.warn(
            `CoA backfill failed for firm ${String(firm._id)} code ${acct.code}: ${msg}`,
          );
        }
      }
    }
  }

  private async seedGodownBalancesFromQtyOnHand(): Promise<void> {
    // For each Item with qtyOnHand > 0 AND no GodownBalance(stock bucket) for the firm's Main Godown:
    //   - Find Main Godown for that firm
    //   - Upsert GodownBalance { itemId, godownId, bucketType: 'stock', qty: item.qtyOnHand }
    // Idempotent: only creates if no balance row exists (pitfall 6 compliant).
    const items = await this.itemModel
      .find({ qtyOnHand: { $gt: 0 }, isDeleted: { $ne: true } })
      .lean();
    for (const item of items) {
      const mainGodown = await this.godownModel
        .findOne({
          workspaceId: item.workspaceId,
          firmId: item.firmId,
          isDefault: true,
        })
        .lean();
      if (!mainGodown) continue;
      const existing = await this.balanceModel.exists({
        workspaceId: item.workspaceId,
        firmId: item.firmId,
        itemId: new Types.ObjectId(String(item._id)),
        godownId: new Types.ObjectId(String(mainGodown._id)),
        bucketType: 'stock',
      });
      if (existing) continue;
      await this.balanceModel.create({
        workspaceId: item.workspaceId,
        firmId: item.firmId,
        itemId: new Types.ObjectId(String(item._id)),
        godownId: new Types.ObjectId(String(mainGodown._id)),
        bucketType: 'stock',
        qty: item.qtyOnHand,
        lastMovementAt: new Date(),
      });
    }
  }

  private async seedOpeningStockMovements(): Promise<void> {
    // For each Item with qtyOnHand > 0 AND no StockMovement of type 'opening_stock':
    //   1. Create opening_stock StockMovement
    //   2. Create FIFO ItemValuationLayer
    //   3. Set Item.movingAvgCostPaise if not yet set (D-04)
    // Idempotent: skip if opening_stock movement already exists for the item.
    const SYSTEM_USER_ID = env.systemUserId;

    const items = await this.itemModel
      .find({ qtyOnHand: { $gt: 0 }, isDeleted: { $ne: true } })
      .lean();

    let processed = 0;
    for (const item of items) {
      // Idempotency guard: skip if opening_stock movement already exists for this item
      const existing = await this.movementModel.exists({
        workspaceId: item.workspaceId,
        firmId: item.firmId,
        itemId: new Types.ObjectId(String(item._id)),
        movementType: 'opening_stock',
      });
      if (existing) continue;

      // Resolve default godown for the firm
      const mainGodown = await this.godownModel
        .findOne({
          workspaceId: item.workspaceId,
          firmId: item.firmId,
          isDefault: true,
          isDeleted: { $ne: true },
        })
        .lean();
      if (!mainGodown) {
        this.logger.warn(
          `No default godown for firm ${String(item.firmId)}; skipping item ${String(item._id)}`,
        );
        continue;
      }

      const itemAny = item as { movingAvgCostPaise?: number; purchaseRatePaise?: number };
      const cost: number = itemAny.movingAvgCostPaise ?? itemAny.purchaseRatePaise ?? 0;

      // 1. Create opening_stock StockMovement (direct insert — bypasses StockMovementsService.record()
      //    because GodownBalance is already seeded by seedGodownBalancesFromQtyOnHand above)
      const movement = await this.movementModel.create({
        workspaceId: item.workspaceId,
        firmId: item.firmId,
        movementType: 'opening_stock',
        itemId: new Types.ObjectId(String(item._id)),
        godownId: new Types.ObjectId(String(mainGodown._id)),
        qty: item.qtyOnHand,
        costPaise: cost,
        movingAvgCostPaise: cost,
        narration: 'Opening stock backfill (F-09 migration)',
        createdBy: new Types.ObjectId(SYSTEM_USER_ID),
      });

      // 2. Create FIFO ItemValuationLayer
      const lastLayer = await this.layerModel
        .findOne(
          {
            workspaceId: item.workspaceId,
            firmId: item.firmId,
            itemId: new Types.ObjectId(String(item._id)),
            godownId: new Types.ObjectId(String(mainGodown._id)),
          },
          null,
          { sort: { seq: -1 } },
        )
        .lean();

      await this.layerModel.create({
        workspaceId: item.workspaceId,
        firmId: item.firmId,
        itemId: new Types.ObjectId(String(item._id)),
        godownId: new Types.ObjectId(String(mainGodown._id)),
        seq: (lastLayer?.seq ?? 0) + 1,
        qtyOriginal: item.qtyOnHand,
        qtyRemaining: item.qtyOnHand,
        costPaise: cost,
        inDate: new Date(),
        sourceMovementId: movement._id,
        isExhausted: false,
      });

      // 3. Set Item.movingAvgCostPaise if not yet set (D-04)
      if (!itemAny.movingAvgCostPaise) {
        await this.itemModel.updateOne(
          { _id: new Types.ObjectId(String(item._id)) },
          { $set: { movingAvgCostPaise: cost } },
        );
      }

      processed++;
    }

    this.logger.log(
      `Opening stock backfill complete (${processed} items processed out of ${items.length} total)`,
    );
  }
}
