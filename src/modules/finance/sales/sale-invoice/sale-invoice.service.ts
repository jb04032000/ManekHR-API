import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as Sentry from '@sentry/node';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { SaleInvoice } from './sale-invoice.schema';
import { AuditService } from '../../../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { SmartDefaultsService } from '../../smart-defaults/smart-defaults.service';
import { withFinanceSpan } from '../../common/finance-observability';
import { SampleVoucherDocument } from '../../inventory/samples/sample-voucher.schema';
import { TaxComputationService } from '../tax-computation/tax-computation.service';
import { LedgerPostingService } from '../ledger-posting/ledger-posting.service';
import { PartySalesAggregateService } from '../party-sales-aggregate/party-sales-aggregate.service';
import { InventoryService } from '../inventory/inventory.service';
import { IdempotencyService } from '../common/idempotency.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { FirmsService } from '../../firms/firms.service';
import { isCompositionFirm, resolveSellerGstin } from '../../firms/firm-compliance';
import { assertRcmBosExclusive } from './sale-invoice.rules';
import { PartiesService } from '../../parties/parties.service';
import { amountInWords } from '../common/amount-in-words.util';
import { ratePaiseFromCentiPaise } from '../../common/precision';
import { resolveStateCode } from '../../common/gst-state-codes';
import { CreateSaleInvoiceDto } from './dto/create-sale-invoice.dto';
import { UpdateSaleInvoiceDto } from './dto/update-sale-invoice.dto';
import { MailService } from '../../../mail/mail.service';
import { PrintService } from '../print/print.service';
import { FyLockService } from '../../fiscal-year/fy-lock.service';

@Injectable()
export class SaleInvoiceService {
  private readonly logger = new Logger(SaleInvoiceService.name);
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(SaleInvoice.name)
    private readonly model: Model<SaleInvoice>,
    private readonly tax: TaxComputationService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly partyAggregate: PartySalesAggregateService,
    private readonly inventory: InventoryService,
    private readonly idempotencyService: IdempotencyService,
    private readonly voucherSeries: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly partiesService: PartiesService,
    private readonly mailService: MailService,
    private readonly printService: PrintService,
    private readonly fyLock: FyLockService,
    // Phase 17 / FIN-16-03 — party.timeline emit (D-17 non-blocking).
    private readonly events: EventEmitter2,
    // Phase 0 platform-bar: central audit stream + product analytics on the
    // key billing writes (alongside the embedded auditLog[] trail, which feeds
    // the invoice's own audit-trail UI and is NOT removed).
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
    // Phase 1b: per-party "Field Prediction" memory, written best-effort on post.
    private readonly smartDefaults: SmartDefaultsService,
  ) {}

  /**
   * Fire-and-forget central-audit helper for finance billing writes. Mirrors
   * `TeamService.auditTeamEvent`: a failure here must NEVER break the caller's
   * primary voucher write, so we swallow + Sentry-tag for follow-up. Records to
   * the central `AuditService` under `AppModule.FINANCE` (the embedded
   * `auditLog[]` array on the document is written separately by each method).
   *
   * PII rule: `meta` carries ids / amounts / voucher numbers only, never raw
   * GSTIN / PAN / bank.
   */
  private auditFinanceEvent(input: {
    action: string;
    workspaceId: string;
    firmId: string;
    actorId: string;
    entityId: string;
    meta?: Record<string, unknown>;
  }): void {
    void this.auditService
      .logEvent({
        workspaceId: input.workspaceId,
        module: AppModuleEnum.FINANCE,
        entityType: 'sale_invoice',
        entityId: input.entityId,
        action: input.action,
        actorId: input.actorId,
        meta: { firmId: input.firmId, ...input.meta },
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Central audit failed for ${input.action} (firm ${input.firmId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'finance', op: `audit.${input.action}` },
          extra: { workspaceId: input.workspaceId, firmId: input.firmId },
        });
      });
  }

  // ─── list ──────────────────────────────────────────────────────────────────

  async list(
    wsId: string,
    firmId: string,
    filters: {
      state?: string;
      partyId?: string;
      paymentStatus?: string;
      postingStatus?: string; // R10: filter the quarantine bucket (needs_attention)
      dateFrom?: string;
      dateTo?: string;
      q?: string;
      skip?: number;
      limit?: number;
    } = {},
  ): Promise<{ data: SaleInvoice[]; total: number }> {
    const filter: any = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };

    if (filters.state) filter.state = filters.state;
    if (filters.partyId) filter.partyId = new Types.ObjectId(filters.partyId);
    if (filters.paymentStatus) filter.paymentStatus = filters.paymentStatus;
    // R10: surface the quarantine bucket. 'needs_attention' returns failed-post drafts;
    // 'clean' returns everything not flagged.
    if (filters.postingStatus === 'needs_attention') filter.postingStatus = 'needs_attention';
    else if (filters.postingStatus === 'clean') filter.postingStatus = { $exists: false };
    if (filters.dateFrom || filters.dateTo) {
      filter.voucherDate = {};
      if (filters.dateFrom) filter.voucherDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) filter.voucherDate.$lte = new Date(filters.dateTo);
    }
    if (filters.q) {
      // WR-05: Escape regex metacharacters to prevent ReDoS via user-controlled input
      const escapedQ = filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { voucherNumber: { $regex: `^${escapedQ}`, $options: 'i' } },
        { 'partySnapshot.name': { $regex: escapedQ, $options: 'i' } },
      ];
    }

    const skip = filters.skip ?? 0;
    const limit = filters.limit ?? 20;

    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { data, total };
  }

  // ─── findOne ───────────────────────────────────────────────────────────────

  async findOne(wsId: string, firmId: string, id: string): Promise<SaleInvoice> {
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException('SaleInvoice not found');
    return doc;
  }

  // ─── findByPaymentLinkId ───────────────────────────────────────────────────
  // Workspace-scoped (NO firmId param) — required by F-02-05 RazorpayWebhookController per D-10.
  // Firm is derived AFTER lookup using invoice.firmId.

  async findByPaymentLinkId(wsId: string, paymentLinkId: string): Promise<SaleInvoice | null> {
    return this.model.findOne({
      workspaceId: new Types.ObjectId(wsId),
      razorpayPaymentLinkId: paymentLinkId,
      isDeleted: false,
    });
  }

  // ─── createDraft ──────────────────────────────────────────────────────────

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreateSaleInvoiceDto,
    userId: string,
    idempotencyKey?: string,
  ): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.createInvoiceDraft',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // F-15 Plan 03: FY-lock guard (D-16, D-44) — refuse posting in CLOSED FY.
        await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate));

        // Capture party snapshot
        const party = await this.partiesService.findOne(wsId, firmId, dto.partyId);

        // 2d: a composition firm cannot collect GST, so its sales are Bills of Supply
        // by default. A regular firm may still flag a wholly-exempt supply as one.
        const firm = await this.firmsService.findOne(wsId, firmId);
        const isBillOfSupply = dto.isBillOfSupply ?? isCompositionFirm(firm);
        const isReverseCharge = dto.isReverseCharge ?? false;
        // SAL-2: reverse charge and Bill of Supply are mutually exclusive.
        assertRcmBosExclusive(isReverseCharge, isBillOfSupply);
        // 2f: resolve the seller GSTIN (honours a requested additional registration,
        // else the firm's primary gstin).
        const sellerGstin = resolveSellerGstin(firm, dto.sellerGstin);

        const invoice = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          voucherType: 'sale_invoice',
          voucherDate: new Date(dto.voucherDate),
          state: 'draft',
          partyId: new Types.ObjectId(dto.partyId),
          partySnapshot: {
            name: party.name,
            gstin: party.gstin,
            state: party.state,
            address: party.address,
            pan: party.pan,
            // R3: capture the party's print locale so the print page / live preview
            // can seed the print language without re-fetching the party record.
            preferredLocale: (party as { preferredLocale?: 'en' | 'gu' | 'hi' }).preferredLocale,
          },
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          sellerGstin,
          isReverseCharge,
          isBillOfSupply,
          paymentTerms: dto.paymentTerms,
          lineItems: (dto.lineItems ?? []).map((l) => ({
            ...l,
            // A Bill of Supply carries no GST: force every line to 0% so the tax
            // engine produces a zero-tax document.
            taxRate: isBillOfSupply ? 0 : l.taxRate,
            rateCentiPaise: l.rateCentiPaise,
            ratePaise:
              l.rateCentiPaise != null ? ratePaiseFromCentiPaise(l.rateCentiPaise) : l.ratePaise,
          })),
          additionalCharges: dto.additionalCharges ?? [],
          notes: dto.notes,
          internalNotes: dto.internalNotes,
          shipping: dto.shipping,
          lateFeeSchedule: dto.lateFeeSchedule,
          // D13 dalali/broker -> feeds the Broker Commission Register (R-25).
          brokerPartyId: dto.brokerPartyId ? new Types.ObjectId(dto.brokerPartyId) : undefined,
          brokerCommissionPct: dto.brokerCommissionPct,
          idempotencyKey,
          draftCreatedAt: new Date(),
          auditLog: [
            {
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'created',
            },
          ],
        });

        const saved = await invoice.save();
        // Fire-and-forget product analytics on the successful draft write (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_drafted',
          properties: { workspaceId: wsId, firmId, invoiceId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  // ─── updateDraft ──────────────────────────────────────────────────────────

  async updateDraft(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateSaleInvoiceDto,
    userId: string,
  ): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateInvoiceDraft',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'draft') {
          throw new BadRequestException('Only draft invoices can be updated');
        }

        // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate.
        // R4: thread the optional amendment reason through so an authorized editor can amend a
        // draft dated in the soft books-lock window (audited via FyLockService) instead of needing
        // the whole period unlocked. No reason -> normal lock behaviour (rejects locked dates).
        const lockOpts = dto.amendmentReason?.trim()
          ? { amendment: { reason: dto.amendmentReason.trim(), actorId: userId } }
          : undefined;
        await this.fyLock.assertOpen(wsId, firmId, invoice.voucherDate, lockOpts);
        if (dto.voucherDate) {
          await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate), lockOpts);
        }

        // Update party snapshot if partyId changed
        if (dto.partyId) {
          const party = await this.partiesService.findOne(wsId, firmId, dto.partyId);
          invoice.partyId = new Types.ObjectId(dto.partyId);
          invoice.partySnapshot = {
            name: party.name,
            gstin: party.gstin,
            state: party.state,
            address: party.address,
            pan: party.pan,
            // R3: keep the captured print locale in sync when the party changes.
            preferredLocale: (party as { preferredLocale?: 'en' | 'gu' | 'hi' }).preferredLocale,
          };
        }

        // SAL-2: guard the RESULTING flag combination (existing merged with the patch)
        // so a partial update can't leave the draft both reverse-charge and BoS.
        assertRcmBosExclusive(
          dto.isReverseCharge ?? invoice.isReverseCharge ?? false,
          dto.isBillOfSupply ?? invoice.isBillOfSupply ?? false,
        );

        Object.assign(invoice, {
          ...(dto.voucherDate && { voucherDate: new Date(dto.voucherDate) }),
          ...(dto.lineItems !== undefined && {
            lineItems: dto.lineItems.map((l) => ({
              ...l,
              rateCentiPaise: l.rateCentiPaise,
              ratePaise:
                l.rateCentiPaise != null ? ratePaiseFromCentiPaise(l.rateCentiPaise) : l.ratePaise,
            })),
          }),
          ...(dto.additionalCharges !== undefined && { additionalCharges: dto.additionalCharges }),
          ...(dto.placeOfSupplyStateCode && { placeOfSupplyStateCode: dto.placeOfSupplyStateCode }),
          ...(dto.isReverseCharge !== undefined && { isReverseCharge: dto.isReverseCharge }),
          ...(dto.isBillOfSupply !== undefined && { isBillOfSupply: dto.isBillOfSupply }),
          ...(dto.sellerGstin !== undefined && { sellerGstin: dto.sellerGstin }),
          ...(dto.paymentTerms !== undefined && { paymentTerms: dto.paymentTerms }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.internalNotes !== undefined && { internalNotes: dto.internalNotes }),
          ...(dto.shipping !== undefined && { shipping: dto.shipping }),
          ...(dto.lateFeeSchedule !== undefined && { lateFeeSchedule: dto.lateFeeSchedule }),
          // D13 dalali/broker (R-25).
          ...(dto.brokerPartyId !== undefined && {
            brokerPartyId: dto.brokerPartyId ? new Types.ObjectId(dto.brokerPartyId) : undefined,
          }),
          ...(dto.brokerCommissionPct !== undefined && {
            brokerCommissionPct: dto.brokerCommissionPct,
          }),
          draftUpdatedAt: new Date(),
        });

        invoice.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });

        return invoice.save();
      },
    );
  }

  // ─── postInvoice ──────────────────────────────────────────────────────────

  async postInvoice(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    idempotencyKey?: string,
  ): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.postInvoice',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // Step 0: Idempotency check + distributed lock (CR-02)
        if (idempotencyKey) {
          const cached = await this.idempotencyService.getCached<SaleInvoice>(
            `post-invoice:${firmId}`,
            idempotencyKey,
          );
          if (cached) return cached;

          // Atomic SET NX EX prevents two concurrent requests with the same key from
          // both passing the cache-miss check and double-posting the invoice.
          const locked = await this.idempotencyService.tryAcquireLock(
            `post-invoice:${firmId}`,
            idempotencyKey,
            120,
          );
          if (!locked) {
            throw new ConflictException(
              'A request with this idempotency key is already in progress',
            );
          }
        }

        // Step 1: Load + validate
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'draft') {
          throw new BadRequestException('Only drafts can be posted');
        }

        const firm = await this.firmsService.findOne(wsId, firmId);
        const fy = this.voucherSeries.getFYForDate(invoice.voucherDate, firm.fyStartMonth);

        // Step 2: FY backdating guard (D-20)
        if (firm.accountsBooksBeginDate && invoice.voucherDate < firm.accountsBooksBeginDate) {
          throw new BadRequestException(
            `Cannot post: ${invoice.voucherDate.toISOString().split('T')[0]} falls in a closed financial year`,
          );
        }

        // Step 3: Maker-checker routing (D-15)
        if (firm.makerCheckerEnabled?.sale_invoice) {
          invoice.state = 'pending_approval';
          invoice.auditLog.push({
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'submitted_for_approval',
          });
          await invoice.save();
          if (idempotencyKey) {
            await this.idempotencyService.store(
              `post-invoice:${firmId}`,
              idempotencyKey,
              invoice.toObject(),
            );
          }
          return invoice;
        }

        // Step 4: Run inside MongoDB transaction (D-13)
        const conn = this.model.db;
        const result = await conn
          .transaction(async (session) => {
            // 4a. Compute tax (first pass, without TCS)
            // 2f: derive the seller state from the invoice's seller GSTIN (the
            // supplying branch's registration), falling back to the firm primary.
            const effectiveSellerGstin = invoice.sellerGstin ?? firm.gstin;
            const firmStateCode = resolveStateCode(
              effectiveSellerGstin?.slice(0, 2) ?? (firm as any).state,
            );
            const partyStateCode = resolveStateCode(
              (invoice.partySnapshot as any)?.gstin?.slice(0, 2) ??
                (invoice.partySnapshot as any)?.state,
            );
            const placeOfSupplyStateCode =
              resolveStateCode(invoice.placeOfSupplyStateCode) || partyStateCode;

            // 2d: a Bill of Supply carries no GST. Force every line to 0% before
            // computing so the document is zero-tax even if a rate slipped through.
            if (invoice.isBillOfSupply) {
              (invoice.lineItems as any[]).forEach((l) => {
                l.taxRate = 0;
              });
            }

            const taxInput = {
              lines: invoice.lineItems,
              additionalCharges: invoice.additionalCharges,
              firmStateCode,
              partyStateCode,
              placeOfSupplyStateCode,
              roundingPolicy: (firm.roundingPolicy ?? 'half_up') as
                | 'half_up'
                | 'round_off_to_rupee',
            };

            const taxFirstPass = this.tax.compute(taxInput);

            // 4b. Update aggregate atomically, get BEFORE value for TCS threshold detection
            const { beforePaise } = await this.partyAggregate.upsertAndGet(
              wsId,
              firmId,
              invoice.partyId.toHexString(),
              fy,
              taxFirstPass.taxableValuePaise,
              { session },
            );

            // 4c. Compute TCS using BEFORE value (D-11 marginal-on-first-crossing)
            const tcsPaise = this.partyAggregate.computeTcs(
              taxFirstPass.taxableValuePaise,
              beforePaise,
              firm,
              invoice.voucherDate,
            );

            // 4d. Recompute tax with TCS (so round-off accounts for TCS)
            const taxFinal = this.tax.compute({ ...taxInput, tcsPaise });

            // 4e. Assign voucher number (orphan on rollback intentional/Tally-compatible per D-19)
            invoice.voucherNumber = await this.voucherSeries.generateNextNumber(
              firmId,
              'sale_invoice',
              fy,
            );

            // 4f. Snapshot all numeric fields
            invoice.subtotalPaise = taxFinal.subtotalPaise;
            invoice.totalDiscountPaise = taxFinal.totalDiscountPaise;
            invoice.taxableValuePaise = taxFinal.taxableValuePaise;
            invoice.cgstPaise = taxFinal.cgstPaise;
            invoice.sgstPaise = taxFinal.sgstPaise;
            invoice.igstPaise = taxFinal.igstPaise;
            invoice.cessPaise = taxFinal.cessPaise;
            invoice.tcsPaise = taxFinal.tcsPaise;
            invoice.roundOffPaise = taxFinal.roundOffPaise;
            invoice.grandTotalPaise = taxFinal.grandTotalPaise;
            invoice.amountDuePaise = taxFinal.grandTotalPaise;
            invoice.amountPaidPaise = 0;
            invoice.paymentStatus = 'unpaid';

            // Snapshot amountInWords
            invoice.amountInWords = amountInWords(taxFinal.grandTotalPaise);

            // Snapshot dueDate from paymentTerms
            if (invoice.paymentTerms?.termsDays) {
              const due = new Date(invoice.voucherDate);
              due.setDate(due.getDate() + invoice.paymentTerms.termsDays);
              invoice.dueDate = due;
            }

            // TCS applied snapshot
            if (tcsPaise > 0) {
              invoice.tcsApplied = {
                section: '206C(1H)',
                rate: 0.001,
                basePaise: taxFinal.taxableValuePaise,
                amountPaise: tcsPaise,
              };
            }

            // Late fee schedule default from firm.lateFeePct if not already set
            if (!invoice.lateFeeSchedule && firm.lateFeePct) {
              invoice.lateFeeSchedule = {
                type: 'percentage_per_day',
                value: firm.lateFeePct,
                gracePeriodDays: 0,
              };
            }

            // eInvoice initial state
            invoice.eInvoice = {
              status: firm.aato > 500 ? 'pending' : 'not_applicable',
              attempts: 0,
            };

            // 4g. Post ledger
            const isIntraState = firmStateCode === placeOfSupplyStateCode;
            await this.ledgerPosting.postSaleInvoice(taxFinal, {
              session,
              userId,
              firm: {
                _id: firm._id,
                workspaceId: new Types.ObjectId(wsId),
                gstin: firm.gstin,
              },
              party: {
                _id: invoice.partyId,
                name: (invoice.partySnapshot as any)?.name ?? '',
              },
              invoice: {
                _id: invoice._id,
                voucherNumber: invoice.voucherNumber,
                voucherType: invoice.voucherType,
                invoiceDate: invoice.voucherDate,
                financialYear: fy,
              },
              isIntraState,
            });

            // 4h. Inventory: release SO reservations if linked + stockOut
            const soLinkedItems = invoice.linkedDocs.filter((d) => d.voucherType === 'sale_order');
            if (soLinkedItems.length > 0) {
              await this.inventory.releaseReservation(wsId, firmId, invoice.lineItems, {
                session,
              });
            }
            await this.inventory.stockOut(wsId, firmId, invoice.lineItems, { session });

            // 4i. State transition + save
            invoice.state = 'posted';
            invoice.postingStatus = undefined; // D23: this post succeeded - clear any prior needs_attention
            invoice.postedAt = new Date();
            invoice.postedBy = new Types.ObjectId(userId);
            invoice.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'posted',
              after: {
                voucherNumber: invoice.voucherNumber,
                grandTotalPaise: taxFinal.grandTotalPaise,
              },
            });

            await invoice.save({ session });
            return invoice.toObject();
          })
          .catch(async (err) => {
            // D23: the post + ledger write failed and rolled back (invoice stays draft). Flag it
            // 'needs_attention' in a SEPARATE write - the transaction aborted, so this cannot be
            // inside it - so the failed post is visible in document lists for follow-up rather than
            // a vanished transient error. Re-throw so the caller still surfaces the failure.
            await this.model
              .updateOne({ _id: invoice._id }, { $set: { postingStatus: 'needs_attention' } })
              .catch(() => undefined);
            throw err;
          });

        // Step 5: Cache idempotency response
        if (idempotencyKey) {
          await this.idempotencyService.store(`post-invoice:${firmId}`, idempotencyKey, result);
        }

        // Step 6: Phase 17 / FIN-16-03 — emit party.timeline event AFTER commit
        // (D-17 non-blocking: try/catch so a timeline failure NEVER rolls back the
        // already-committed voucher write).
        try {
          this.events.emit('party.timeline', {
            type: 'invoice.created',
            workspaceId: wsId,
            firmId,
            partyId: result.partyId,
            refModel: 'SaleInvoice',
            refId: result._id,
            occurredAt: result.voucherDate ?? new Date(),
            actorUserId: userId,
            summary: `Invoice ${result.voucherNumber} for paise=${result.grandTotalPaise} created`,
            meta: {
              voucherNumber: result.voucherNumber,
              amountPaise: result.grandTotalPaise,
            },
          });
        } catch (err) {
          this.logger.warn(
            `party.timeline emit failed for invoice.created (id=${result._id}): ${(err as Error)?.message ?? String(err)}`,
          );
        }

        // Phase 0 platform-bar: product analytics + central audit on the posted
        // invoice. Ids / amounts only (no PII). Both are best-effort and never
        // block the already-committed voucher write.
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_posted',
          properties: {
            workspaceId: wsId,
            firmId,
            invoiceId: result._id?.toString(),
            voucherNumber: result.voucherNumber,
            grandTotalPaise: result.grandTotalPaise,
          },
        });
        this.auditFinanceEvent({
          action: 'finance.invoice_posted',
          workspaceId: wsId,
          firmId,
          actorId: userId,
          entityId: result._id?.toString() ?? id,
          meta: {
            voucherNumber: result.voucherNumber,
            grandTotalPaise: result.grandTotalPaise,
          },
        });

        // Phase 1b - Smart Defaults: remember this party's payment terms / place of
        // supply + per-item rate so the NEXT invoice for them pre-fills (frontend reads
        // via GET .../smart-defaults). Best-effort: rememberMany never throws, but guard
        // anyway - this must never block the already-committed post.
        try {
          const partyKey = result.partyId ? String(result.partyId) : '';
          if (partyKey) {
            const entries: {
              scope: 'party' | 'party_item' | 'vendor';
              key: string;
              field: string;
              valueNum?: number;
              valueStr?: string;
            }[] = [];
            const dueDays = (result.paymentTerms as { dueDays?: number } | undefined)?.dueDays;
            if (typeof dueDays === 'number') {
              entries.push({ scope: 'party', key: partyKey, field: 'dueDays', valueNum: dueDays });
            }
            if (result.placeOfSupplyStateCode) {
              entries.push({
                scope: 'party',
                key: partyKey,
                field: 'placeOfSupplyStateCode',
                valueStr: result.placeOfSupplyStateCode,
              });
            }
            for (const l of result.lineItems ?? []) {
              if (l?.itemId && typeof l.ratePaise === 'number') {
                entries.push({
                  scope: 'party_item',
                  key: `${partyKey}:${String(l.itemId)}`,
                  field: 'ratePaise',
                  valueNum: l.ratePaise,
                });
              }
            }
            if (entries.length) await this.smartDefaults.rememberMany(wsId, firmId, entries);
          }
        } catch (err) {
          this.logger.warn(
            `smart-defaults remember failed (invoice ${result._id}): ${(err as Error)?.message ?? String(err)}`,
          );
        }

        return result;
      },
    );
  }

  // ─── approve ──────────────────────────────────────────────────────────────

  async approve(wsId: string, firmId: string, id: string, userId: string): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.approveInvoice',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'pending_approval') {
          throw new BadRequestException('Only pending_approval invoices can be approved');
        }

        // WR-06: Maker-checker — approver must differ from the submitter
        const submittedEntry = invoice.auditLog.find((e) => e.action === 'submitted_for_approval');
        if (submittedEntry && submittedEntry.by.toString() === userId) {
          throw new ForbiddenException(
            'Maker-checker violation: the submitter cannot approve their own invoice',
          );
        }

        const firm = await this.firmsService.findOne(wsId, firmId);
        const fy = this.voucherSeries.getCurrentFY(firm.fyStartMonth);

        const conn = this.model.db;
        const result = await conn.transaction(async (session) => {
          const firmStateCode = firm.gstin?.slice(0, 2) ?? '';
          const placeOfSupplyStateCode = invoice.placeOfSupplyStateCode ?? '';
          const taxInput = {
            lines: invoice.lineItems,
            additionalCharges: invoice.additionalCharges,
            firmStateCode,
            partyStateCode: (invoice.partySnapshot as any)?.gstin?.slice(0, 2) ?? '',
            placeOfSupplyStateCode,
            roundingPolicy: (firm.roundingPolicy ?? 'half_up') as 'half_up' | 'round_off_to_rupee',
          };

          const taxFirstPass = this.tax.compute(taxInput);
          const { beforePaise } = await this.partyAggregate.upsertAndGet(
            wsId,
            firmId,
            invoice.partyId.toHexString(),
            fy,
            taxFirstPass.taxableValuePaise,
            { session },
          );
          const tcsPaise = this.partyAggregate.computeTcs(
            taxFirstPass.taxableValuePaise,
            beforePaise,
            firm,
            invoice.voucherDate,
          );
          const taxFinal = this.tax.compute({ ...taxInput, tcsPaise });

          invoice.voucherNumber = await this.voucherSeries.generateNextNumber(
            firmId,
            'sale_invoice',
            fy,
          );

          invoice.subtotalPaise = taxFinal.subtotalPaise;
          invoice.totalDiscountPaise = taxFinal.totalDiscountPaise;
          invoice.taxableValuePaise = taxFinal.taxableValuePaise;
          invoice.cgstPaise = taxFinal.cgstPaise;
          invoice.sgstPaise = taxFinal.sgstPaise;
          invoice.igstPaise = taxFinal.igstPaise;
          invoice.cessPaise = taxFinal.cessPaise;
          invoice.tcsPaise = taxFinal.tcsPaise;
          invoice.roundOffPaise = taxFinal.roundOffPaise;
          invoice.grandTotalPaise = taxFinal.grandTotalPaise;
          invoice.amountDuePaise = taxFinal.grandTotalPaise;
          invoice.amountPaidPaise = 0;
          invoice.paymentStatus = 'unpaid';
          invoice.amountInWords = amountInWords(taxFinal.grandTotalPaise);

          if (tcsPaise > 0) {
            invoice.tcsApplied = {
              section: '206C(1H)',
              rate: 0.001,
              basePaise: taxFinal.taxableValuePaise,
              amountPaise: tcsPaise,
            };
          }
          invoice.eInvoice = {
            status: firm.aato > 500 ? 'pending' : 'not_applicable',
            attempts: 0,
          };

          const isIntraState = firmStateCode === placeOfSupplyStateCode;
          await this.ledgerPosting.postSaleInvoice(taxFinal, {
            session,
            userId,
            firm: {
              _id: firm._id,
              workspaceId: new Types.ObjectId(wsId),
              gstin: firm.gstin,
            },
            party: {
              _id: invoice.partyId,
              name: (invoice.partySnapshot as any)?.name ?? '',
            },
            invoice: {
              _id: invoice._id,
              voucherNumber: invoice.voucherNumber,
              voucherType: invoice.voucherType,
              invoiceDate: invoice.voucherDate,
              financialYear: fy,
            },
            isIntraState,
          });

          await this.inventory.stockOut(wsId, firmId, invoice.lineItems, { session });

          invoice.state = 'posted';
          invoice.postedAt = new Date();
          invoice.postedBy = new Types.ObjectId(userId);
          invoice.auditLog.push({
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'approved',
            after: {
              voucherNumber: invoice.voucherNumber,
              grandTotalPaise: taxFinal.grandTotalPaise,
            },
          });

          await invoice.save({ session });
          return invoice.toObject();
        });

        // Phase 17 / FIN-16-03 — emit invoice.created after maker-checker approval
        // (D-17 non-blocking).
        try {
          this.events.emit('party.timeline', {
            type: 'invoice.created',
            workspaceId: wsId,
            firmId,
            partyId: result.partyId,
            refModel: 'SaleInvoice',
            refId: result._id,
            occurredAt: result.voucherDate ?? new Date(),
            actorUserId: userId,
            summary: `Invoice ${result.voucherNumber} for paise=${result.grandTotalPaise} created`,
            meta: {
              voucherNumber: result.voucherNumber,
              amountPaise: result.grandTotalPaise,
            },
          });
        } catch (err) {
          this.logger.warn(
            `party.timeline emit failed for invoice.created (approve, id=${result._id}): ${(err as Error)?.message ?? String(err)}`,
          );
        }

        // Phase 0 platform-bar: product analytics on the approved/posted invoice (ids /
        // voucher no / amount only, no PII). Best-effort, post-commit.
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_approved',
          properties: {
            workspaceId: wsId,
            firmId,
            invoiceId: result._id?.toString() ?? id,
            voucherNumber: result.voucherNumber,
            grandTotalPaise: result.grandTotalPaise,
          },
        });

        return result;
      },
    );
  }

  // ─── reject ───────────────────────────────────────────────────────────────

  async reject(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    reason: string,
  ): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.rejectInvoice',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'pending_approval') {
          throw new BadRequestException('Only pending_approval invoices can be rejected');
        }

        invoice.state = 'draft';
        invoice.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'rejected',
          reason,
        });

        const saved = await invoice.save();
        // Fire-and-forget product analytics on the rejection (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_rejected',
          properties: { workspaceId: wsId, firmId, invoiceId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  // ─── cancel ───────────────────────────────────────────────────────────────

  async cancel(
    wsId: string,
    firmId: string,
    id: string,
    reason: string,
    userId: string,
  ): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelInvoice',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'posted') {
          throw new BadRequestException('Only posted invoices can be cancelled');
        }

        // F-15 Plan 03: FY-lock guard against the invoice's voucherDate.
        await this.fyLock.assertOpen(wsId, firmId, invoice.voucherDate);

        const now = new Date();
        const postedAt = invoice.postedAt;
        if (postedAt) {
          const diffMs = now.getTime() - postedAt.getTime();
          const diffHours = diffMs / (1000 * 60 * 60);
          if (diffHours > 24) {
            throw new BadRequestException('Cancellation only allowed within 24 hours of posting');
          }
        }

        // WR-01: Block cancellation if any payment has already been recorded
        if ((invoice as any).amountPaidPaise > 0) {
          throw new BadRequestException(
            'Cannot cancel: invoice has recorded payments. Issue a credit note instead.',
          );
        }

        const firm = await this.firmsService.findOne(wsId, firmId);
        // WR-02: Use the FY of the invoice's voucher date, not the current date,
        // to avoid cross-FY aggregate corruption when cancelling prior-FY invoices.
        const fy = this.voucherSeries.getFYForDate(invoice.voucherDate, firm.fyStartMonth);

        const conn = this.model.db;
        const result = await conn.transaction(async (session) => {
          // CR-01: Reverse the original ledger entry so the trial balance stays clean
          const originalEntry = await this.ledgerPosting.findBySourceVoucher(invoice._id, {
            session,
          });
          if (originalEntry) {
            await this.ledgerPosting.postSaleInvoiceReverse(originalEntry, {
              session,
              userId,
            });
          }

          await this.partyAggregate.revert(
            wsId,
            firmId,
            invoice.partyId.toHexString(),
            fy,
            invoice.taxableValuePaise,
            { session },
          );

          await this.inventory.stockIn(wsId, firmId, invoice.lineItems, { session });

          invoice.state = 'cancelled';
          invoice.cancelledAt = now;
          invoice.cancelledBy = new Types.ObjectId(userId);
          invoice.cancellationReason = reason;
          invoice.auditLog.push({
            at: now,
            by: new Types.ObjectId(userId),
            action: 'cancelled',
            reason,
          });

          await invoice.save({ session });
          return invoice;
        });

        // Phase 0 platform-bar: analytics + central audit on the voided/cancelled
        // invoice. Ids / amounts only (no PII); best-effort, post-commit.
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_voided',
          properties: {
            workspaceId: wsId,
            firmId,
            invoiceId: (result as any)._id?.toString() ?? id,
            voucherNumber: (result as any).voucherNumber,
            grandTotalPaise: (result as any).grandTotalPaise,
          },
        });
        this.auditFinanceEvent({
          action: 'finance.invoice_voided',
          workspaceId: wsId,
          firmId,
          actorId: userId,
          entityId: (result as any)._id?.toString() ?? id,
          meta: {
            voucherNumber: (result as any).voucherNumber,
            grandTotalPaise: (result as any).grandTotalPaise,
            reason,
          },
        });

        return result;
      },
    );
  }

  // ─── clone ────────────────────────────────────────────────────────────────

  async clone(wsId: string, firmId: string, id: string, userId: string): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.cloneInvoice',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const original = await this.findOne(wsId, firmId, id);

        const cloned = new this.model({
          workspaceId: original.workspaceId,
          firmId: original.firmId,
          voucherType: 'sale_invoice',
          voucherDate: new Date(),
          state: 'draft',
          partyId: original.partyId,
          partySnapshot: original.partySnapshot,
          placeOfSupplyStateCode: original.placeOfSupplyStateCode,
          sellerGstin: original.sellerGstin,
          isReverseCharge: original.isReverseCharge ?? false,
          isBillOfSupply: original.isBillOfSupply ?? false,
          paymentTerms: original.paymentTerms,
          lineItems: original.lineItems,
          additionalCharges: original.additionalCharges,
          notes: original.notes,
          internalNotes: original.internalNotes,
          shipping: original.shipping,
          lateFeeSchedule: original.lateFeeSchedule,
          draftCreatedAt: new Date(),
          auditLog: [
            {
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'cloned',
              before: { clonedFrom: id },
            },
          ],
        });

        const saved = await cloned.save();
        // Fire-and-forget product analytics on the clone write (source + new ids only).
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_cloned',
          properties: { workspaceId: wsId, firmId, invoiceId: String(saved._id), sourceId: id },
        });
        return saved;
      },
    );
  }

  // ─── voidDraft ────────────────────────────────────────────────────────────

  async voidDraft(wsId: string, firmId: string, id: string, userId: string): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.voidInvoiceDraft',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'draft') {
          throw new BadRequestException('Only draft invoices can be voided');
        }

        invoice.state = 'void';
        invoice.isDeleted = true;
        invoice.deletedAt = new Date();
        invoice.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'voided',
        });

        return invoice.save();
      },
    );
  }

  // ─── markPaidByWebhook ────────────────────────────────────────────────────
  // Called by RazorpayLinkService.handlePaymentLinkPaid — idempotent

  async markPaidByWebhook(
    wsId: string,
    firmId: string,
    invoiceId: string,
    payload: { amountPaise: number; source: string; paymentLinkId: string },
  ): Promise<SaleInvoice> {
    const invoice = await this.findOne(wsId, firmId, invoiceId);
    if ((invoice as any).paymentStatus === 'paid') return invoice; // idempotent
    (invoice as any).amountPaidPaise = payload.amountPaise;
    (invoice as any).amountDuePaise = 0;
    (invoice as any).paymentStatus = 'paid';
    invoice.auditLog.push({
      at: new Date(),
      by: new Types.ObjectId('000000000000000000000000'), // system actor
      action: 'paid_via_razorpay_webhook',
      after: payload as any,
    });
    await invoice.save();

    // Phase 17 / FIN-16-03 — invoice.paid (transition from due>0 → due===0).
    // Webhook path always represents a full-pay transition.
    try {
      this.events.emit('party.timeline', {
        type: 'invoice.paid',
        workspaceId: wsId,
        firmId,
        partyId: (invoice as any).partyId,
        refModel: 'SaleInvoice',
        refId: (invoice as any)._id,
        occurredAt: new Date(),
        // System actor — payload.source is razorpay/cashfree, not a user.
        summary: `Invoice ${(invoice as any).voucherNumber} paid in full`,
        meta: { voucherNumber: (invoice as any).voucherNumber },
      });
    } catch (err) {
      this.logger.warn(
        `party.timeline emit failed for invoice.paid webhook (id=${(invoice as any)._id}): ${(err as Error)?.message ?? String(err)}`,
      );
    }

    return invoice;
  }

  // ─── sendVoucher ──────────────────────────────────────────────────────────
  // D-27: email channel is NOT a stub - emails the invoice PDF via MailService. No payment
  // link / UPI QR is included (feedback_no_payments_in_billing, owner decision 2026-06-06):
  // this module collects no payments; settlement happens outside and is recorded separately.

  async sendVoucher(
    wsId: string,
    firmId: string,
    id: string,
    body: { channels: string[]; message?: string; recipientEmail?: string },
    userId: string,
  ): Promise<{ dispatched: string[]; invoiceId: string; errors: Record<string, string> }> {
    return withFinanceSpan(
      this.tracer,
      'finance.sendInvoice',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        const firm = await this.firmsService.findOne(wsId, firmId);
        const dispatched: string[] = [];
        const errors: Record<string, string> = {};

        for (const channel of body.channels) {
          try {
            if (channel === 'email') {
              // Resolve recipient: explicit recipientEmail in body OR partySnapshot.email
              const to = body.recipientEmail ?? (invoice.partySnapshot as any)?.email;
              if (!to) throw new BadRequestException('No email address available for party');

              // Generate PDF (Wave 9 hardens this; Wave 5 ships a basic buffer).
              // Pass the live firm's invoiceLayout so the per-firm section
              // show/hide config (design spec 2026-06-01 SS2C / 3B) reaches the
              // emailed PDF; the stored invoice carries no firm snapshot.
              const pdfBuffer = await this.printService.generatePdfBuffer(invoice, 'a4-theme1', {
                invoiceLayout: (firm as any)?.invoiceLayout,
              });

              const attachments: any[] = [
                {
                  filename: `invoice-${(invoice as any).voucherNumber ?? String(invoice._id)}.pdf`,
                  content: pdfBuffer,
                  contentType: 'application/pdf',
                },
              ];

              // Recording-only product: no UPI QR / Razorpay "pay online" affordance
              // is included in the emailed invoice. Payment is collected outside
              // the app and recorded separately.

              // CR-05: Escape all user-controlled values before inserting into HTML
              const escapeHtml = (s: string): string =>
                s
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');

              const safeName = escapeHtml((invoice.partySnapshot as any)?.name ?? 'Customer');
              const safeMessage = body.message
                ? escapeHtml(body.message)
                : `Please find attached invoice ${(invoice as any).voucherNumber ?? ''} for ₹${(((invoice as any).grandTotalPaise ?? 0) / 100).toFixed(2)}.`;

              const subject = `Invoice ${(invoice as any).voucherNumber ?? '(draft)'} from ${(firm as any).firmName} — ₹${(((invoice as any).grandTotalPaise ?? 0) / 100).toFixed(2)}`;
              const html = `
            <p>Dear ${safeName},</p>
            <p>${safeMessage}</p>
            <p>Thank you,<br/>${(firm as any).firmName}</p>
          `;

              // Wave-3 Drift #32 — universal email-quota enforcement.
              await this.mailService.enforceEmailQuota(wsId);
              await this.mailService.sendInvoiceEmail({ to, subject, html, attachments });
              await this.mailService.incrementEmailUsage(wsId);
              dispatched.push('email');
            } else if (channel === 'whatsapp') {
              // F-02 stub — full AiSensy adapter ships in F-08 per D-27
              this.logger.warn(
                `WhatsApp channel stubbed for invoice ${id} — full adapter ships in F-08`,
              );
              dispatched.push('whatsapp:stub');
            } else if (channel === 'sms') {
              // F-02 stub — SMS provider integration deferred
              this.logger.warn(
                `SMS channel stubbed for invoice ${id} — provider integration pending`,
              );
              dispatched.push('sms:stub');
            } else if (channel === 'print') {
              // Print is client-side; just acknowledge
              dispatched.push('print');
            } else {
              errors[channel] = `Unknown channel: ${channel}`;
            }
          } catch (e: any) {
            errors[channel] = e.message;
          }
        }

        // Append send audit entry
        invoice.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'sent',
          after: { channels: dispatched } as any,
        });
        await invoice.save();

        // Phase 0 platform-bar: analytics + central audit on send. Carries channel
        // names + counts only; recipient email/phone are intentionally NOT logged
        // (PII rule). Best-effort, after the document save.
        this.postHog.capture({
          distinctId: userId,
          event: 'finance.invoice_sent',
          properties: {
            workspaceId: wsId,
            firmId,
            invoiceId: (invoice as any)._id?.toString() ?? id,
            voucherNumber: (invoice as any).voucherNumber,
            channels: dispatched,
            dispatchedCount: dispatched.length,
            errorCount: Object.keys(errors).length,
          },
        });
        this.auditFinanceEvent({
          action: 'finance.invoice_sent',
          workspaceId: wsId,
          firmId,
          actorId: userId,
          entityId: (invoice as any)._id?.toString() ?? id,
          meta: {
            voucherNumber: (invoice as any).voucherNumber,
            channels: dispatched,
            errorChannels: Object.keys(errors),
          },
        });

        return { dispatched, invoiceId: id, errors };
      },
    );
  }

  // ─── computeKpiSummary ────────────────────────────────────────────────────
  // D-26: server-side MongoDB aggregation — NOT client-side reduce.

  async computeKpiSummary(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{
    totalInvoiced: number;
    collected: number;
    outstanding: number;
    overdue: number;
    topPending: Array<{ partyName: string; amountPaise: number }>;
  }> {
    const wsObjId = new Types.ObjectId(wsId);
    const firmObjId = new Types.ObjectId(firmId);

    // Stage 1: Totals via $group
    const totalsAgg = await this.model.aggregate([
      {
        $match: {
          workspaceId: wsObjId,
          firmId: firmObjId,
          isDeleted: false,
          state: 'posted',
          voucherDate: { $gte: dateFrom, $lte: dateTo },
        },
      },
      {
        $group: {
          _id: null,
          totalInvoiced: { $sum: '$grandTotalPaise' },
          collected: { $sum: '$amountPaidPaise' },
          outstanding: { $sum: '$amountDuePaise' },
          overdue: {
            $sum: {
              $cond: [{ $eq: ['$paymentStatus', 'overdue'] }, '$amountDuePaise', 0],
            },
          },
        },
      },
    ]);
    const totals = totalsAgg[0] ?? { totalInvoiced: 0, collected: 0, outstanding: 0, overdue: 0 };

    // Stage 2: Top 3 pending parties via $group + $sort + $limit
    const topPendingAgg = await this.model.aggregate([
      {
        $match: {
          workspaceId: wsObjId,
          firmId: firmObjId,
          isDeleted: false,
          state: 'posted',
          amountDuePaise: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$partyId',
          partyName: { $first: '$partySnapshot.name' },
          amountPaise: { $sum: '$amountDuePaise' },
        },
      },
      { $sort: { amountPaise: -1 } },
      { $limit: 3 },
      { $project: { _id: 0, partyName: 1, amountPaise: 1 } },
    ]);

    return {
      totalInvoiced: totals.totalInvoiced ?? 0,
      collected: totals.collected ?? 0,
      outstanding: totals.outstanding ?? 0,
      overdue: totals.overdue ?? 0,
      topPending: topPendingAgg,
    };
  }

  // ─── applyLateFeeOverride ─────────────────────────────────────────────────

  async applyLateFeeOverride(
    wsId: string,
    firmId: string,
    id: string,
    override: { type: string; value: number; gracePeriodDays: number },
    userId: string,
  ): Promise<SaleInvoice> {
    return withFinanceSpan(
      this.tracer,
      'finance.applyLateFeeOverride',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const invoice = await this.findOne(wsId, firmId, id);
        if (invoice.state !== 'posted') {
          throw new BadRequestException('Late fee override only allowed on posted invoices');
        }

        const before = invoice.lateFeeSchedule;
        invoice.lateFeeSchedule = override;
        invoice.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'late_fee_override',
          before: { lateFeeSchedule: before },
          after: { lateFeeSchedule: override },
        });

        return invoice.save();
      },
    );
  }

  // ─── createDraftFromSample ────────────────────────────────────────────────

  /**
   * D-07 acceptance flow: Creates a draft Tax Invoice pre-filled from an accepted SampleVoucher.
   * Called from SamplesService.accept(). Status = 'draft' so user can review/edit before posting.
   *
   * @param voucher        The SampleVoucher being accepted (full document with lines)
   * @param acceptedLines  Lines accepted by the customer; each maps to an entry in voucher.lines
   * @param userId         Current user ObjectId (string) for createdBy
   * @returns The newly-created draft SaleInvoice document
   */
  async createDraftFromSample(
    voucher: SampleVoucherDocument,
    acceptedLines: Array<{ lineIdx: number; acceptedQty: number }>,
    userId: string,
  ): Promise<SaleInvoice> {
    const workspaceId = (voucher as any).workspaceId.toString();
    const firmId = (voucher as any).firmId.toString();

    if (!acceptedLines || acceptedLines.length === 0) {
      throw new BadRequestException('acceptedLines must be non-empty');
    }

    const lineItems = acceptedLines.map((al) => {
      const srcLine = (voucher as any).lines?.[al.lineIdx];
      if (!srcLine) {
        throw new BadRequestException(`Sample line index ${al.lineIdx} not found on voucher`);
      }
      return {
        itemId: srcLine.itemId,
        godownId: srcLine.godownId,
        lotId: srcLine.lotId,
        batchId: srcLine.batchId,
        serialNos: srcLine.serialNos,
        qty: al.acceptedQty,
        // Use rate from sample line; TaxComputationService will fill tax fields on compute/post
        ratePaise: srcLine.ratePaise ?? srcLine.rate ?? 0,
        unit: srcLine.unit ?? 'Pcs',
        itemName: srcLine.itemName ?? '',
        hsnSacCode: srcLine.hsnSacCode,
        discountPct: srcLine.discountPct ?? 0,
        taxRate: srcLine.taxRate ?? 18,
        cessRate: srcLine.cessRate ?? 0,
        isTaxInclusive: srcLine.isTaxInclusive ?? false,
      };
    });

    // Build the draft document directly (bypassing createDraft's partyId-required flow
    // since sample vouchers carry partyId but not necessarily an updated partySnapshot)
    const party = await this.partiesService.findOne(
      workspaceId,
      firmId,
      (voucher as any).partyId.toString(),
    );

    const draft = new this.model({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      voucherType: 'sale_invoice',
      voucherDate: new Date(),
      state: 'draft',
      partyId: new Types.ObjectId((voucher as any).partyId.toString()),
      partySnapshot: {
        name: party.name,
        gstin: party.gstin,
        state: party.state,
        address: party.address,
        pan: party.pan,
      },
      lineItems,
      additionalCharges: [],
      narration: `Auto-created from Sample Voucher ${(voucher as any).voucherNo ?? (voucher as any)._id}`,
      sourceSampleVoucherId: new Types.ObjectId((voucher as any)._id.toString()),
      draftCreatedAt: new Date(),
      auditLog: [
        {
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'created_from_sample',
          before: { sourceSampleVoucherId: (voucher as any)._id.toString() },
        },
      ],
    });

    return draft.save();
  }
}
