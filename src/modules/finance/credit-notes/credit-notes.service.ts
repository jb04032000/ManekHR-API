import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as Sentry from '@sentry/node';
import { trace } from '@opentelemetry/api';
import { Model, Connection, Types } from 'mongoose';
import { CreditNote } from './credit-note.schema';
import { AuditService } from '../../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { SaleInvoice } from '../sales/sale-invoice/sale-invoice.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { LedgerPostingService } from '../sales/ledger-posting/ledger-posting.service';
import { InventoryService } from '../sales/inventory/inventory.service';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { FirmsService } from '../firms/firms.service';
import {
  CreateCreditNoteDto,
  UpdateCreditNoteDto,
  ListCreditNotesQueryDto,
} from './credit-note.dto';
import { FyLockService } from '../fiscal-year/fy-lock.service';

@Injectable()
export class CreditNotesService {
  private readonly logger = new Logger(CreditNotesService.name);
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(CreditNote.name) private readonly creditNoteModel: Model<CreditNote>,
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntry>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly inventoryService: InventoryService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly fyLock: FyLockService,
    // Phase 17 / FIN-16-03 — party.timeline emit (D-17 non-blocking).
    private readonly events: EventEmitter2,
    // Phase 0 platform-bar: central audit stream + product analytics on the
    // credit-note write (alongside the embedded auditLog[] trail, which is NOT
    // removed).
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Fire-and-forget central-audit helper for the credit-note write. Mirrors
   * `TeamService.auditTeamEvent`: failure here must NEVER break the primary
   * voucher write, so we swallow + Sentry-tag. Records under
   * `AppModule.FINANCE`. PII rule: `meta` carries ids / amounts / voucher
   * numbers only.
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
        entityType: 'credit_note',
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

  // ═══════════════════════════════════════════════════════════════════════════
  // createDraft
  // ═══════════════════════════════════════════════════════════════════════════
  async createDraft(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateCreditNoteDto,
    userId: string,
  ): Promise<CreditNote> {
    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(workspaceId, firmId, new Date(dto.voucherDate));

    // 1. Load source invoice (workspace-isolated)
    const sourceInvoice = await this.saleInvoiceModel
      .findOne({
        _id: new Types.ObjectId(dto.sourceInvoiceId),
        workspaceId,
        firmId,
        isDeleted: { $ne: true },
      })
      .lean();
    if (!sourceInvoice) throw new NotFoundException('Source invoice not found');

    // 2. Reject CN against cancelled invoice (T-F07W2-06 / Edge Case 7)
    if (sourceInvoice.state === 'cancelled') {
      throw new BadRequestException(
        'Cannot issue Credit Note against a cancelled invoice. The invoice was reversed internally.',
      );
    }

    // 3. Reject if source invoice is not yet posted
    if (sourceInvoice.state !== 'posted') {
      throw new BadRequestException(
        'Source invoice must be in posted state to issue a Credit Note.',
      );
    }

    // 4. Enforce 30 Nov time-limit (T-F07W2-05 / Pitfall 7)
    const invoiceFy = this.voucherSeriesService.getFYForDate(sourceInvoice.voucherDate);
    const fyEndYear = this.parseFinancialYearEndYear(invoiceFy); // e.g. '2024-25' → 2025
    const deadline = new Date(fyEndYear + 1, 10, 30); // 30 Nov of year after FY end (month index 10 = November)
    const cnDate = new Date(dto.voucherDate);
    if (cnDate > deadline) {
      throw new BadRequestException(
        `Credit Note time limit expired. The deadline for FY ${invoiceFy} was ${deadline.toDateString()}.`,
      );
    }

    // 5. Derive isIntraState (T-F07W2-02): compare firm GSTIN state code vs invoice placeOfSupply
    const firm = await this.firmsService.findOne(workspaceId.toString(), firmId.toString());
    const firmStateCode = (firm as any).gstin?.slice(0, 2) ?? null;
    const isIntraState =
      firmStateCode !== null ? sourceInvoice.placeOfSupplyStateCode === firmStateCode : true; // default intra-state if firm has no GSTIN

    // 6. Compute totals from line items (server-side recomputation — T-F07W2-03)
    const computed = this.computeLineTotals(dto.lineItems, isIntraState);

    // 7. Cumulative cap check (T-F07W2-07 / Pitfall 5)
    const existingCnAggregate = await this.creditNoteModel.aggregate([
      {
        $match: {
          workspaceId,
          firmId,
          sourceInvoiceId: (sourceInvoice as any)._id,
          state: 'posted',
        },
      },
      { $group: { _id: null, total: { $sum: '$grandTotalPaise' } } },
    ]);
    const alreadyReturnedPaise: number = existingCnAggregate[0]?.total ?? 0;

    if (alreadyReturnedPaise + computed.grandTotalPaise > (sourceInvoice as any).grandTotalPaise) {
      const remainingPaise = Math.max(
        0,
        (sourceInvoice as any).grandTotalPaise - alreadyReturnedPaise,
      );
      throw new BadRequestException(
        `Cannot exceed original invoice amount. Remaining returnable: ₹${(remainingPaise / 100).toFixed(2)}.`,
      );
    }

    // 8. Derive cdnrType (T-F07W2-01): server-side from partySnapshot.gstin
    const partyGstin: string | undefined = (sourceInvoice as any).partySnapshot?.gstin;
    const cdnrType = partyGstin ? 'cdnr' : 'cdnur';

    // 9. Derive reverseStock defaults (Pitfall 2): goods_return defaults true, others false
    const linesWithStockFlag = computed.lineItems.map((l, idx) => ({
      ...l,
      reverseStock: dto.lineItems[idx].reverseStock ?? dto.cnType === 'goods_return',
    }));

    // D11: a commercial / financial credit note (kasar-vatav) carries no GST adjustment - tax
    // is zeroed and grand total = taxable value (it posts to Kasar-Vatav Allowed, not output tax).
    const isCommercial = dto.isCommercial ?? false;
    const cnCgstPaise = isCommercial ? 0 : isIntraState ? computed.cgstPaise : 0;
    const cnSgstPaise = isCommercial ? 0 : isIntraState ? computed.sgstPaise : 0;
    const cnIgstPaise = isCommercial ? 0 : isIntraState ? 0 : computed.igstPaise;
    const cnGrandTotalPaise = isCommercial ? computed.taxableValuePaise : computed.grandTotalPaise;

    // 10. Persist draft (no voucherNumber yet — assigned at post())
    const cn = new this.creditNoteModel({
      workspaceId,
      firmId,
      voucherType: 'credit_note',
      voucherDate: cnDate,
      // FY for the CN's OWN numbering = its own issue-date FY (Rule 46/53, GSTR-1 9B).
      // `invoiceFy` above is the SOURCE invoice's FY and is used only for the Sec 34
      // 30-Nov deadline, not for numbering this note.
      financialYear: this.voucherSeriesService.getFYForDate(
        cnDate,
        (firm as any).fyStartMonth ?? 4,
      ),
      state: 'draft',
      sourceInvoiceId: (sourceInvoice as any)._id,
      sourceInvoiceNumber: sourceInvoice.voucherNumber,
      sourceInvoiceDate: sourceInvoice.voucherDate,
      sourceInvoiceGrandTotalPaise: (sourceInvoice as any).grandTotalPaise,
      partyId: (sourceInvoice as any).partyId,
      partySnapshot: sourceInvoice.partySnapshot,
      placeOfSupplyStateCode: sourceInvoice.placeOfSupplyStateCode,
      isIntraState,
      cdnrType,
      cnType: dto.cnType,
      reasonCode: dto.reasonCode,
      lineItems: linesWithStockFlag,
      isCommercial,
      taxableValuePaise: computed.taxableValuePaise,
      cgstPaise: cnCgstPaise,
      sgstPaise: cnSgstPaise,
      igstPaise: cnIgstPaise,
      grandTotalPaise: cnGrandTotalPaise,
      recipientItcReversalStatus:
        dto.recipientItcReversalStatus ?? (cdnrType === 'cdnur' ? 'not_applicable' : 'pending'),
      recipientItcReversalDocUrl: dto.recipientItcReversalDocUrl,
      narration: dto.narration,
      notes: dto.notes,
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'create_draft' }],
    });

    await cn.save();
    return cn;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // update (draft only)
  // ═══════════════════════════════════════════════════════════════════════════
  async update(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: UpdateCreditNoteDto,
    userId: string,
  ): Promise<CreditNote> {
    const cn = await this.creditNoteModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId,
      firmId,
    });
    if (!cn) throw new NotFoundException('Credit Note not found');
    if (cn.state !== 'draft') {
      throw new BadRequestException('Only draft Credit Notes can be updated');
    }

    // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate
    await this.fyLock.assertOpen(workspaceId, firmId, cn.voucherDate);
    if ((dto as any).voucherDate) {
      await this.fyLock.assertOpen(workspaceId, firmId, new Date((dto as any).voucherDate));
    }

    if (dto.isCommercial !== undefined) cn.isCommercial = dto.isCommercial;

    if (dto.lineItems) {
      const computed = this.computeLineTotals(dto.lineItems, cn.isIntraState);

      // Re-validate cumulative cap on update (WR-01: cap was only checked at createDraft)
      await this.assertCumulativeCapNotExceeded(
        workspaceId,
        firmId,
        cn.sourceInvoiceId,
        computed.grandTotalPaise,
        (cn as any)._id as Types.ObjectId, // exclude this CN itself from the aggregate
      );

      cn.lineItems = computed.lineItems.map((l, idx) => ({
        ...l,
        reverseStock: dto.lineItems[idx].reverseStock ?? l.reverseStock,
      })) as any;
      cn.taxableValuePaise = computed.taxableValuePaise;
      if (cn.isCommercial) {
        // D11: commercial / financial CN (kasar-vatav) - no GST adjustment.
        cn.cgstPaise = 0;
        cn.sgstPaise = 0;
        cn.igstPaise = 0;
        cn.grandTotalPaise = computed.taxableValuePaise;
      } else {
        cn.cgstPaise = cn.isIntraState ? computed.cgstPaise : 0;
        cn.sgstPaise = cn.isIntraState ? computed.sgstPaise : 0;
        cn.igstPaise = cn.isIntraState ? 0 : computed.igstPaise;
        cn.grandTotalPaise = computed.grandTotalPaise;
      }
    }
    if (dto.voucherDate) cn.voucherDate = new Date(dto.voucherDate);
    if (dto.cnType) cn.cnType = dto.cnType;
    if (dto.narration !== undefined) cn.narration = dto.narration;
    if (dto.notes !== undefined) cn.notes = dto.notes;
    if (dto.recipientItcReversalStatus) {
      cn.recipientItcReversalStatus = dto.recipientItcReversalStatus;
    }
    if (dto.recipientItcReversalDocUrl !== undefined) {
      cn.recipientItcReversalDocUrl = dto.recipientItcReversalDocUrl;
    }
    cn.auditLog.push({ at: new Date(), by: new Types.ObjectId(userId), action: 'update' });
    await cn.save();
    return cn;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // post
  // ═══════════════════════════════════════════════════════════════════════════
  async post(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    userId: string,
  ): Promise<CreditNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.postCreditNote',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const cn = await this.creditNoteModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!cn) throw new NotFoundException('Credit Note not found');
        if (cn.state !== 'draft') {
          throw new BadRequestException('Only draft Credit Notes can be posted');
        }

        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, cn.voucherDate);

        // Finance Act 2025 enforcement (T-F07W2-04 / Pitfall 1)
        // ₹5,00,000 (five lakh rupees) = 5_00_000 * 100 paise = 50_000_000 paise
        // Named explicitly to avoid confusion with ₹50L (which would be 5_000_000 * 100)
        const FIVE_LAKH_RUPEES_IN_PAISE = 5_00_000 * 100; // = 50_000_000
        if (
          cn.cdnrType === 'cdnr' &&
          cn.recipientItcReversalStatus === 'pending' &&
          cn.grandTotalPaise > FIVE_LAKH_RUPEES_IN_PAISE
        ) {
          throw new BadRequestException(
            'Cannot post Credit Note: recipient ITC reversal must be confirmed (Finance Act 2025 Section 34(2)). ' +
              'Upload CA/CMA certificate and set recipientItcReversalStatus to "ca_certified" before posting.',
          );
        }

        // Generate voucherNumber BEFORE the transaction. generateNextNumber does not
        // participate in MongoDB sessions — calling it inside withTransaction still
        // commits the counter increment independently. By moving it outside we make
        // the intent explicit: a gap in the sequence is acceptable if the transaction
        // later fails, but duplicate numbers caused by concurrent calls are prevented
        // by the unique partial index on (workspaceId, firmId, voucherNumber, financialYear)
        // where state='posted'.
        const voucherNumber = await this.voucherSeriesService.generateNextNumber(
          firmId.toString(),
          'credit_note',
          cn.financialYear,
        );

        const session = await this.connection.startSession();
        let result: CreditNote;
        try {
          await session.withTransaction(async () => {
            // 1. Reload current invoice amountDuePaise inside transaction
            const invoice = await this.saleInvoiceModel
              .findOne({ _id: cn.sourceInvoiceId, workspaceId, firmId, isDeleted: { $ne: true } })
              .session(session);
            if (!invoice) throw new NotFoundException('Source invoice not found at post time');
            if (invoice.state === 'cancelled') {
              throw new BadRequestException('Cannot post CN: source invoice was cancelled');
            }
            const invoiceAmountDuePaise = (invoice as any).amountDuePaise as number;

            // 1b. Final cumulative cap guard inside transaction (WR-01: draft may have been
            //     inflated via update() between createDraft and post())
            const capAggregate = await this.creditNoteModel.aggregate([
              {
                $match: {
                  workspaceId,
                  firmId,
                  sourceInvoiceId: cn.sourceInvoiceId,
                  state: 'posted',
                },
              },
              { $group: { _id: null, total: { $sum: '$grandTotalPaise' } } },
            ]);
            const alreadyPostedPaise: number = capAggregate[0]?.total ?? 0;
            if (alreadyPostedPaise + cn.grandTotalPaise > (invoice as any).grandTotalPaise) {
              const remainingPaise = Math.max(
                0,
                (invoice as any).grandTotalPaise - alreadyPostedPaise,
              );
              throw new BadRequestException(
                `Cannot post Credit Note: cumulative CN amount exceeds invoice total. ` +
                  `Remaining returnable: ₹${(remainingPaise / 100).toFixed(2)}.`,
              );
            }

            // 2. Assign pre-generated voucherNumber
            cn.voucherNumber = voucherNumber;

            // 3. Post LedgerEntry
            await this.ledgerPostingService.postCreditNote(cn, invoiceAmountDuePaise, {
              session,
              userId,
              firm: { _id: firmId, workspaceId },
            });

            // 4. Stock reversal for goods_return lines (Pitfall 2)
            const stockLines = cn.lineItems
              .filter((l: any) => l.reverseStock === true && l.itemId && l.qty && l.qty > 0)
              .map((l: any) => ({ itemId: l.itemId, qty: l.qty }));
            if (stockLines.length > 0) {
              await this.inventoryService.stockIn(
                workspaceId.toString(),
                firmId.toString(),
                stockLines,
                { session },
              );
            }

            // 5. Update invoice outstanding (Pitfall 4)
            const debtorReductionPaise = Math.min(
              cn.grandTotalPaise,
              Math.max(0, invoiceAmountDuePaise),
            );
            const refundPaise = Math.max(0, cn.grandTotalPaise - invoiceAmountDuePaise);
            const newAmountDue = Math.max(0, invoiceAmountDuePaise - cn.grandTotalPaise);
            const newPaymentStatus = this.recomputePaymentStatus(
              (invoice as any).amountPaidPaise,
              newAmountDue,
              (invoice as any).grandTotalPaise,
            );
            await this.saleInvoiceModel.updateOne(
              { _id: invoice._id },
              { $set: { amountDuePaise: newAmountDue, paymentStatus: newPaymentStatus } },
              { session },
            );

            // 6. Update CN state
            cn.state = 'posted';
            cn.postingStatus = undefined; // R10: this post succeeded - clear any prior needs_attention
            cn.refundAmountPaise = refundPaise;
            cn.postedBy = new Types.ObjectId(userId);
            cn.postedAt = new Date();
            cn.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'post',
              after: {
                debtorReductionPaise,
                refundPaise,
                voucherNumber: cn.voucherNumber,
              },
            });
            await cn.save({ session });
            result = cn;
          });

          // Phase 17 / FIN-16-03 — credit_note.created emit AFTER commit.
          try {
            this.events.emit('party.timeline', {
              type: 'credit_note.created',
              workspaceId,
              firmId,
              partyId: (result as any).partyId,
              refModel: 'CreditNote',
              refId: (result as any)._id,
              occurredAt: (result as any).voucherDate ?? new Date(),
              actorUserId: userId,
              summary: `Credit Note ${(result as any).voucherNumber}`,
              meta: {
                voucherNumber: (result as any).voucherNumber,
                amountPaise: (result as any).grandTotalPaise,
              },
            });
          } catch (err) {
            this.logger.warn(
              `party.timeline emit failed for credit_note.created (id=${(result as any)._id}): ${(err as Error)?.message ?? String(err)}`,
            );
          }

          // Phase 0 platform-bar: analytics + central audit on the posted credit
          // note. Ids / amounts only (no PII); best-effort, post-commit.
          this.postHog.capture({
            distinctId: userId,
            event: 'finance.credit_note_created',
            properties: {
              workspaceId: workspaceId.toString(),
              firmId: firmId.toString(),
              creditNoteId: (result as any)._id?.toString() ?? id,
              voucherNumber: (result as any).voucherNumber,
              grandTotalPaise: (result as any).grandTotalPaise,
              sourceInvoiceId: (result as any).sourceInvoiceId?.toString(),
            },
          });
          this.auditFinanceEvent({
            action: 'finance.credit_note_created',
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            actorId: userId,
            entityId: (result as any)._id?.toString() ?? id,
            meta: {
              voucherNumber: (result as any).voucherNumber,
              grandTotalPaise: (result as any).grandTotalPaise,
              sourceInvoiceId: (result as any).sourceInvoiceId?.toString(),
              isCommercial: (result as any).isCommercial,
            },
          });

          return result;
        } catch (err) {
          // R10: the post + ledger write failed and the transaction rolled back (CN stays draft).
          // Flag it 'needs_attention' in a SEPARATE write OUTSIDE the aborted transaction (no
          // session) so the failed post is visible in document lists for follow-up rather than a
          // vanished transient error. Re-throw so the caller still surfaces the failure.
          await this.creditNoteModel
            .updateOne({ _id: cn._id }, { $set: { postingStatus: 'needs_attention' } })
            .catch(() => undefined);
          throw err;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // cancel (posted only)
  // ═══════════════════════════════════════════════════════════════════════════
  async cancel(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    reason: string,
    userId: string,
  ): Promise<CreditNote> {
    const cn = await this.creditNoteModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId,
      firmId,
    });
    if (!cn) throw new NotFoundException('Credit Note not found');
    if (cn.state !== 'posted') {
      throw new BadRequestException('Only posted Credit Notes can be cancelled');
    }

    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(workspaceId, firmId, cn.voucherDate);

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // 1. Find original LedgerEntry for this CN
        const originalEntry = await this.ledgerEntryModel
          .findOne({
            workspaceId,
            firmId,
            sourceVoucherId: cn._id,
            sourceVoucherType: 'credit_note',
          })
          .session(session);
        if (!originalEntry) {
          throw new NotFoundException('Original LedgerEntry not found for Credit Note');
        }

        // 2. Post reversal entry (sourceVoucherType='credit_note_reversal' — distinct)
        await this.ledgerPostingService.postCreditNoteReversal(cn, originalEntry, {
          session,
          userId,
          firm: { _id: firmId, workspaceId },
        });

        // 3. Restore stock for lines that had reverseStock=true (T-F07W2-12)
        const stockLines = cn.lineItems
          .filter((l: any) => l.reverseStock === true && l.itemId && l.qty && l.qty > 0)
          .map((l: any) => ({ itemId: l.itemId, qty: l.qty }));
        if (stockLines.length > 0) {
          await this.inventoryService.stockOut(
            workspaceId.toString(),
            firmId.toString(),
            stockLines,
            { session },
          );
        }

        // 4. Restore invoice outstanding
        const invoice = await this.saleInvoiceModel
          .findOne({ _id: cn.sourceInvoiceId, workspaceId, firmId, isDeleted: { $ne: true } })
          .session(session);
        if (invoice) {
          // Cap restoration so amountDuePaise never exceeds grandTotalPaise (WR-04)
          const restoredAmountDue = Math.min(
            (invoice as any).amountDuePaise + cn.grandTotalPaise,
            (invoice as any).grandTotalPaise,
          );
          const newPaymentStatus = this.recomputePaymentStatus(
            (invoice as any).amountPaidPaise,
            restoredAmountDue,
            (invoice as any).grandTotalPaise,
          );
          await this.saleInvoiceModel.updateOne(
            { _id: invoice._id },
            { $set: { amountDuePaise: restoredAmountDue, paymentStatus: newPaymentStatus } },
            { session },
          );
        }

        // 5. Mark CN as cancelled
        cn.state = 'cancelled';
        cn.cancelledBy = new Types.ObjectId(userId);
        cn.cancelledAt = new Date();
        cn.cancellationReason = reason;
        cn.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancel',
          reason,
        } as any);
        await cn.save({ session });
      });
      // D16: audit the reversal (it mutates the ledger, stock, and invoice outstanding).
      // isCommercial in the meta distinguishes a kasar-vatav CN from a GST CN in the trail.
      this.auditFinanceEvent({
        action: 'finance.credit_note_cancelled',
        workspaceId: workspaceId.toString(),
        firmId: firmId.toString(),
        actorId: userId,
        entityId: String(cn._id),
        meta: {
          voucherNumber: cn.voucherNumber,
          grandTotalPaise: cn.grandTotalPaise,
          isCommercial: cn.isCommercial,
          reason,
        },
      });
      return cn;
    } finally {
      await session.endSession();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // findAll
  // ═══════════════════════════════════════════════════════════════════════════
  async findAll(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    query: ListCreditNotesQueryDto,
  ): Promise<{ items: CreditNote[]; total: number }> {
    const filter: any = { workspaceId, firmId, isDeleted: { $ne: true } };
    if (query.state) filter.state = query.state;
    // R10: filter the quarantine bucket (needs_attention) vs clean docs (no postingStatus).
    if (query.postingStatus === 'needs_attention') filter.postingStatus = 'needs_attention';
    else if (query.postingStatus === 'clean') filter.postingStatus = { $exists: false };
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.fromDate || query.toDate) {
      filter.voucherDate = {};
      if (query.fromDate) filter.voucherDate.$gte = new Date(query.fromDate);
      if (query.toDate) filter.voucherDate.$lte = new Date(query.toDate);
    }
    const limit = Math.min(query.limit ?? 50, 200);
    const skip = query.skip ?? 0;
    const [items, total] = await Promise.all([
      this.creditNoteModel.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).lean(),
      this.creditNoteModel.countDocuments(filter),
    ]);
    return { items: items as any, total };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // findById
  // ═══════════════════════════════════════════════════════════════════════════
  async findById(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
  ): Promise<CreditNote> {
    const cn = await this.creditNoteModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
        firmId,
        isDeleted: { $ne: true },
      })
      .lean();
    if (!cn) throw new NotFoundException('Credit Note not found');
    return cn as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // listByInvoice
  // ═══════════════════════════════════════════════════════════════════════════
  async listByInvoice(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    invoiceId: string,
  ): Promise<CreditNote[]> {
    return (await this.creditNoteModel
      .find({
        workspaceId,
        firmId,
        sourceInvoiceId: new Types.ObjectId(invoiceId),
        isDeleted: { $ne: true },
      })
      .sort({ voucherDate: -1 })
      .lean()) as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validates that adding `newGrandTotalPaise` to the already-posted CNs against
   * `sourceInvoiceId` does not exceed the original invoice amount.
   * Pass `excludeCnId` to exclude the current CN itself from the aggregate
   * (used during update() where the CN is a draft being edited, not yet posted).
   */
  private async assertCumulativeCapNotExceeded(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    sourceInvoiceId: Types.ObjectId,
    newGrandTotalPaise: number,
    excludeCnId?: Types.ObjectId,
  ): Promise<void> {
    const invoice = await this.saleInvoiceModel
      .findOne({ _id: sourceInvoiceId, workspaceId, firmId, isDeleted: { $ne: true } })
      .lean();
    if (!invoice) throw new NotFoundException('Source invoice not found');

    const matchFilter: any = {
      workspaceId,
      firmId,
      sourceInvoiceId,
      state: 'posted',
    };
    if (excludeCnId) {
      matchFilter._id = { $ne: excludeCnId };
    }
    const aggregate = await this.creditNoteModel.aggregate([
      { $match: matchFilter },
      { $group: { _id: null, total: { $sum: '$grandTotalPaise' } } },
    ]);
    const alreadyReturnedPaise: number = aggregate[0]?.total ?? 0;

    if (alreadyReturnedPaise + newGrandTotalPaise > (invoice as any).grandTotalPaise) {
      const remainingPaise = Math.max(0, (invoice as any).grandTotalPaise - alreadyReturnedPaise);
      throw new BadRequestException(
        `Cannot exceed original invoice amount. Remaining returnable: ₹${(remainingPaise / 100).toFixed(2)}.`,
      );
    }
  }

  private parseFinancialYearEndYear(fy: string): number {
    // '2024-25' -> 2025
    const parts = fy.split('-');
    if (parts.length !== 2) {
      throw new BadRequestException(`Invalid financialYear format: ${fy}`);
    }
    const startYear = parseInt(parts[0], 10);
    return startYear + 1;
  }

  private computeLineTotals(
    lines: Array<{
      qty?: number;
      ratePaise?: number;
      discountPct?: number;
      taxRate?: number;
      itemId?: string;
      itemName?: string;
      hsnSacCode?: string;
      unit?: string;
    }>,
    isIntraState: boolean,
  ): {
    lineItems: any[];
    taxableValuePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    grandTotalPaise: number;
  } {
    let taxableTotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;

    const computedLines = lines.map((line) => {
      const qty = line.qty ?? 0;
      const rate = line.ratePaise ?? 0;
      const discountPct = line.discountPct ?? 0;
      const taxRate = line.taxRate ?? 0;

      const grossPaise = Math.round(qty * rate);
      const discountPaise = Math.round((grossPaise * discountPct) / 100);
      const taxablePaise = grossPaise - discountPaise;

      // GST computed at line level
      const lineCgstPaise = isIntraState ? Math.round((taxablePaise * taxRate) / 100 / 2) : 0;
      const lineSgstPaise = isIntraState ? Math.round((taxablePaise * taxRate) / 100 / 2) : 0;
      const lineIgstPaise = isIntraState ? 0 : Math.round((taxablePaise * taxRate) / 100);
      const lineTotalPaise = isIntraState
        ? taxablePaise + lineCgstPaise + lineSgstPaise
        : taxablePaise + lineIgstPaise;

      taxableTotal += taxablePaise;
      cgstTotal += lineCgstPaise;
      sgstTotal += lineSgstPaise;
      igstTotal += lineIgstPaise;

      return {
        itemId: line.itemId ? new Types.ObjectId(line.itemId) : undefined,
        itemName: line.itemName,
        hsnSacCode: line.hsnSacCode,
        qty,
        unit: line.unit,
        ratePaise: rate,
        discountPct,
        taxRate,
        taxableValuePaise: taxablePaise,
        cgstPaise: lineCgstPaise,
        sgstPaise: lineSgstPaise,
        igstPaise: lineIgstPaise,
        lineTotalPaise,
      };
    });

    const grandTotalPaise = isIntraState
      ? taxableTotal + cgstTotal + sgstTotal
      : taxableTotal + igstTotal;

    return {
      lineItems: computedLines,
      taxableValuePaise: taxableTotal,
      cgstPaise: cgstTotal,
      sgstPaise: sgstTotal,
      igstPaise: igstTotal,
      grandTotalPaise,
    };
  }

  private recomputePaymentStatus(
    amountPaidPaise: number,
    amountDuePaise: number,
    _grandTotalPaise: number,
  ): string {
    if (amountDuePaise <= 0) return 'paid';
    if (amountPaidPaise > 0) return 'partial';
    return 'unpaid';
  }
}
