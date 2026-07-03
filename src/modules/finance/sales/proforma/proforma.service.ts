import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { Proforma } from './proforma.schema';
import { PartiesService } from '../../parties/parties.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';
import { CreateProformaDto } from './dto/create-proforma.dto';
import { UpdateProformaDto } from './dto/update-proforma.dto';
import { MailService } from '../../../mail/mail.service';
import { PrintService } from '../print/print.service';

@Injectable()
export class ProformaService {
  private readonly logger = new Logger(ProformaService.name);
  // Platform-bar observability: shared finance tracer (mirrors SaleInvoiceService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(Proforma.name) private readonly model: Model<Proforma>,
    private readonly partiesService: PartiesService,
    private readonly voucherSeries: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly mailService: MailService,
    private readonly printService: PrintService,
    private readonly postHog: PostHogService,
  ) {}

  async list(wsId: string, firmId: string, filters: any) {
    const q: any = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (filters.state) q.state = filters.state;
    if (filters.partyId) q.partyId = new Types.ObjectId(filters.partyId);
    if (filters.dateFrom || filters.dateTo) q.voucherDate = {};
    if (filters.dateFrom) q.voucherDate.$gte = new Date(filters.dateFrom);
    if (filters.dateTo) q.voucherDate.$lte = new Date(filters.dateTo);
    // Party search (q): match voucher number prefix or party name. Mirrors the sale-invoice
    // list filter so the shared list-page search box works here too. Regex metachars escaped
    // to avoid ReDoS via user input (WR-05).
    if (filters.q) {
      const escapedQ = String(filters.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      q.$or = [
        { voucherNumber: { $regex: `^${escapedQ}`, $options: 'i' } },
        { 'partySnapshot.name': { $regex: escapedQ, $options: 'i' } },
      ];
    }
    const limit = Math.min(filters.limit ?? 50, 200);
    const skip = filters.skip ?? 0;
    const [data, total] = await Promise.all([
      this.model.find(q).sort({ voucherDate: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments(q),
    ]);
    return { data, total };
  }

  async findOne(wsId: string, firmId: string, id: string) {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Proforma not found');
    return doc;
  }

  async createDraft(wsId: string, firmId: string, dto: CreateProformaDto, userId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.createProforma',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const party = await this.partiesService.findOne(wsId, firmId, dto.partyId);
        const partySnapshot = {
          name: (party as any).name,
          gstin: (party as any).gstin,
          billingAddress: (party as any).billingAddress,
          email: (party as any).email,
          phone: (party as any).phone,
        };
        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          partyId: new Types.ObjectId(dto.partyId),
          partySnapshot,
          voucherDate: new Date(dto.voucherDate),
          lineItems: dto.lineItems ?? [],
          additionalCharges: dto.additionalCharges ?? [],
          notes: dto.notes,
          internalNotes: dto.internalNotes,
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          paymentTerms: dto.paymentTerms,
          validUntilDate: dto.validUntilDate ? new Date(dto.validUntilDate) : undefined,
          state: 'draft',
          draftCreatedAt: new Date(),
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
        });
        await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.created_proforma',
          properties: { workspaceId: wsId, firmId, proformaId: String(doc._id) },
        });
        return doc;
      },
    );
  }

  async updateDraft(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateProformaDto,
    userId: string,
  ) {
    return withFinanceSpan(
      this.tracer,
      'finance.updateProforma',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        if (doc.state !== 'draft') throw new BadRequestException('Only drafts can be edited');
        Object.assign(doc, dto);
        doc.draftUpdatedAt = new Date();
        (doc.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });
        await doc.save();
        return doc;
      },
    );
  }

  async post(wsId: string, firmId: string, id: string, userId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.postProforma',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        if (doc.state !== 'draft') throw new BadRequestException('Only drafts can be posted');
        const firm = await this.firmsService.findOne(wsId, firmId);
        // D-20: FY guard — block backdating into closed financial year
        if (
          (firm as any).accountsBooksBeginDate &&
          doc.voucherDate < (firm as any).accountsBooksBeginDate
        ) {
          throw new BadRequestException(
            `Cannot post: ${doc.voucherDate.toISOString().split('T')[0]} falls in a closed financial year`,
          );
        }
        const fy = this.voucherSeries.getFYForDate(doc.voucherDate, (firm as any).fyStartMonth);
        doc.voucherNumber = await this.voucherSeries.generateNextNumber(firmId, 'proforma', fy);
        doc.state = 'posted';
        doc.postedAt = new Date();
        doc.postedBy = new Types.ObjectId(userId);
        (doc.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'posted',
          after: { voucherNumber: doc.voucherNumber },
        });
        await doc.save();
        // Fire-and-forget product analytics on the successful post (ids / voucher no only).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.posted_proforma',
          properties: {
            workspaceId: wsId,
            firmId,
            proformaId: String(doc._id),
            voucherNumber: doc.voucherNumber,
          },
        });
        return doc;
      },
    );
  }

  async cancel(wsId: string, firmId: string, id: string, reason: string, userId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelProforma',
      { workspaceId: wsId, firmId, userId },
      async () => {
        if (!reason) throw new BadRequestException('Cancellation reason required');
        const doc = await this.findOne(wsId, firmId, id);
        if (doc.state !== 'posted')
          throw new BadRequestException('Only posted vouchers can be cancelled');
        doc.state = 'cancelled';
        doc.cancelledAt = new Date();
        doc.cancelledBy = new Types.ObjectId(userId);
        doc.cancellationReason = reason;
        (doc.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancelled',
          reason,
        });
        await doc.save();
        // Fire-and-forget product analytics on the successful cancel (ids / voucher no only).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.cancelled_proforma',
          properties: {
            workspaceId: wsId,
            firmId,
            proformaId: String(doc._id),
            voucherNumber: doc.voucherNumber,
          },
        });
        return doc;
      },
    );
  }

  async clone(wsId: string, firmId: string, id: string, userId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.cloneProforma',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const src = await this.findOne(wsId, firmId, id);
        const obj: any = src.toObject();
        delete obj._id;
        delete obj.voucherNumber;
        delete obj.postedAt;
        delete obj.postedBy;
        delete obj.cancelledAt;
        delete obj.cancelledBy;
        delete obj.cancellationReason;
        obj.state = 'draft';
        obj.draftCreatedAt = new Date();
        obj.auditLog = [
          {
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'cloned',
            before: { sourceId: src._id },
          },
        ];
        const clone = new this.model(obj);
        await clone.save();
        // Fire-and-forget product analytics on the clone write (source + new ids only).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.cloned_proforma',
          properties: {
            workspaceId: wsId,
            firmId,
            proformaId: String(clone._id),
            sourceId: String(src._id),
          },
        });
        return clone;
      },
    );
  }

  async voidDraft(wsId: string, firmId: string, id: string, userId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.voidProformaDraft',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        if (doc.state !== 'draft') throw new BadRequestException('Only drafts can be voided');
        doc.state = 'void';
        doc.isDeleted = true;
        doc.deletedAt = new Date();
        (doc.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'voided',
        });
        await doc.save();
        return doc;
      },
    );
  }

  async sendVoucher(
    wsId: string,
    firmId: string,
    id: string,
    body: { channels: string[]; message?: string; recipientEmail?: string },
    userId: string,
  ): Promise<{ dispatched: string[]; voucherId: string; errors: Record<string, string> }> {
    return withFinanceSpan(
      this.tracer,
      'finance.sendProforma',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        const firm = await this.firmsService.findOne(wsId, firmId);
        const dispatched: string[] = [];
        const errors: Record<string, string> = {};

        for (const channel of body.channels) {
          try {
            if (channel === 'email') {
              const to = body.recipientEmail ?? (doc as any).partySnapshot?.email;
              if (!to) throw new BadRequestException('No email address available for party');
              const pdfBuffer = await this.printService.generatePdfBuffer(doc, 'a4-theme1');
              const attachments: any[] = [
                {
                  filename: `proforma-${(doc as any).voucherNumber ?? String(doc._id)}.pdf`,
                  content: pdfBuffer,
                  contentType: 'application/pdf',
                },
              ];
              const subject = `Proforma Invoice ${(doc as any).voucherNumber ?? '(draft)'} from ${(firm as any).firmName}`;
              const html = `<p>Dear ${(doc as any).partySnapshot?.name ?? 'Customer'},</p><p>${body.message ?? `Please find attached proforma invoice ${(doc as any).voucherNumber ?? ''}.`}</p><p>Thank you,<br/>${(firm as any).firmName}</p>`;
              // Wave-3 Drift #32 — universal email-quota enforcement.
              await this.mailService.enforceEmailQuota(wsId);
              await this.mailService.sendInvoiceEmail({ to, subject, html, attachments });
              await this.mailService.incrementEmailUsage(wsId);
              dispatched.push('email');
            } else if (channel === 'whatsapp') {
              this.logger.warn(
                `WhatsApp channel stubbed for voucher ${id} — full adapter ships in F-08`,
              );
              dispatched.push('whatsapp:stub');
            } else if (channel === 'sms') {
              this.logger.warn(`SMS channel stubbed for voucher ${id}`);
              dispatched.push('sms:stub');
            } else if (channel === 'print') {
              dispatched.push('print');
            } else {
              errors[channel] = `Unknown channel: ${channel}`;
            }
          } catch (e: any) {
            errors[channel] = e.message;
          }
        }

        (doc.auditLog as any[]).push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'sent',
          after: { channels: dispatched },
        });
        await doc.save();

        // Fire-and-forget product analytics on send. Channel names + counts only; recipient
        // email/phone are intentionally NOT logged (PII rule).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.sent_proforma',
          properties: {
            workspaceId: wsId,
            firmId,
            proformaId: String(doc._id),
            channels: dispatched,
            dispatchedCount: dispatched.length,
            errorCount: Object.keys(errors).length,
          },
        });

        return { dispatched, voucherId: id, errors };
      },
    );
  }
}
