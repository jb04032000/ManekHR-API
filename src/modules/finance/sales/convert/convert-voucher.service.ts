import { Injectable, BadRequestException } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Types } from 'mongoose';
import { QuotationService } from '../quotation/quotation.service';
import { SaleOrderService } from '../sale-order/sale-order.service';
import { ProformaService } from '../proforma/proforma.service';
import { DeliveryChallanService } from '../delivery-challan/delivery-challan.service';
import { SaleInvoiceService } from '../sale-invoice/sale-invoice.service';
import { ConvertVoucherDto } from './dto/convert-voucher.dto';
import type { LinkedDoc } from '../voucher-base/voucher-base.interface';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../../common/finance-observability';

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  quotation: ['sale_order', 'proforma', 'delivery_challan', 'sale_invoice'],
  sale_order: ['delivery_challan', 'sale_invoice'],
  proforma: ['sale_invoice'],
  delivery_challan: ['sale_invoice'],
};

@Injectable()
export class ConvertVoucherService {
  // Platform-bar observability: shared finance tracer (mirrors SaleInvoiceService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    private readonly quotationService: QuotationService,
    private readonly saleOrderService: SaleOrderService,
    private readonly proformaService: ProformaService,
    private readonly deliveryChallanService: DeliveryChallanService,
    private readonly saleInvoiceService: SaleInvoiceService,
    private readonly postHog: PostHogService,
  ) {}

  private getSourceService(type: string) {
    switch (type) {
      case 'quotation':
        return this.quotationService;
      case 'sale_order':
        return this.saleOrderService;
      case 'proforma':
        return this.proformaService;
      case 'delivery_challan':
        return this.deliveryChallanService;
      default:
        throw new BadRequestException(`Unknown source type: ${type}`);
    }
  }

  private getTargetService(type: string) {
    switch (type) {
      case 'sale_order':
        return this.saleOrderService;
      case 'proforma':
        return this.proformaService;
      case 'delivery_challan':
        return this.deliveryChallanService;
      case 'sale_invoice':
        return this.saleInvoiceService;
      default:
        throw new BadRequestException(`Unknown target type: ${type}`);
    }
  }

  async convert(wsId: string, firmId: string, dto: ConvertVoucherDto, userId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.convertVoucher',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // 1. Validate transition allowed
        if (!ALLOWED_TRANSITIONS[dto.sourceType]?.includes(dto.targetType)) {
          throw new BadRequestException(`Cannot convert ${dto.sourceType} → ${dto.targetType}`);
        }
        if (dto.sourceIds.length === 0) {
          throw new BadRequestException('No source documents selected');
        }

        // 2. Load all source docs
        const sourceService = this.getSourceService(dto.sourceType);
        const sources = await Promise.all(
          dto.sourceIds.map((id) => sourceService.findOne(wsId, firmId, id)),
        );

        // 3. Validate same party — cannot combine docs from different parties
        const partyIds = new Set(
          sources.map((s: any) => (s.partyId as Types.ObjectId).toHexString()),
        );
        if (partyIds.size > 1) {
          throw new BadRequestException(
            'Cannot combine: selected documents belong to different parties. Multi-doc combine requires the same party.',
          );
        }

        // 4. Validate all sources are 'posted' (cannot convert from draft)
        const nonPosted = sources.filter((s: any) => s.state !== 'posted');
        if (nonPosted.length > 0) {
          throw new BadRequestException(
            `All source documents must be in 'posted' state. ${nonPosted.length} are not.`,
          );
        }

        // 5. Merge line items (preserve order across sources)
        const mergedLines = (sources as any[]).flatMap((s) => s.lineItems ?? []);
        const linkedDocs: LinkedDoc[] = (sources as any[]).map((s) => ({
          voucherType: dto.sourceType as any,
          voucherId: s._id as Types.ObjectId,
          voucherNumber: s.voucherNumber,
        }));

        // 6. Create target draft
        const targetService = this.getTargetService(dto.targetType);
        const firstSource: any = sources[0];
        const targetDto: any = {
          partyId: (firstSource.partyId as Types.ObjectId).toHexString(),
          voucherDate: new Date().toISOString(),
          lineItems: mergedLines,
          additionalCharges: firstSource.additionalCharges ?? [],
          placeOfSupplyStateCode: firstSource.placeOfSupplyStateCode,
          paymentTerms: firstSource.paymentTerms,
          notes: `Converted from ${(sources as any[]).map((s) => s.voucherNumber).join(', ')}`,
        };
        const target: any = await targetService.createDraft(wsId, firmId, targetDto, userId);

        // 7. Patch linkedDocs and persist
        target.linkedDocs = linkedDocs;
        await target.save();

        // 8. Mark sources as converted (keep conversion status per-type enum)
        for (const source of sources as any[]) {
          // Type-specific conversion status mapping
          if (dto.sourceType === 'sale_order') {
            source.conversionStatus = 'fully_converted';
          } else if (dto.sourceType === 'delivery_challan') {
            source.conversionStatus = 'invoiced';
          } else {
            source.conversionStatus = 'converted';
          }
          // Append audit entry
          (source.auditLog as any[]).push({
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'converted',
            after: { targetType: dto.targetType, targetId: target._id },
          });
          await source.save();
        }

        // Fire-and-forget product analytics on the conversion (source/target types + counts +
        // ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'sales.converted_voucher',
          properties: {
            workspaceId: wsId,
            firmId,
            sourceType: dto.sourceType,
            targetType: dto.targetType,
            sourceCount: dto.sourceIds.length,
            targetId: String(target._id),
          },
        });

        return target;
      },
    );
  }
}
