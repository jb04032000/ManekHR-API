import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { Party } from '../parties/party.schema';
import { Item } from '../items/item.schema';
import { Account } from '../ledger/account.schema';
import { VoucherSeries } from '../voucher-series/voucher-series.schema';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { AppModule } from '../../../common/enums/modules.enum';

@Injectable()
export class RecycleBinService {
  private readonly logger = new Logger(RecycleBinService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap the destructive restore/permanentDelete; PostHog fires fire-and-
  // forget after each succeeds (ids + record type only, never the record body).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    @InjectModel(Item.name) private readonly itemModel: Model<Item>,
    @InjectModel(Account.name) private readonly accountModel: Model<Account>,
    @InjectModel(VoucherSeries.name) private readonly vsModel: Model<VoucherSeries>,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  async findAll(
    workspaceId: string,
    firmId: string,
    type?: string,
  ): Promise<{ type: string; record: any }[]> {
    const ws = new Types.ObjectId(workspaceId);
    const f = new Types.ObjectId(firmId);
    const filter = { workspaceId: ws, firmId: f, isDeleted: true };
    const results: { type: string; record: any }[] = [];

    if (!type || type === 'party') {
      const parties = await this.partyModel.find(filter).exec();
      parties.forEach((r) => results.push({ type: 'party', record: r }));
    }
    if (!type || type === 'item') {
      const items = await this.itemModel.find(filter).exec();
      items.forEach((r) => results.push({ type: 'item', record: r }));
    }
    if (!type || type === 'account') {
      const accounts = await this.accountModel.find(filter).exec();
      accounts.forEach((r) => results.push({ type: 'account', record: r }));
    }
    if (!type || type === 'voucher_series') {
      const vss = await this.vsModel.find(filter).exec();
      vss.forEach((r) => results.push({ type: 'voucher_series', record: r }));
    }

    return results.sort((a, b) => {
      const da = (a.record.deletedAt as Date)?.getTime() ?? 0;
      const db = (b.record.deletedAt as Date)?.getTime() ?? 0;
      return db - da;
    });
  }

  async restore(
    workspaceId: string,
    firmId: string,
    id: string,
    type: string,
    userId: string,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.restoreRecycleBinRecord',
      { workspaceId, firmId, recordId: id, recordType: type, userId },
      async () => {
        const model = this.getModel(type);
        const result = await model
          .updateOne(
            {
              _id: new Types.ObjectId(id),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: true,
            },
            { $set: { isDeleted: false }, $unset: { deletedAt: '' } },
          )
          .exec();
        if (result.matchedCount === 0)
          throw new NotFoundException('Record not found in recycle bin');
        await this.audit(workspaceId, firmId, id, type, 'RECYCLE_BIN_RESTORE', userId);
        // Fire-and-forget product analytics on the successful restore (ids + type only).
        this.postHog.capture({
          distinctId: userId,
          event: 'finance_settings.restored_record',
          properties: { workspaceId, firmId, recordId: id, recordType: type },
        });
      },
    );
  }

  async permanentDelete(
    workspaceId: string,
    firmId: string,
    id: string,
    type: string,
    userId: string,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.permanentDeleteRecycleBinRecord',
      { workspaceId, firmId, recordId: id, recordType: type, userId },
      async () => {
        const model = this.getModel(type);
        const result = await model
          .deleteOne({
            _id: new Types.ObjectId(id),
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
            isDeleted: true,
          })
          .exec();
        if (result.deletedCount === 0)
          throw new NotFoundException('Record not found in recycle bin');
        await this.audit(workspaceId, firmId, id, type, 'RECYCLE_BIN_PERMANENT_DELETE', userId);
        // Fire-and-forget product analytics on the successful purge (ids + type only).
        this.postHog.capture({
          distinctId: userId,
          event: 'finance_settings.purged_record',
          properties: { workspaceId, firmId, recordId: id, recordType: type },
        });
      },
    );
  }

  // SEC-2: append-only audit trail for the destructive recycle-bin operations
  // (who restored / permanently deleted what, when). Best-effort: a failed audit
  // write is logged but never aborts the operation the user requested.
  private async audit(
    workspaceId: string,
    firmId: string,
    id: string,
    type: string,
    action: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.FINANCE,
        entityType: type,
        entityId: id,
        action,
        actorId: userId,
        meta: { firmId, type, recordId: id },
      });
    } catch (e) {
      this.logger.error(`recycle-bin audit (${action}) failed: ${(e as Error).message}`);
    }
  }

  private getModel(type: string): Model<any> {
    const map: Record<string, Model<any>> = {
      party: this.partyModel,
      item: this.itemModel,
      account: this.accountModel,
      voucher_series: this.vsModel,
    };
    const model = map[type];
    if (!model) throw new NotFoundException(`Unknown type: ${type}`);
    return model;
  }
}
