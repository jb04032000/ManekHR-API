import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { withFinanceSpan } from '../../common/finance-observability';
import { SaleInvoice } from '../sale-invoice/sale-invoice.schema';
import { DeliveryChallan } from '../delivery-challan/delivery-challan.schema';
import { SaleInvoiceService } from '../sale-invoice/sale-invoice.service';
import { FirmsService } from '../../firms/firms.service';
import { SurepassIrpProvider } from '../einvoice/providers/surepass-irp.provider';
import { NicDirectProvider } from '../einvoice/providers/nic-direct.provider';
import { IrpProviderAdapter } from '../einvoice/providers/irp-provider.interface';
import { EwaybillPayloadBuilder, TransportInput } from './ewaybill-payload.builder';
import { EwbValidityService } from './ewaybill-validity.service';
import { GenerateEwbDto } from './dto/generate-ewb.dto';
import { ExtendEwbDto } from './dto/extend-ewb.dto';
import { PostHogService } from '../../../../common/posthog/posthog.service';

@Injectable()
export class EwaybillService {
  private readonly logger = new Logger(EwaybillService.name);
  // Platform-bar observability: shared finance tracer (mirrors SaleInvoiceService).
  // OTel spans on every write; PostHog product-analytics events on successful EWB writes.
  // distinct-id = the authenticated userId, threaded from the controllers (mirrors
  // sale-invoice.controller). userId is optional and the capture is guarded so any callless
  // path skips cleanly. Never emit raw GSTIN/PAN/EWB numbers - only ids + presence booleans.
  // See CLAUDE.md > PostHog.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(SaleInvoice.name) private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(DeliveryChallan.name) private readonly challanModel: Model<DeliveryChallan>,
    private readonly config: ConfigService,
    private readonly saleInvoiceService: SaleInvoiceService,
    private readonly firmsService: FirmsService,
    private readonly payloadBuilder: EwaybillPayloadBuilder,
    private readonly validityService: EwbValidityService,
    private readonly surepassIrpProvider: SurepassIrpProvider,
    private readonly nicDirectProvider: NicDirectProvider,
    // @Global PostHogService - no module import needed. Fire-and-forget analytics only.
    private readonly postHog: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // Provider factory (mirrors EInvoiceService pattern — T-12-W2-05)
  // ---------------------------------------------------------------------------

  /**
   * Returns the EWB provider based on firm.ewbConfig.mode.
   * Default = SurepassIrpProvider (gsp_surepass).
   * NIC Direct = NicDirectProvider.
   *
   * SECURITY: firm.ewbConfig.mode is from DB — not from client request.
   */
  private resolveProvider(firm: any): IrpProviderAdapter {
    if (firm.ewbConfig?.mode === 'nic_direct') {
      return this.nicDirectProvider;
    }
    return this.surepassIrpProvider;
  }

  // ---------------------------------------------------------------------------
  // EWB operations
  // ---------------------------------------------------------------------------

  /**
   * Shared EWB compute path: 180-day guard + Gujarat-textile exemption + payload build +
   * provider call + validity. Behaviour-preserving extraction so sale invoices (generate)
   * and delivery challans (generateForChallan) run identical logic. Returns { exempt:true }
   * when no EWB is needed, otherwise the ewayBill subdoc the caller persists on its voucher.
   * Cross-link: EwaybillPayloadBuilder maps voucherType=delivery_challan -> docType CHL.
   * Watch: `voucher` must expose top-level tax totals (taxableValuePaise/cgstPaise/.../
   * grandTotalPaise) - invoices store these; the challan caller sums line items first.
   */
  private async computeEwb(
    voucher: any,
    firm: any,
    dto: GenerateEwbDto,
  ): Promise<{
    exempt: boolean;
    ewbNo: string;
    validUpto: Date;
    subdoc?: {
      ewbNo: string;
      generatedAt: Date;
      validUpto: Date;
      vehicleNo?: string;
      status: string;
    };
  }> {
    const now = new Date();

    // 180-day docDate guard (Jan 2025 NIC rule) - reads server-stored voucherDate.
    const docAgeMs = now.getTime() - new Date(voucher.voucherDate).getTime();
    if (docAgeMs > 180 * 24 * 3600 * 1000) {
      throw new BadRequestException(
        'EWB_DOC_TOO_OLD: Cannot generate e-Way Bill - document date is more than 180 days old. ' +
          `Document date: ${new Date(voucher.voucherDate).toISOString()}. NIC EWB API rejects documents older than 180 days (January 2025 rule).`,
      );
    }

    // Gujarat textile HSN exemption detection (RESEARCH Code Example 4)
    const firmStateCode = parseInt((firm.gstin ?? '00').substring(0, 2), 10);
    const party = voucher.partySnapshot ?? {};
    const partyStateCode = party?.gstin
      ? parseInt(party.gstin.substring(0, 2), 10)
      : parseInt(voucher.placeOfSupplyStateCode ?? '0', 10) || firmStateCode;

    const ewbItemLines = (voucher.lineItems ?? []).map((item: any) => ({
      productName: item.itemName ?? 'Item',
      hsnCd: (item.hsnSacCode ?? '').trim(),
      quantity: item.qty ?? 0,
      qtyUnit: item.unit ?? 'NOS',
      taxableAmount: (item.taxableValuePaise ?? 0) / 100,
      sgstRate: item.taxRate ? item.taxRate / 2 : 0,
      cgstRate: item.taxRate ? item.taxRate / 2 : 0,
      igstRate: firmStateCode !== partyStateCode ? (item.taxRate ?? 0) : 0,
      cessRate: item.cessRate ?? 0,
    }));

    if (
      !dto.overrideExemption &&
      this.payloadBuilder.isGujaratTextileExempt(firmStateCode, partyStateCode, ewbItemLines)
    ) {
      this.logger.log(
        `EWB generation skipped: Gujarat intrastate textile exemption applies for ${voucher.voucherType ?? 'voucher'} ${voucher._id}`,
      );
      return { exempt: true, ewbNo: '', validUpto: now }; // Exempt - no EWB needed
    }

    const transport: TransportInput = {
      transMode: dto.transMode,
      transDistance: dto.transDistance,
      vehicleNo: dto.vehicleNo,
      vehicleType: dto.vehicleType,
      transporterId: dto.transporterId,
      transporterName: dto.transporterName,
      transDocNo: dto.transDocNo,
      transDocDate: dto.transDocDate,
    };

    const ewbPayload = this.payloadBuilder.build(voucher, firm, party, transport);
    const provider = this.resolveProvider(firm);
    const response = await provider.generateEwb(ewbPayload, firm.gstin ?? '');

    const ewbNo: string = response.ewbNo;
    // WR-06: prefer IRP-returned validUpto (authoritative) over local computation.
    const validUpto: Date = response.validUpto
      ? new Date(response.validUpto)
      : this.validityService.computeValidUpto(
          now,
          dto.transMode,
          dto.vehicleType,
          dto.transDistance,
        );

    return {
      exempt: false,
      ewbNo,
      validUpto,
      subdoc: { ewbNo, generatedAt: now, validUpto, vehicleNo: dto.vehicleNo, status: 'active' },
    };
  }

  /**
   * Generates an e-Way Bill for a posted sale invoice.
   *
   * Guards (in computeEwb):
   * - T-12-W3-06: docDate read from invoice.voucherDate (server-stored) — client cannot override.
   * - 180-day guard: EWB cannot be generated for invoices older than 180 days (Jan 2025 NIC rule).
   * - Gujarat textile exemption: auto-detected; pass dto.overrideExemption=true to bypass.
   *
   * On success: patches invoice.ewayBill with ewbNo, generatedAt, validUpto, vehicleNo, status='active'.
   */
  async generate(
    wsId: string,
    firmId: string,
    invoiceId: string,
    dto: GenerateEwbDto,
    userId?: string,
  ): Promise<{ ewbNo: string; validUpto: Date }> {
    return withFinanceSpan(
      this.tracer,
      'finance.generateEwayBill',
      { workspaceId: wsId, firmId, invoiceId },
      async () => {
        const invoice = await this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
        const firm = await this.firmsService.findOne(wsId, firmId);

        const r = await this.computeEwb(invoice, firm, dto);
        // Exempt path (Gujarat textile intrastate) generates no EWB - no analytics event.
        if (r.exempt) return { ewbNo: '', validUpto: r.validUpto };

        (invoice as any).ewayBill = r.subdoc;
        await invoice.save();

        this.logger.log(
          `EWB generated for invoice ${invoiceId}: ewbNo=${r.ewbNo}, validUpto=${r.validUpto.toISOString()}`,
        );

        // Fire-and-forget product analytics. Skipped for background callers (no userId).
        if (userId) {
          this.postHog.capture({
            distinctId: userId,
            event: 'sales.generated_eway_bill',
            properties: { workspaceId: wsId, firmId, invoiceId, hasEwbNo: !!r.ewbNo },
          });
        }
        return { ewbNo: r.ewbNo, validUpto: r.validUpto };
      },
    );
  }

  /**
   * Generates an e-Way Bill for a posted delivery challan. Challans move goods, so the EWB is
   * the primary document here. Reuses computeEwb (same guard/exemption/provider path as
   * invoices); the payload builder maps voucherType=delivery_challan -> CHL. Delivery challans
   * store tax only on line items (no top-level totals), so we sum line items + taxable
   * additional charges into the totals the payload builder expects. Persists ewayBill on the
   * challan. Cross-link: DeliveryChallan schema (ewayBill field) + delivery-challan module.
   */
  async generateForChallan(
    wsId: string,
    firmId: string,
    challanId: string,
    dto: GenerateEwbDto,
    userId?: string,
  ): Promise<{ ewbNo: string; validUpto: Date }> {
    return withFinanceSpan(
      this.tracer,
      'finance.generateEwayBillForChallan',
      { workspaceId: wsId, firmId, challanId },
      async () => {
        const challan = await this.challanModel.findOne({
          _id: challanId,
          workspaceId: wsId,
          firmId,
          isDeleted: { $ne: true },
        });
        if (!challan) throw new BadRequestException('Delivery challan not found');
        if ((challan as any).state !== 'posted') {
          throw new BadRequestException(
            'e-Way Bill can only be generated for a posted delivery challan.',
          );
        }

        const firm = await this.firmsService.findOne(wsId, firmId);

        // Sum per-line tax into the top-level totals the payload builder reads (invoices store
        // these at the top level; challans do not).
        const lines: any[] = (challan as any).lineItems ?? [];
        const charges: any[] = (challan as any).additionalCharges ?? [];
        const sum = (arr: any[], k: string) => arr.reduce((a, x) => a + (x[k] ?? 0), 0);
        const taxableCharges = charges
          .filter((c) => c.isTaxable)
          .reduce((a, c) => a + (c.amountPaise ?? 0), 0);
        const totals = {
          taxableValuePaise: sum(lines, 'taxableValuePaise') + taxableCharges,
          cgstPaise: sum(lines, 'cgstPaise'),
          sgstPaise: sum(lines, 'sgstPaise'),
          igstPaise: sum(lines, 'igstPaise'),
          cessPaise: sum(lines, 'cessPaise'),
          grandTotalPaise: sum(lines, 'lineTotalPaise') + sum(charges, 'amountPaise'),
        };
        const view = { ...challan.toObject(), ...totals };

        const r = await this.computeEwb(view, firm, dto);
        // Exempt path (Gujarat textile intrastate) generates no EWB - no analytics event.
        if (r.exempt) return { ewbNo: '', validUpto: r.validUpto };

        (challan as any).ewayBill = r.subdoc;
        await challan.save();

        this.logger.log(
          `EWB generated for challan ${challanId}: ewbNo=${r.ewbNo}, validUpto=${r.validUpto.toISOString()}`,
        );

        // Fire-and-forget product analytics. Skipped for background callers (no userId).
        if (userId) {
          this.postHog.capture({
            distinctId: userId,
            event: 'sales.generated_challan_eway_bill',
            properties: { workspaceId: wsId, firmId, challanId, hasEwbNo: !!r.ewbNo },
          });
        }
        return { ewbNo: r.ewbNo, validUpto: r.validUpto };
      },
    );
  }

  /**
   * Extends an active EWB validity.
   *
   * Guard: only allowed within ±8h window of validUpto (NIC EWB API requirement).
   * Throws 'EWB_EXTENSION_WINDOW' if outside window.
   *
   * On success: updates ewayBill.validUpto and vehicleNo.
   */
  async extend(
    wsId: string,
    firmId: string,
    invoiceId: string,
    dto: ExtendEwbDto,
    userId?: string,
  ): Promise<{ ewbNo: string; validUpto: Date }> {
    return withFinanceSpan(
      this.tracer,
      'finance.extendEwayBill',
      { workspaceId: wsId, firmId, invoiceId },
      async () => {
        const invoice = await this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
        const firm = await this.firmsService.findOne(wsId, firmId);

        const ewb = (invoice as any).ewayBill;
        if (!ewb || ewb.status !== 'active' || !ewb.ewbNo) {
          throw new BadRequestException(
            'Cannot extend: invoice does not have an active e-Way Bill.',
          );
        }

        // ±8h extension window guard (T-12-W3 plan must_haves)
        const validUpto: Date =
          ewb.validUpto instanceof Date ? ewb.validUpto : new Date(ewb.validUpto);
        if (!this.validityService.isWithinExtensionWindow(validUpto)) {
          throw new BadRequestException(
            'EWB_EXTENSION_WINDOW: Extension is only allowed within ±8 hours of the EWB validity expiry. ' +
              `Current validUpto: ${validUpto.toISOString()}. Current time: ${new Date().toISOString()}.`,
          );
        }

        const provider = this.resolveProvider(firm);

        const response = await provider.extendEwb(
          ewb.ewbNo,
          dto.vehicleNo,
          dto.fromPlace,
          dto.fromState,
          dto.remainDist,
          dto.vehicleType,
        );

        // Recompute new validUpto based on remaining distance
        const newValidUpto = this.validityService.computeValidUpto(
          new Date(),
          dto.transMode,
          dto.vehicleType,
          dto.remainDist,
        );

        (invoice as any).ewayBill = {
          ...ewb,
          validUpto: response.validUpto ? new Date(response.validUpto) : newValidUpto,
          vehicleNo: dto.vehicleNo,
        };
        await invoice.save();

        this.logger.log(
          `EWB extended for invoice ${invoiceId}: ewbNo=${ewb.ewbNo}, newValidUpto=${newValidUpto.toISOString()}`,
        );

        // Fire-and-forget product analytics. Skipped for background callers (no userId).
        if (userId) {
          this.postHog.capture({
            distinctId: userId,
            event: 'sales.extended_eway_bill',
            properties: { workspaceId: wsId, firmId, invoiceId, hasEwbNo: !!ewb.ewbNo },
          });
        }

        return { ewbNo: ewb.ewbNo, validUpto: newValidUpto };
      },
    );
  }

  /**
   * Cancels an active EWB within 24 hours of generation (NIC EWB cancel window).
   *
   * On success: sets ewayBill.status = 'cancelled'.
   */
  async cancel(
    wsId: string,
    firmId: string,
    invoiceId: string,
    cancelReason: number,
    cancelRemarks: string,
    userId?: string,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelEwayBill',
      { workspaceId: wsId, firmId, invoiceId },
      async () => {
        const invoice = await this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
        const firm = await this.firmsService.findOne(wsId, firmId);

        const ewb = (invoice as any).ewayBill;
        if (!ewb || ewb.status !== 'active' || !ewb.ewbNo) {
          throw new BadRequestException(
            'Cannot cancel: invoice does not have an active e-Way Bill.',
          );
        }

        // 24-hour cancel window (NIC EWB rule mirrors IRN cancel rule)
        const generatedAt: Date =
          ewb.generatedAt instanceof Date ? ewb.generatedAt : new Date(ewb.generatedAt);
        const elapsedMs = Date.now() - generatedAt.getTime();
        if (elapsedMs >= 24 * 3600 * 1000) {
          throw new BadRequestException(
            'EWB_CANCEL_WINDOW_EXPIRED: The 24-hour EWB cancellation window has passed. ' +
              `EWB was generated at ${generatedAt.toISOString()}.`,
          );
        }

        const provider = this.resolveProvider(firm);
        await provider.cancelEwb(ewb.ewbNo, cancelReason, cancelRemarks);

        (invoice as any).ewayBill = {
          ...ewb,
          status: 'cancelled',
        };
        await invoice.save();

        this.logger.log(`EWB cancelled for invoice ${invoiceId}: ewbNo=${ewb.ewbNo}`);

        // Fire-and-forget product analytics. Skipped for background callers (no userId).
        if (userId) {
          this.postHog.capture({
            distinctId: userId,
            event: 'sales.cancelled_eway_bill',
            properties: { workspaceId: wsId, firmId, invoiceId, cancelReason },
          });
        }
      },
    );
  }

  /**
   * Lists invoices with EWBs expiring within the next N hours.
   *
   * Used by the web dashboard to show "EWBs expiring soon" alerts.
   *
   * @param hoursAhead  Look-ahead window in hours (default: 48)
   */
  async listExpiring(
    wsId: string,
    firmId: string,
    hoursAhead: number = 48,
  ): Promise<SaleInvoice[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 3600 * 1000);

    return (await this.invoiceModel
      .find({
        workspaceId: wsId,
        firmId,
        'ewayBill.status': 'active',
        'ewayBill.validUpto': { $lte: cutoff },
      })
      .sort({ 'ewayBill.validUpto': 1 })
      .lean()
      .exec()) as any;
  }

  /**
   * Lists invoices filtered by EWB status with pagination.
   *
   * Status options:
   *   'active'   — ewayBill.status='active' AND validUpto >= now
   *   'expiring' — ewayBill.status='active' AND validUpto < now+48h
   *   'expired'  — ewayBill.status='active' AND validUpto < now (auto-classify from non-updated records)
   *                OR ewayBill.status='expired'
   *   'cancelled' — ewayBill.status='cancelled'
   *
   * @param status  Filter mode
   * @param page    0-based page index
   * @param size    Page size (max 50)
   */
  async listByStatus(
    wsId: string,
    firmId: string,
    status: 'active' | 'expiring' | 'expired' | 'cancelled',
    page = 0,
    size = 50,
  ): Promise<{ items: SaleInvoice[]; total: number }> {
    const now = new Date();
    const expiryCutoff = new Date(now.getTime() + 48 * 3600 * 1000);

    let filter: Record<string, any>;

    switch (status) {
      case 'active':
        filter = {
          workspaceId: wsId,
          firmId,
          'ewayBill.status': 'active',
          'ewayBill.validUpto': { $gte: now },
        };
        break;

      case 'expiring':
        // Active EWBs expiring within 48 hours
        filter = {
          workspaceId: wsId,
          firmId,
          'ewayBill.status': 'active',
          'ewayBill.validUpto': { $gte: now, $lte: expiryCutoff },
        };
        break;

      case 'expired':
        // Active status but validUpto already past (NIC doesn't auto-update status)
        filter = {
          workspaceId: wsId,
          firmId,
          $or: [
            {
              'ewayBill.status': 'active',
              'ewayBill.validUpto': { $lt: now },
            },
            { 'ewayBill.status': 'expired' },
          ],
        };
        break;

      case 'cancelled':
        filter = {
          workspaceId: wsId,
          firmId,
          'ewayBill.status': 'cancelled',
        };
        break;
    }

    const [items, total] = await Promise.all([
      this.invoiceModel
        .find(filter)
        .sort({ 'ewayBill.validUpto': 1 })
        .skip(page * size)
        .limit(size)
        .lean()
        .exec() as any,
      this.invoiceModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }
}
