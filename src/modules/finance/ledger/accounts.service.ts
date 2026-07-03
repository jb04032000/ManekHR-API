import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { Account } from './account.schema';
import { COA_SEED_MAP } from './seeds';
import { withFinanceSpan } from '../common/finance-observability';

@Injectable()
export class AccountsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // CoA reads + writes wrapped in spans; no PostHog (kept lean per polish scope).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(Account.name)
    private readonly model: Model<Account>,
  ) {}

  /**
   * Seeds accounts from the business-type template JSON.
   * Idempotent — uses bulkWrite upsert on unique (workspaceId, firmId, code) index.
   */
  async seedFromTemplate(workspaceId: string, firmId: string, businessType: string): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.seedAccountsFromTemplate',
      { workspaceId, firmId },
      async () => {
        const seeds = COA_SEED_MAP[businessType] ?? COA_SEED_MAP['trading'];
        const wsId = new Types.ObjectId(workspaceId);
        const fId = new Types.ObjectId(firmId);

        const ops = seeds.map((seed: any) => ({
          updateOne: {
            filter: { workspaceId: wsId, firmId: fId, code: seed.code },
            update: {
              $setOnInsert: {
                workspaceId: wsId,
                firmId: fId,
                name: seed.name,
                code: seed.code,
                group: seed.group,
                subGroup: seed.subGroup,
                type: seed.type,
                isFromTemplate: true,
                isSystem: seed.isSystem ?? false,
                isDeleted: false,
              },
            },
            upsert: true,
          },
        }));

        await this.model.bulkWrite(ops);
      },
    );
  }

  async findAll(workspaceId: string, firmId: string, includeDeleted = false): Promise<Account[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.findAllAccounts',
      { workspaceId, firmId },
      async () => {
        const filter: any = {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        };
        if (!includeDeleted) filter.isDeleted = false;
        return this.model.find(filter).sort({ code: 1 }).exec();
      },
    );
  }

  async create(workspaceId: string, firmId: string, dto: any): Promise<Account> {
    return withFinanceSpan(
      this.tracer,
      'finance.createAccount',
      { workspaceId, firmId },
      async () => {
        const doc = new this.model({
          ...dto,
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          isFromTemplate: false,
          isSystem: false,
        });
        return doc.save();
      },
    );
  }

  async update(workspaceId: string, firmId: string, accountId: string, dto: any): Promise<Account> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateAccount',
      { workspaceId, firmId, accountId },
      async () => {
        const existing = await this.model
          .findOne({
            _id: new Types.ObjectId(accountId),
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
            isDeleted: false,
          })
          .exec();
        if (!existing) throw new NotFoundException('Account not found');
        // System accounts (Cash 1001, GST payables, Debtors, etc.) are referenced by `code`
        // throughout the posting engine (findByCode) and by `type` in the financial statements.
        // Re-coding or re-typing one bricks every posting / report that depends on it. Mirror the
        // delete guard (:remove) and block those fields on system accounts; name + cosmetic edits
        // stay allowed.
        if (existing.isSystem) {
          if (dto.code !== undefined && dto.code !== existing.code) {
            throw new ForbiddenException('System account code cannot be changed');
          }
          if (dto.type !== undefined && dto.type !== existing.type) {
            throw new ForbiddenException('System account type cannot be changed');
          }
        }
        const doc = await this.model
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(accountId),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            },
            { $set: dto },
            { new: true },
          )
          .exec();
        if (!doc) throw new NotFoundException('Account not found');
        return doc;
      },
    );
  }

  /**
   * Lookup a single account by its CoA code within a firm.
   * Used by LedgerPostingService to resolve account IDs for journal lines.
   * Throws NotFoundException if the code is not seeded for this firm.
   */
  async findByCode(workspaceId: string, firmId: string, code: string): Promise<Account> {
    return withFinanceSpan(
      this.tracer,
      'finance.findAccountByCode',
      { workspaceId, firmId },
      async () => {
        const doc = await this.model
          .findOne({
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
            code,
            isDeleted: false,
          })
          .exec();
        if (!doc) {
          throw new NotFoundException(`Account code ${code} not found for firm ${firmId}`);
        }
        return doc;
      },
    );
  }

  async remove(workspaceId: string, firmId: string, accountId: string): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.removeAccount',
      { workspaceId, firmId, accountId },
      async () => {
        const doc = await this.model
          .findOne({
            _id: new Types.ObjectId(accountId),
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
          })
          .exec();
        if (!doc) throw new NotFoundException('Account not found');
        if (doc.isSystem) {
          throw new ForbiddenException('System accounts cannot be deleted');
        }
        await this.model
          .updateOne({ _id: doc._id }, { isDeleted: true, deletedAt: new Date() })
          .exec();
      },
    );
  }
}
