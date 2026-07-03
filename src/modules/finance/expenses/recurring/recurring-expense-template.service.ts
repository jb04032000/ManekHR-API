import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { RecurringExpenseTemplate } from './recurring-expense-template.schema';
import { CreateRecurringExpenseDto } from './dto/create-recurring-expense.dto';
import { UpdateRecurringExpenseDto } from './dto/update-recurring-expense.dto';
import { ExpensesService } from '../expenses.service';
import { ExpenseVoucher } from '../expense-voucher.schema';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';

@Injectable()
export class RecurringExpenseTemplateService {
  private readonly logger = new Logger(RecurringExpenseTemplateService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // CRUD methods carry no userId in their signatures, so they get spans only;
  // triggerNow / generateExpenseFromTemplate have userId and also emit PostHog.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(RecurringExpenseTemplate.name)
    private readonly model: Model<RecurringExpenseTemplate>,
    private readonly expensesService: ExpensesService,
    private readonly postHog: PostHogService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async list(wsId: string, firmId: string): Promise<RecurringExpenseTemplate[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(wsId: string, firmId: string, id: string): Promise<RecurringExpenseTemplate> {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('RecurringExpenseTemplate not found');
    return doc;
  }

  async create(
    wsId: string,
    firmId: string,
    dto: CreateRecurringExpenseDto,
  ): Promise<RecurringExpenseTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.createRecurringExpenseTemplate',
      { workspaceId: wsId, firmId },
      async () => {
        const startDate = new Date(dto.schedule.startDate);
        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          templateName: dto.templateName,
          partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
          paymentMode: dto.paymentMode,
          bankAccountId: dto.bankAccountId ? new Types.ObjectId(dto.bankAccountId) : undefined,
          lineItems: (dto.lineItems ?? []).map((l) => ({
            expenseAccountId: new Types.ObjectId(l.expenseAccountId),
            description: l.description,
            amountPaise: l.amountPaise,
            gstRate: l.gstRate,
            itcEligibility: l.itcEligibility ?? 'full',
            costCentre: l.costCentre,
          })),
          isIntraState: dto.isIntraState ?? true,
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          narration: dto.narration ?? '',
          schedule: {
            mode: dto.schedule.mode,
            dayOfMonth: dto.schedule.dayOfMonth,
            everyNDays: dto.schedule.everyNDays,
            startDate,
            endDate: dto.schedule.endDate ? new Date(dto.schedule.endDate) : undefined,
          },
          autoPostOnGenerate: dto.autoPostOnGenerate ?? false,
          isActive: true,
          nextRunAt: startDate,
          runCount: 0,
        });
        return doc.save();
      },
    );
  }

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateRecurringExpenseDto,
  ): Promise<RecurringExpenseTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateRecurringExpenseTemplate',
      { workspaceId: wsId, firmId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        if (dto.templateName !== undefined) doc.templateName = dto.templateName;
        if (dto.partyId !== undefined)
          doc.partyId = dto.partyId ? new Types.ObjectId(dto.partyId) : undefined;
        if (dto.paymentMode !== undefined) doc.paymentMode = dto.paymentMode;
        if (dto.bankAccountId !== undefined)
          doc.bankAccountId = dto.bankAccountId ? new Types.ObjectId(dto.bankAccountId) : undefined;
        if (dto.lineItems !== undefined) {
          doc.lineItems = dto.lineItems.map((l) => ({
            expenseAccountId: new Types.ObjectId(l.expenseAccountId),
            description: l.description,
            amountPaise: l.amountPaise,
            gstRate: l.gstRate,
            itcEligibility: l.itcEligibility ?? 'full',
            costCentre: l.costCentre,
          }));
        }
        if (dto.isIntraState !== undefined) doc.isIntraState = dto.isIntraState;
        if (dto.placeOfSupplyStateCode !== undefined)
          doc.placeOfSupplyStateCode = dto.placeOfSupplyStateCode;
        if (dto.narration !== undefined) doc.narration = dto.narration;
        if (dto.autoPostOnGenerate !== undefined) doc.autoPostOnGenerate = dto.autoPostOnGenerate;
        if (dto.schedule !== undefined) {
          doc.schedule = {
            mode: dto.schedule.mode ?? doc.schedule.mode,
            dayOfMonth: dto.schedule.dayOfMonth,
            everyNDays: dto.schedule.everyNDays,
            startDate: dto.schedule.startDate
              ? new Date(dto.schedule.startDate)
              : doc.schedule.startDate,
            endDate: dto.schedule.endDate ? new Date(dto.schedule.endDate) : doc.schedule.endDate,
          };
        }
        return doc.save();
      },
    );
  }

  async pause(wsId: string, firmId: string, id: string): Promise<RecurringExpenseTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.pauseRecurringExpenseTemplate',
      { workspaceId: wsId, firmId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        doc.isActive = false;
        return doc.save();
      },
    );
  }

  async resume(wsId: string, firmId: string, id: string): Promise<RecurringExpenseTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.resumeRecurringExpenseTemplate',
      { workspaceId: wsId, firmId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        doc.isActive = true;
        if (doc.nextRunAt < new Date()) {
          doc.nextRunAt = this.computeNextRun(doc);
        }
        return doc.save();
      },
    );
  }

  async triggerNow(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<ExpenseVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.triggerRecurringExpenseTemplate',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const template = await this.findOne(wsId, firmId, id);
        const voucher = await this.generateExpenseFromTemplate(template, userId);
        template.lastRunAt = new Date();
        template.runCount += 1;
        template.nextRunAt = this.computeNextRun(template);
        if (template.schedule.endDate && template.nextRunAt > template.schedule.endDate) {
          template.isActive = false;
        }
        await template.save();
        // Fire-and-forget product analytics on the successful manual trigger (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.triggered_recurring_expense',
          properties: {
            workspaceId: wsId,
            firmId,
            templateId: String(template._id),
            expenseId: String((voucher as any)._id),
          },
        });
        return voucher;
      },
    );
  }

  async softDelete(wsId: string, firmId: string, id: string): Promise<RecurringExpenseTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.deleteRecurringExpenseTemplate',
      { workspaceId: wsId, firmId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        doc.isDeleted = true;
        doc.deletedAt = new Date();
        doc.isActive = false;
        return doc.save();
      },
    );
  }

  // ─── computeNextRun (pure helper) ─────────────────────────────────────────

  computeNextRun(template: RecurringExpenseTemplate): Date {
    const base = template.lastRunAt ?? template.schedule.startDate;
    const { mode, dayOfMonth, everyNDays } = template.schedule;
    const clampDay = (next: Date) => {
      if (dayOfMonth) {
        const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(dayOfMonth, maxDay));
      }
      return next;
    };
    switch (mode) {
      case 'monthly': {
        const next = new Date(base);
        next.setMonth(next.getMonth() + 1);
        return clampDay(next);
      }
      case 'quarterly': {
        const next = new Date(base);
        next.setMonth(next.getMonth() + 3);
        return clampDay(next);
      }
      case 'yearly': {
        const next = new Date(base);
        next.setFullYear(next.getFullYear() + 1);
        return clampDay(next);
      }
      case 'every_n_days': {
        if (!everyNDays || everyNDays <= 0) {
          throw new BadRequestException('everyNDays must be a positive integer');
        }
        return new Date(base.getTime() + everyNDays * 86_400_000);
      }
      default:
        throw new BadRequestException(`Unknown schedule mode: ${String(mode)}`);
    }
  }

  // ─── generateExpenseFromTemplate ──────────────────────────────────────────

  async generateExpenseFromTemplate(
    template: RecurringExpenseTemplate,
    userId: string,
  ): Promise<ExpenseVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.generateExpenseFromTemplate',
      {
        workspaceId: template.workspaceId.toString(),
        firmId: template.firmId.toString(),
        userId,
      },
      async () => {
        const workspaceId = template.workspaceId;
        const firmId = template.firmId;

        const createDto: any = {
          voucherDate: new Date().toISOString(),
          partyId: template.partyId ? template.partyId.toHexString() : undefined,
          paymentMode: template.paymentMode,
          bankAccountId: template.bankAccountId ? template.bankAccountId.toHexString() : undefined,
          isIntraState: template.isIntraState,
          placeOfSupplyStateCode: template.placeOfSupplyStateCode,
          narration: template.narration || template.templateName,
          lineItems: (template.lineItems ?? []).map((l) => ({
            expenseAccountId: l.expenseAccountId.toHexString(),
            description: l.description,
            amountPaise: l.amountPaise,
            gstRate: l.gstRate,
            itcEligibility: l.itcEligibility ?? 'full',
            costCentre: l.costCentre,
          })),
        };

        const voucher = await this.expensesService.create(workspaceId, firmId, createDto, userId);

        // Fire-and-forget product analytics on the generated expense (ids only). Fires once
        // per generation, covering both the manual triggerNow path and the cron-driven path.
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.generated_recurring_expense',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            templateId: String(template._id),
            expenseId: String((voucher as any)._id),
          },
        });

        if (template.autoPostOnGenerate) {
          try {
            return await this.expensesService.post(workspaceId, firmId, voucher._id, userId);
          } catch (err: any) {
            this.logger.error(
              `autoPostOnGenerate failed for recurring expense ${String(template._id)}: ${String(err?.message)}`,
            );
            return voucher;
          }
        }
        return voucher;
      },
    );
  }
}
