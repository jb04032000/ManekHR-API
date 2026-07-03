import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { RecurringInvoiceTemplate } from './recurring-template.schema';
import { CreateRecurringTemplateDto } from './dto/create-recurring-template.dto';
import { UpdateRecurringTemplateDto } from './dto/update-recurring-template.dto';
import { SaleInvoiceService } from '../sale-invoice/sale-invoice.service';
import { SaleInvoice } from '../sale-invoice/sale-invoice.schema';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';

@Injectable()
export class RecurringInvoiceTemplateService {
  private readonly logger = new Logger(RecurringInvoiceTemplateService.name);
  // Platform-bar observability: shared finance tracer (mirrors SaleInvoiceService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(RecurringInvoiceTemplate.name)
    private readonly model: Model<RecurringInvoiceTemplate>,
    private readonly saleInvoiceService: SaleInvoiceService,
    private readonly postHog: PostHogService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async list(wsId: string, firmId: string): Promise<RecurringInvoiceTemplate[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(wsId: string, firmId: string, id: string): Promise<RecurringInvoiceTemplate> {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('RecurringInvoiceTemplate not found');
    return doc;
  }

  async create(
    wsId: string,
    firmId: string,
    dto: CreateRecurringTemplateDto,
    userId: string,
  ): Promise<RecurringInvoiceTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.createRecurringTemplate',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const startDate = new Date(dto.schedule.startDate);
        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          templateName: dto.templateName,
          partyId: new Types.ObjectId(dto.partyId),
          lineItems: dto.lineItems ?? [],
          additionalCharges: dto.additionalCharges ?? [],
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          paymentTerms: dto.paymentTerms,
          notes: dto.notes,
          schedule: {
            mode: dto.schedule.mode,
            dayOfMonth: dto.schedule.dayOfMonth,
            everyNDays: dto.schedule.everyNDays,
            startDate,
            endDate: dto.schedule.endDate ? new Date(dto.schedule.endDate) : undefined,
          },
          amountAuto: dto.amountAuto ?? true,
          autoPostOnGenerate: dto.autoPostOnGenerate ?? false,
          notifyOnGenerate: dto.notifyOnGenerate ?? { email: true, whatsapp: false, sms: false },
          isActive: true,
          nextRunAt: startDate,
          runCount: 0,
        });
        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful create (ids + schedule mode only).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.created_recurring_template',
          properties: {
            workspaceId: wsId,
            firmId,
            templateId: String(saved._id),
            scheduleMode: dto.schedule.mode,
          },
        });
        return saved;
      },
    );
  }

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateRecurringTemplateDto,
    userId: string,
  ): Promise<RecurringInvoiceTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateRecurringTemplate',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        if (dto.templateName !== undefined) doc.templateName = dto.templateName;
        if (dto.lineItems !== undefined) doc.lineItems = dto.lineItems;
        if (dto.additionalCharges !== undefined) doc.additionalCharges = dto.additionalCharges;
        if (dto.placeOfSupplyStateCode !== undefined)
          doc.placeOfSupplyStateCode = dto.placeOfSupplyStateCode;
        if (dto.paymentTerms !== undefined) doc.paymentTerms = dto.paymentTerms;
        if (dto.notes !== undefined) doc.notes = dto.notes;
        if (dto.autoPostOnGenerate !== undefined) doc.autoPostOnGenerate = dto.autoPostOnGenerate;
        if (dto.notifyOnGenerate !== undefined) {
          doc.notifyOnGenerate = {
            email: dto.notifyOnGenerate.email ?? doc.notifyOnGenerate.email,
            whatsapp: dto.notifyOnGenerate.whatsapp ?? doc.notifyOnGenerate.whatsapp,
            sms: dto.notifyOnGenerate.sms ?? doc.notifyOnGenerate.sms,
          };
        }
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

  async pause(id: string): Promise<RecurringInvoiceTemplate> {
    // Span only: pause()/resume() take just the template id (no ws/firm/user in scope),
    // so attribute carries the template id alone (still no PII).
    return withFinanceSpan(
      this.tracer,
      'finance.pauseRecurringTemplate',
      { templateId: id },
      async () => {
        const doc = await this.model.findById(id);
        if (!doc) throw new NotFoundException('RecurringInvoiceTemplate not found');
        doc.isActive = false;
        return doc.save();
      },
    );
  }

  async resume(id: string): Promise<RecurringInvoiceTemplate> {
    return withFinanceSpan(
      this.tracer,
      'finance.resumeRecurringTemplate',
      { templateId: id },
      async () => {
        const doc = await this.model.findById(id);
        if (!doc) throw new NotFoundException('RecurringInvoiceTemplate not found');
        doc.isActive = true;
        // If nextRunAt is in the past, advance it to now so cron picks it up next run
        if (doc.nextRunAt < new Date()) {
          doc.nextRunAt = this.computeNextRun(doc);
        }
        return doc.save();
      },
    );
  }

  async triggerNow(wsId: string, firmId: string, id: string, userId: string): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.triggerRecurringTemplate',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const template = await this.findOne(wsId, firmId, id);
        const invoice = await this.generateInvoiceFromTemplate(template, userId);
        template.lastRunAt = new Date();
        template.runCount += 1;
        template.nextRunAt = this.computeNextRun(template);
        if (template.schedule.endDate && template.nextRunAt > template.schedule.endDate) {
          template.isActive = false;
        }
        await template.save();
        // Fire-and-forget product analytics on the manual trigger (ids + generated invoice id).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.triggered_recurring_template',
          properties: {
            workspaceId: wsId,
            firmId,
            templateId: String(template._id),
            invoiceId: String((invoice as any)._id),
          },
        });
        return invoice;
      },
    );
  }

  async softDelete(wsId: string, firmId: string, id: string): Promise<RecurringInvoiceTemplate> {
    // Span only: softDelete() has no userId param (signature change is out of scope), so
    // no PostHog event here. Carries ws/firm + template id only.
    return withFinanceSpan(
      this.tracer,
      'finance.softDeleteRecurringTemplate',
      { workspaceId: wsId, firmId, templateId: id },
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

  computeNextRun(template: RecurringInvoiceTemplate): Date {
    const base = template.lastRunAt ?? template.schedule.startDate;
    const { mode, dayOfMonth, everyNDays } = template.schedule;

    switch (mode) {
      case 'monthly': {
        const next = new Date(base);
        next.setMonth(next.getMonth() + 1);
        // Clamp to actual last day of month (handles Feb, short months)
        if (dayOfMonth) {
          const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(dayOfMonth, maxDay));
        }
        return next;
      }
      case 'quarterly': {
        const next = new Date(base);
        next.setMonth(next.getMonth() + 3);
        if (dayOfMonth) {
          const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(dayOfMonth, maxDay));
        }
        return next;
      }
      case 'yearly': {
        const next = new Date(base);
        next.setFullYear(next.getFullYear() + 1);
        if (dayOfMonth) {
          const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(dayOfMonth, maxDay));
        }
        return next;
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

  // ─── previewNext3Runs ──────────────────────────────────────────────────────

  previewNext3Runs(template: RecurringInvoiceTemplate): Date[] {
    const runs: Date[] = [];
    // Clone template-like object for simulation
    const sim: any = {
      schedule: { ...template.schedule },
      lastRunAt: template.lastRunAt,
    };
    for (let i = 0; i < 3; i++) {
      const next = this.computeNextRun(sim as RecurringInvoiceTemplate);
      runs.push(next);
      sim.lastRunAt = next;
    }
    return runs;
  }

  // ─── generateInvoiceFromTemplate ──────────────────────────────────────────

  async generateInvoiceFromTemplate(
    template: RecurringInvoiceTemplate,
    userId: string,
  ): Promise<SaleInvoice> {
    const wsId = template.workspaceId.toHexString();
    const firmId = template.firmId.toHexString();

    const createDto: any = {
      partyId: template.partyId.toHexString(),
      voucherDate: new Date().toISOString(),
      lineItems: template.lineItems,
      additionalCharges: template.additionalCharges,
      placeOfSupplyStateCode: template.placeOfSupplyStateCode,
      paymentTerms: template.paymentTerms,
      notes: template.notes,
    };

    const invoice = await this.saleInvoiceService.createDraft(wsId, firmId, createDto, userId);

    // Link recurring template
    (invoice as any).recurringTemplateId = template._id;
    await invoice.save();

    if (template.autoPostOnGenerate) {
      try {
        return await this.saleInvoiceService.postInvoice(
          wsId,
          firmId,
          invoice._id.toHexString(),
          userId,
        );
      } catch (err: any) {
        this.logger.error(
          `autoPostOnGenerate failed for template ${String(template._id)}: ${err.message}`,
        );
        // Return the draft even if posting failed — don't lose the generated invoice
        return invoice;
      }
    }

    return invoice;
  }
}
