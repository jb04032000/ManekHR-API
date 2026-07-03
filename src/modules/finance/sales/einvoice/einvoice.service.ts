import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model } from 'mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { withFinanceSpan } from '../../common/finance-observability';
import { SaleInvoice } from '../sale-invoice/sale-invoice.schema';
import { CreditNote } from '../../credit-notes/credit-note.schema';
import { SaleInvoiceService } from '../sale-invoice/sale-invoice.service';
import { FirmsService } from '../../firms/firms.service';
import { SurepassIrpProvider } from './providers/surepass-irp.provider';
import { NicDirectProvider } from './providers/nic-direct.provider';
import { IrpProviderAdapter } from './providers/irp-provider.interface';
import { EinvoicePayloadBuilder } from './einvoice-payload.builder';
import { decryptSmtpPassword } from '../../../../common/utils/crypto-utils';
import { PostHogService } from '../../../../common/posthog/posthog.service';

@Injectable()
export class EInvoiceService {
  private readonly logger = new Logger(EInvoiceService.name);
  // Platform-bar observability: shared finance tracer (mirrors SaleInvoiceService).
  // OTel spans on every write; PostHog product-analytics events on successful IRP writes.
  // distinct-id = the authenticated userId, threaded from the controllers (mirrors
  // sale-invoice.controller). userId is optional: background callers (BullMQ retry processor,
  // internal batchGenerate loop) have no actor, so the capture is guarded and simply skipped.
  // Never emit raw GSTIN/PAN/IRN values - only ids + presence booleans. See CLAUDE.md > PostHog.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(SaleInvoice.name) private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(CreditNote.name) private readonly creditNoteModel: Model<CreditNote>,
    @InjectQueue('einvoice-retry') private readonly retryQueue: Queue,
    private readonly config: ConfigService,
    private readonly saleInvoiceService: SaleInvoiceService,
    private readonly firmsService: FirmsService,
    private readonly surepassIrpProvider: SurepassIrpProvider,
    private readonly nicDirectProvider: NicDirectProvider,
    private readonly payloadBuilder: EinvoicePayloadBuilder,
    // @Global PostHogService - no module import needed. Fire-and-forget analytics only.
    private readonly postHog: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // Provider factory — T-12-W2-05: no client-controlled provider selection
  // ---------------------------------------------------------------------------

  /**
   * Returns the correct IRP provider based on firm.irpConfig.mode.
   * Default = SurepassIrpProvider (gsp_surepass).
   * NIC Direct = NicDirectProvider (nic_direct — BYOK opt-in).
   *
   * SECURITY: firm.irpConfig.mode is from DB, not from client request.
   */
  private resolveIrpProvider(firm: any): IrpProviderAdapter {
    if (firm.irpConfig?.mode === 'nic_direct') {
      return this.nicDirectProvider;
    }
    return this.surepassIrpProvider; // default = gsp_surepass
  }

  /**
   * Decrypts firm.irpConfig.gspKey (BYOK) from AES-256 cipher-text.
   * Returns null when blank — caller falls back to platform SUREPASS_EINVOICE_KEY.
   * Decryption errors → null (treat as platform-default; log warning with REDACTED firm).
   *
   * SECURITY: returned plain key is never logged, stored, or returned in API responses.
   */
  // async by contract (part of the async provider-key resolution path) though the body is
  // synchronous; the require-await rule does not apply to this intentional shape.
  // eslint-disable-next-line @typescript-eslint/require-await
  private async resolveDecryptedFirmKey(firm: any): Promise<string | null> {
    const cipherText = firm.irpConfig?.gspKey;
    if (!cipherText) return null;
    try {
      return decryptSmtpPassword(cipherText);
    } catch {
      this.logger.warn(
        `Failed to decrypt irpConfig.gspKey for firm [**REDACTED**] — using platform key`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Session management passthroughs (public API for Wave 3 controllers)
  // ---------------------------------------------------------------------------

  /**
   * Initiates or checks IRP session for the given firm.
   *
   * For SurePass mode: always returns { sessionReady: true } (no OTP needed).
   * For NIC Direct mode: delegates to NicDirectProvider.prepareSession().
   *
   * Used by Wave 3 EInvoiceController: POST /einvoice/prepare-session
   */
  async prepareSession(
    wsId: string,
    firmId: string,
  ): Promise<
    | { sessionReady: true }
    | { needsOtp: true; sessionId: string; mobileLast4?: string }
    | { locked: true; minutesRemaining: number }
  > {
    const firm = await this.firmsService.findOne(wsId, firmId);

    if (firm.irpConfig?.mode !== 'nic_direct') {
      // SurePass GSP — no in-app OTP required
      return { sessionReady: true };
    }

    if (!firm.irpConfig?.username || !firm.irpConfig?.encryptedPassword) {
      throw new BadRequestException(
        'NIC Direct IRP credentials not configured for this firm — set username and password in firm settings',
      );
    }

    return this.nicDirectProvider.prepareSession(firmId, {
      username: firm.irpConfig.username,
      encryptedPassword: firm.irpConfig.encryptedPassword,
      gstin: (firm as any).gstin ?? '',
    });
  }

  /**
   * Completes NIC Direct session by submitting the user-entered OTP.
   * Only valid when mode = nic_direct; returns error for SurePass mode.
   *
   * Used by Wave 3 EInvoiceController: POST /einvoice/complete-session
   */
  async completeSession(
    wsId: string,
    firmId: string,
    sessionId: string,
    otp: string,
  ): Promise<
    | { sessionReady: true }
    | { otpFailed: true; attemptsLeft: number }
    | { locked: true; minutesRemaining: number }
  > {
    const firm = await this.firmsService.findOne(wsId, firmId);

    if (firm.irpConfig?.mode !== 'nic_direct') {
      throw new BadRequestException('completeSession is only applicable for NIC Direct mode firms');
    }

    return this.nicDirectProvider.completeSession(firmId, sessionId, otp);
  }

  // ---------------------------------------------------------------------------
  // Invoice operations
  // ---------------------------------------------------------------------------

  /**
   * Thin wrapper around SaleInvoiceService.findOne — used by EInvoiceRetryProcessor
   * to check eInvoice.status before retrying, avoiding duplicate IRN submissions.
   */
  async findOneInvoice(wsId: string, firmId: string, invoiceId: string) {
    return this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
  }

  /**
   * Shared IRN eligibility guards (AATO + 30-day), applied to both invoices and credit notes.
   * firm.aato is in Crores; e-Invoice is mandatory above 5 Cr. IRP rejects documents older
   * than 30 days. Throws before any DB mutation.
   */
  private assertIrnEligible(voucher: any, firm: any): void {
    if (firm.aato <= 5) {
      throw new BadRequestException('e-Invoice not applicable for AATO ≤ ₹5 Cr');
    }
    const ageDays = (Date.now() - new Date(voucher.voucherDate).getTime()) / 86_400_000;
    if (ageDays > 30) {
      throw new BadRequestException(
        'Cannot generate e-Invoice: document date is more than 30 days old. IRP rejects documents older than 30 days.',
      );
    }
  }

  /**
   * Shared IRP call: resolves the provider (+ decrypted BYOK key), builds the payload (the
   * builder maps voucherType=credit_note -> CRN + PrecDocDtls) and submits. Returns the raw IRN
   * response; the caller persists it on its own voucher (invoice or credit note).
   */
  private async callIrp(voucher: any, firm: any) {
    const provider = this.resolveIrpProvider(firm);
    let firmGspKey: string | null = null;
    if (provider instanceof SurepassIrpProvider) {
      firmGspKey = await this.resolveDecryptedFirmKey(firm);
    }
    const party = voucher.partySnapshot ?? {};
    const irpPayload = this.payloadBuilder.build(voucher, firm, party);
    return provider instanceof SurepassIrpProvider
      ? provider.generateIrn(irpPayload, firm.gstin ?? '', firmGspKey)
      : provider.generateIrn(irpPayload, firm.gstin ?? '');
  }

  /**
   * Generates IRN for a posted sale invoice.
   *
   * Enforces D-05: 30-day reporting rule for AATO > ₹10 Cr (effective Apr 2026).
   * Routes IRP call through adapter (SurePass GSP or NIC Direct per irpConfig.mode).
   * Uses EinvoicePayloadBuilder to construct full IRP v2.0 payload (Wave 3).
   * Idempotent: if eInvoice.status === 'generated' returns existing IRN.
   * On failure: queues BullMQ retry (attempts:3, exponential backoff).
   */
  async generateIrn(
    wsId: string,
    firmId: string,
    invoiceId: string,
    userId?: string,
  ): Promise<{ irn: string; ackNo: string; ackDate: Date; signedQrCode: string }> {
    return withFinanceSpan(
      this.tracer,
      'finance.generateIrn',
      { workspaceId: wsId, firmId, invoiceId },
      async () => {
        const invoice = await this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
        const firm = await this.firmsService.findOne(wsId, firmId);

        // Idempotent — skip if already generated
        if ((invoice as any).eInvoice?.status === 'generated') {
          const ei = (invoice as any).eInvoice;
          return {
            irn: ei.irn,
            ackNo: ei.ackNo,
            ackDate: ei.ackDate,
            signedQrCode: ei.signedQrCode,
          };
        }

        // WR-02: AATO + 30-day eligibility guards (shared with credit notes) — throw before any
        // DB mutation. e-Invoice is mandatory for AATO > 5 Cr; IRP rejects docs older than 30 days.
        this.assertIrnEligible(invoice, firm);

        try {
          const irnResponse = await this.callIrp(invoice, firm);

          // Persist IRN on invoice (T-F02-04-07: attempts incremented for repudiation audit)
          (invoice as any).eInvoice = {
            status: 'generated',
            irn: irnResponse.irn,
            ackNo: irnResponse.ackNo,
            ackDate: new Date(irnResponse.ackDate),
            signedQrCode: irnResponse.signedQrCode,
            signedInvoice: irnResponse.signedInvoice,
            lastError: undefined,
            attempts: ((invoice as any).eInvoice?.attempts ?? 0) + 1,
          };
          await invoice.save();

          // Fire-and-forget product analytics. Skipped for background callers (no userId).
          if (userId) {
            this.postHog.capture({
              distinctId: userId,
              event: 'sales.generated_irn',
              properties: {
                workspaceId: wsId,
                firmId,
                invoiceId,
                hasIrn: !!irnResponse.irn,
                hasQr: !!irnResponse.signedQrCode,
              },
            });
          }

          return {
            irn: irnResponse.irn,
            ackNo: irnResponse.ackNo,
            ackDate: new Date(irnResponse.ackDate),
            signedQrCode: irnResponse.signedQrCode,
          };
        } catch (err: any) {
          // Record failure + attempts (T-F02-04-07)
          (invoice as any).eInvoice = {
            ...(invoice as any).eInvoice,
            status: 'failed',
            // SECURITY: only log err.message — never echo axios response.data (may contain tokens)
            lastError: err.message,
            attempts: ((invoice as any).eInvoice?.attempts ?? 0) + 1,
          };
          await invoice.save();

          // Queue retry — attempts:3, exponential backoff ~1m→5m→30m
          await this.retryQueue.add(
            'retry',
            { invoiceId, firmId, wsId },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 60_000 },
            },
          );

          throw err;
        }
      },
    );
  }

  /**
   * Generates IRN for a posted credit note (CRN). Credit notes are e-invoice documents for
   * e-invoice-eligible firms; the payload builder maps voucherType=credit_note -> CRN with
   * PrecDocDtls (the original invoice). Mirrors generateIrn but loads/persists a CreditNote and
   * does NOT enqueue the invoice retry queue (retry is manual). Cross-link: CreditNote.eInvoice.
   */
  async generateIrnForCreditNote(
    wsId: string,
    firmId: string,
    creditNoteId: string,
    userId?: string,
  ): Promise<{ irn: string; ackNo: string; ackDate: Date; signedQrCode: string }> {
    return withFinanceSpan(
      this.tracer,
      'finance.generateIrnForCreditNote',
      { workspaceId: wsId, firmId, creditNoteId },
      async () => {
        const cn = await this.creditNoteModel.findOne({
          _id: creditNoteId,
          workspaceId: wsId,
          firmId,
          isDeleted: { $ne: true },
        });
        if (!cn) throw new BadRequestException('Credit note not found');
        if ((cn as any).state !== 'posted') {
          throw new BadRequestException(
            'e-Invoice can only be generated for a posted credit note.',
          );
        }

        const firm = await this.firmsService.findOne(wsId, firmId);

        // Idempotent — skip if already generated
        if ((cn as any).eInvoice?.status === 'generated') {
          const ei = (cn as any).eInvoice;
          return {
            irn: ei.irn,
            ackNo: ei.ackNo,
            ackDate: ei.ackDate,
            signedQrCode: ei.signedQrCode,
          };
        }

        this.assertIrnEligible(cn, firm);

        try {
          const irnResponse = await this.callIrp(cn, firm);
          (cn as any).eInvoice = {
            status: 'generated',
            irn: irnResponse.irn,
            ackNo: irnResponse.ackNo,
            ackDate: new Date(irnResponse.ackDate),
            signedQrCode: irnResponse.signedQrCode,
            signedInvoice: irnResponse.signedInvoice,
            lastError: undefined,
            attempts: ((cn as any).eInvoice?.attempts ?? 0) + 1,
          };
          await cn.save();

          // Fire-and-forget product analytics. Skipped for background callers (no userId).
          if (userId) {
            this.postHog.capture({
              distinctId: userId,
              event: 'sales.generated_credit_note_irn',
              properties: {
                workspaceId: wsId,
                firmId,
                creditNoteId,
                hasIrn: !!irnResponse.irn,
                hasQr: !!irnResponse.signedQrCode,
              },
            });
          }

          return {
            irn: irnResponse.irn,
            ackNo: irnResponse.ackNo,
            ackDate: new Date(irnResponse.ackDate),
            signedQrCode: irnResponse.signedQrCode,
          };
        } catch (err: any) {
          (cn as any).eInvoice = {
            ...(cn as any).eInvoice,
            status: 'failed',
            lastError: err.message,
            attempts: ((cn as any).eInvoice?.attempts ?? 0) + 1,
          };
          await cn.save();
          throw err;
        }
      },
    );
  }

  /**
   * Returns the credit note's signed QR as a base64 PNG data URL (mirrors getEInvoiceQr).
   */
  async getCreditNoteQr(
    wsId: string,
    firmId: string,
    creditNoteId: string,
  ): Promise<{ qrDataUrl: string; irn: string; ackNo: string }> {
    const cn = await this.creditNoteModel
      .findOne({ _id: creditNoteId, workspaceId: wsId, firmId, isDeleted: { $ne: true } })
      .lean();
    const ei = (cn as any)?.eInvoice;
    if (!ei || ei.status !== 'generated' || !ei.signedQrCode || !ei.irn) {
      throw new BadRequestException('No generated e-Invoice found for this credit note.');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require('qrcode');
    const qrDataUrl: string = await QRCode.toDataURL(ei.signedQrCode, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 256,
    });
    return { qrDataUrl, irn: ei.irn as string, ackNo: ei.ackNo as string };
  }

  /**
   * Cancels an IRN within the 24-hour cancellation window.
   *
   * T-12-W3-03: service-side UTC ms compare — client cannot bypass.
   * Deadline: (Date.now() - ackDate.getTime()) < 24 * 3600 * 1000  (per RESEARCH Pitfall 3)
   * Reason codes: 1=Duplicate, 2=Data Entry Mistake, 3=Order Cancelled, 4=Others
   */
  async cancelIrn(
    wsId: string,
    firmId: string,
    invoiceId: string,
    reason: number,
    remarks: string,
    userId?: string,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelIrn',
      { workspaceId: wsId, firmId, invoiceId },
      async () => {
        const invoice = await this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
        const firm = await this.firmsService.findOne(wsId, firmId);

        const ei = (invoice as any).eInvoice;

        // Validate status
        if (!ei || ei.status !== 'generated' || !ei.irn) {
          throw new BadRequestException(
            'Cannot cancel: invoice does not have a generated IRN. Only invoices with status="generated" can be cancelled.',
          );
        }

        // Validate cancel reason
        if (![1, 2, 3, 4].includes(reason)) {
          throw new BadRequestException(
            `Invalid cancel reason ${reason}. Must be 1 (Duplicate), 2 (Data Entry Mistake), 3 (Order Cancelled), or 4 (Others).`,
          );
        }

        // T-12-W3-03: 24-hour cancellation window (UTC ms compare — per RESEARCH Pitfall 3)
        const ackDate: Date = ei.ackDate instanceof Date ? ei.ackDate : new Date(ei.ackDate);
        const elapsedMs = Date.now() - ackDate.getTime();
        if (elapsedMs >= 24 * 3600 * 1000) {
          throw new BadRequestException(
            'IRN_CANCEL_WINDOW_EXPIRED: The 24-hour cancellation window has passed. ' +
              `IRN was acknowledged at ${ackDate.toISOString()}. Cancellation is only allowed within 24 hours of acknowledgement.`,
          );
        }

        // Resolve provider + dispatch (shared with the credit-note cancel path).
        await this.callIrpCancel(firm, ei.irn, reason, remarks);

        // Update invoice e-Invoice status
        (invoice as any).eInvoice = {
          ...ei,
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason,
        };
        await invoice.save();

        // Fire-and-forget product analytics. Skipped for background callers (no userId).
        if (userId) {
          this.postHog.capture({
            distinctId: userId,
            event: 'sales.cancelled_irn',
            properties: { workspaceId: wsId, firmId, invoiceId, cancelReason: reason },
          });
        }
      },
    );
  }

  /**
   * Shared IRP cancel dispatch (provider-aware), used by both invoice and credit-note cancel.
   * SurePass passes the decrypted BYOK key directly; NIC Direct uses its session-aware path.
   */
  private async callIrpCancel(
    firm: any,
    irn: string,
    reason: number,
    remarks: string,
  ): Promise<void> {
    const provider = this.resolveIrpProvider(firm);
    if (provider instanceof SurepassIrpProvider) {
      // CR-01: pass decrypted key directly — no mutable instance state
      const firmGspKey = await this.resolveDecryptedFirmKey(firm);
      await provider.cancelIrn(irn, reason, remarks, firmGspKey);
    } else if (provider instanceof NicDirectProvider) {
      // CR-03: NIC Direct requires session-aware dispatch (cannot use generic cancelIrn stub)
      await provider.cancelIrnWithSession(firm.gstin ?? '', irn, reason, remarks);
    } else {
      await provider.cancelIrn(irn, reason, remarks);
    }
  }

  /**
   * Cancels a credit note's IRN within the 24-hour window (mirrors invoice cancelIrn). Credit
   * notes are supplier-issued CRN e-invoice documents, so cancellation is valid. Reason codes
   * 1-4 (1=Duplicate, 2=Data Entry Mistake, 3=Order Cancelled, 4=Others).
   * Cross-link: CreditNote.eInvoice; payload/cancel shared with the invoice path.
   */
  async cancelIrnForCreditNote(
    wsId: string,
    firmId: string,
    creditNoteId: string,
    reason: number,
    remarks: string,
    userId?: string,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelIrnForCreditNote',
      { workspaceId: wsId, firmId, creditNoteId },
      async () => {
        const cn = await this.creditNoteModel.findOne({
          _id: creditNoteId,
          workspaceId: wsId,
          firmId,
          isDeleted: { $ne: true },
        });
        if (!cn) throw new BadRequestException('Credit note not found');
        const firm = await this.firmsService.findOne(wsId, firmId);

        const ei = (cn as any).eInvoice;
        if (!ei || ei.status !== 'generated' || !ei.irn) {
          throw new BadRequestException(
            'Cannot cancel: credit note does not have a generated IRN. Only status="generated" can be cancelled.',
          );
        }
        if (![1, 2, 3, 4].includes(reason)) {
          throw new BadRequestException(
            `Invalid cancel reason ${reason}. Must be 1 (Duplicate), 2 (Data Entry Mistake), 3 (Order Cancelled), or 4 (Others).`,
          );
        }

        const ackDate: Date = ei.ackDate instanceof Date ? ei.ackDate : new Date(ei.ackDate);
        if (Date.now() - ackDate.getTime() >= 24 * 3600 * 1000) {
          throw new BadRequestException(
            'IRN_CANCEL_WINDOW_EXPIRED: The 24-hour cancellation window has passed. ' +
              `IRN was acknowledged at ${ackDate.toISOString()}.`,
          );
        }

        await this.callIrpCancel(firm, ei.irn, reason, remarks);

        (cn as any).eInvoice = {
          ...ei,
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason,
        };
        await cn.save();

        // Fire-and-forget product analytics. Skipped for background callers (no userId).
        if (userId) {
          this.postHog.capture({
            distinctId: userId,
            event: 'sales.cancelled_credit_note_irn',
            properties: { workspaceId: wsId, firmId, creditNoteId, cancelReason: reason },
          });
        }
      },
    );
  }

  /**
   * Batch-generates IRNs for up to 500 invoices.
   *
   * Per RESEARCH A3 — IRP supports single-invoice generation (no native batch API).
   * This method processes the first 100 synchronously and enqueues the remainder
   * in the BullMQ einvoice-retry queue (T-12-W3-05: batch flooding mitigation).
   *
   * Returns counts: { processed: number; queued: number }
   */
  async batchGenerate(
    wsId: string,
    firmId: string,
    invoiceIds: string[],
  ): Promise<{ processed: number; queued: number }> {
    const syncBatch = invoiceIds.slice(0, 100);
    const remainder = invoiceIds.slice(100);

    let processed = 0;
    for (const invoiceId of syncBatch) {
      try {
        await this.generateIrn(wsId, firmId, invoiceId);
        processed++;
      } catch (err: any) {
        // Individual failures are already queued for retry inside generateIrn
        this.logger.warn(`batchGenerate: failed for invoice ${invoiceId}: ${err.message}`);
      }
    }

    // Enqueue remainder to einvoice-retry BullMQ queue
    let queued = 0;
    for (const invoiceId of remainder) {
      await this.retryQueue.add(
        'retry',
        { invoiceId, firmId, wsId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );
      queued++;
    }

    this.logger.log(`batchGenerate: processed=${processed}, queued=${queued} for firm ${firmId}`);
    return { processed, queued };
  }

  /**
   * Lists invoices pending e-Invoice generation.
   *
   * Applicable when firm.aato > 5 (Crores) — mandatory e-Invoice threshold.
   * Returns invoices where eInvoice.status is NOT in ['generated', 'cancelled', 'not_applicable'].
   */
  async listPending(wsId: string, firmId: string): Promise<SaleInvoice[]> {
    return (await this.invoiceModel
      .find({
        workspaceId: wsId,
        firmId,
        state: 'posted',
        'eInvoice.status': { $nin: ['generated', 'cancelled', 'not_applicable'] },
      })
      .sort({ voucherDate: -1 })
      .lean()
      .exec()) as any;
  }

  /**
   * Lists invoices filtered by eInvoice.status with pagination.
   *
   * Used by web UI tabs: Generated / Cancelled / Retry Queue (failed).
   * Status options: 'pending' | 'generated' | 'cancelled' | 'failed'
   * 'retry' maps to status='failed' with attempts > 0 (retry queue).
   *
   * @param status  eInvoice.status filter (or 'retry' for failed+attempts>0)
   * @param page    0-based page index (default 0)
   * @param size    Page size (default 50)
   */
  async listByStatus(
    wsId: string,
    firmId: string,
    status: 'pending' | 'generated' | 'cancelled' | 'failed' | 'retry',
    page = 0,
    size = 50,
  ): Promise<{ items: SaleInvoice[]; total: number }> {
    let filter: Record<string, any>;

    if (status === 'retry') {
      // Retry queue = failed attempts where attempts > 0
      filter = {
        workspaceId: wsId,
        firmId,
        state: 'posted',
        'eInvoice.status': 'failed',
        'eInvoice.attempts': { $gt: 0 },
      };
    } else if (status === 'pending') {
      // Pending = status not in generated/cancelled/not_applicable (mirrors listPending)
      filter = {
        workspaceId: wsId,
        firmId,
        state: 'posted',
        'eInvoice.status': { $nin: ['generated', 'cancelled', 'not_applicable'] },
      };
    } else {
      filter = {
        workspaceId: wsId,
        firmId,
        state: 'posted',
        'eInvoice.status': status,
      };
    }

    const [items, total] = await Promise.all([
      this.invoiceModel
        .find(filter)
        .sort({ voucherDate: -1 })
        .skip(page * size)
        .limit(size)
        .lean()
        .exec() as any,
      this.invoiceModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * Returns the signedQrCode for a generated invoice, rendered as a
   * base64 data URL PNG via the qrcode package.
   *
   * Used by the web QrPreviewModal to display the IRN QR image.
   */
  async getEInvoiceQr(
    wsId: string,
    firmId: string,
    invoiceId: string,
  ): Promise<{ qrDataUrl: string; irn: string; ackNo: string }> {
    const invoice = await this.saleInvoiceService.findOne(wsId, firmId, invoiceId);
    const ei = (invoice as any).eInvoice;

    if (!ei || ei.status !== 'generated' || !ei.signedQrCode || !ei.irn) {
      throw new BadRequestException(
        'No generated e-Invoice found for this invoice. IRN must be generated before QR can be previewed.',
      );
    }

    // Import qrcode dynamically to avoid top-level await issues; render as PNG data URL
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require('qrcode');
    const qrDataUrl: string = await QRCode.toDataURL(ei.signedQrCode, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 256,
    });

    return {
      qrDataUrl,
      irn: ei.irn as string,
      ackNo: ei.ackNo as string,
    };
  }
}
