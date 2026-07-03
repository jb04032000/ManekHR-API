import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { trace } from '@opentelemetry/api';
import { Model, Connection, Types } from 'mongoose';
import { DebitNote } from './debit-note.schema';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { PurchaseBill } from '../purchases/purchase-bill/purchase-bill.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { CapitalGoodsItcSchedule } from '../purchases/capital-goods-itc/capital-goods-itc-schedule.schema';
import { LedgerPostingService } from '../sales/ledger-posting/ledger-posting.service';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { FirmsService } from '../firms/firms.service';
import { GrnReturnsService } from '../grn-returns/grn-returns.service';
import { CreateDebitNoteDto, UpdateDebitNoteDto, ListDebitNotesQueryDto } from './debit-note.dto';
import { FyLockService } from '../fiscal-year/fy-lock.service';

@Injectable()
export class DebitNotesService {
  private readonly logger = new Logger(DebitNotesService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(DebitNote.name) private readonly debitNoteModel: Model<DebitNote>,
    @InjectModel(PurchaseBill.name) private readonly purchaseBillModel: Model<PurchaseBill>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntry>,
    @InjectModel(CapitalGoodsItcSchedule.name)
    private readonly capitalGoodsItcModel: Model<CapitalGoodsItcSchedule>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly grnReturnsService: GrnReturnsService,
    private readonly fyLock: FyLockService,
    // Phase 17 / FIN-16-03 — party.timeline emit (D-17 non-blocking).
    private readonly events: EventEmitter2,
    private readonly postHog: PostHogService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // createDraft
  // ═══════════════════════════════════════════════════════════════════════════
  async createDraft(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateDebitNoteDto,
    userId: string,
  ): Promise<DebitNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.createDebitNote',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, new Date(dto.voucherDate));

        // 1. Load source purchase bill (workspace-isolated)
        const sourceBill = await this.purchaseBillModel
          .findOne({
            _id: new Types.ObjectId(dto.sourceBillId),
            workspaceId,
            firmId,
            isDeleted: { $ne: true },
          })
          .lean();
        if (!sourceBill) throw new NotFoundException('Source purchase bill not found');

        // 2. Reject DN against cancelled bill (T-F07W3-03)
        if (sourceBill.state === 'cancelled') {
          throw new BadRequestException(
            'Cannot issue Debit Note against a cancelled purchase bill',
          );
        }

        // 3. Reject if source bill not yet posted
        if (sourceBill.state !== 'posted') {
          throw new BadRequestException(
            'Source bill must be in posted state to issue a Debit Note',
          );
        }

        // 4. Cumulative cap check (T-F07W3-03)
        const existingDnAggregate = await this.debitNoteModel.aggregate([
          {
            $match: {
              workspaceId,
              firmId,
              sourceBillId: (sourceBill as any)._id,
              state: 'posted',
            },
          },
          { $group: { _id: null, total: { $sum: '$grandTotalPaise' } } },
        ]);
        const alreadyReturnedPaise: number = existingDnAggregate[0]?.total ?? 0;

        // 5. Derive isIntraState the SAME way postPurchaseBill does, so the debit
        // note reverses ITC with the exact intra/inter split the bill claimed it
        // with: firm state (placeOfSupplyStateCode || stateCode) vs the supplier
        // state recorded on the bill (placeOfSupplyStateCode || partySnapshot).
        // Deriving the firm state from gstin.slice(0,2) instead could diverge when a
        // firm has a stateCode but no GSTIN, or the bill's POS lives in partySnapshot.
        const firm = await this.firmsService.findOne(workspaceId.toString(), firmId.toString());
        const firmStateCode = (firm as any).placeOfSupplyStateCode || (firm as any).stateCode;
        const partyStateCode =
          sourceBill.placeOfSupplyStateCode ||
          (sourceBill.partySnapshot as any)?.placeOfSupplyStateCode;
        const isIntraState =
          firmStateCode && partyStateCode ? firmStateCode === partyStateCode : true;

        // 6. Build sourceBill line map (keyed by itemId string) for isCapitalGoods lookup (T-F07W3-01)
        const sourceBillLineMap = new Map<string, any>();
        for (const sl of (sourceBill as any).lineItems ?? []) {
          if (sl.itemId) sourceBillLineMap.set(String(sl.itemId), sl);
        }

        // 7. Compute line totals; copy isCapitalGoods from sourceBill (T-F07W3-01 — never accept from client)
        let taxableTotal = 0;
        let cgstTotal = 0;
        let sgstTotal = 0;
        let igstTotal = 0;

        const computedLines = dto.lineItems.map((line) => {
          const qty = line.qty ?? 0;
          const rate = line.ratePaise ?? 0;
          const taxRate = line.taxRate ?? 0;
          const taxablePaise = Math.round(qty * rate);
          const cgstPaise = isIntraState ? Math.round((taxablePaise * taxRate) / 100 / 2) : 0;
          const sgstPaise = isIntraState ? Math.round((taxablePaise * taxRate) / 100 / 2) : 0;
          const igstPaise = !isIntraState ? Math.round((taxablePaise * taxRate) / 100) : 0;
          const lineTotal = taxablePaise + cgstPaise + sgstPaise + igstPaise;
          taxableTotal += taxablePaise;
          cgstTotal += cgstPaise;
          sgstTotal += sgstPaise;
          igstTotal += igstPaise;

          // Copy isCapitalGoods from source bill line — never accept from client (T-F07W3-01)
          const sourceLine = line.itemId ? sourceBillLineMap.get(String(line.itemId)) : undefined;
          const isCapitalGoods = sourceLine?.isCapitalGoods === true;

          return {
            itemId: line.itemId ? new Types.ObjectId(line.itemId) : undefined,
            itemName: line.itemName,
            hsnSacCode: line.hsnSacCode,
            qty,
            unit: line.unit,
            ratePaise: rate,
            taxRate,
            isCapitalGoods,
            taxableValuePaise: taxablePaise,
            cgstPaise,
            sgstPaise,
            igstPaise,
            lineTotalPaise: lineTotal,
          };
        });

        const grandTotal = taxableTotal + cgstTotal + sgstTotal + igstTotal;

        // 8. Cumulative cap enforcement
        if (alreadyReturnedPaise + grandTotal > (sourceBill as any).grandTotalPaise) {
          const remainingPaise = Math.max(
            0,
            (sourceBill as any).grandTotalPaise - alreadyReturnedPaise,
          );
          throw new BadRequestException(
            `Cannot exceed original purchase bill amount. Remaining returnable: ₹${(remainingPaise / 100).toFixed(2)}.`,
          );
        }

        // 9. TDS-194Q informational note (Edge Case 5 — NO auto-reversal, informational only)
        let tdsAdjustmentNote: any = undefined;
        const tds = (sourceBill as any).tds194Q;
        if (tds && tds.tdsPaise && tds.tdsPaise > 0) {
          const reversibleTdsPaise = Math.round(
            (tds.tdsPaise * grandTotal) / (sourceBill as any).grandTotalPaise,
          );
          tdsAdjustmentNote = {
            section: 'sec_194q',
            originalTdsPaise: tds.tdsPaise,
            reversibleTdsPaise,
            note: 'TDS already remitted; adjust in next payment-out manually',
          };
        }

        // 10. Persist draft
        const dn = new this.debitNoteModel({
          workspaceId,
          firmId,
          voucherType: 'debit_note',
          voucherDate: new Date(dto.voucherDate),
          // FY for the DN's OWN numbering = its own issue-date FY (Rule 46/53, GSTR-1 9B),
          // not the source bill's FY.
          financialYear: this.voucherSeriesService.getFYForDate(
            new Date(dto.voucherDate),
            (firm as any).fyStartMonth ?? 4,
          ),
          state: 'draft',
          sourceBillId: (sourceBill as any)._id,
          sourceBillNumber: (sourceBill as any).voucherNumber,
          sourceBillDate: (sourceBill as any).voucherDate,
          vendorBillRef: dto.vendorBillRef,
          sourceGrnReturnId: dto.sourceGrnReturnId
            ? new Types.ObjectId(dto.sourceGrnReturnId)
            : undefined,
          partyId: (sourceBill as any).partyId,
          partySnapshot: (sourceBill as any).partySnapshot,
          placeOfSupplyStateCode: sourceBill.placeOfSupplyStateCode,
          isIntraState,
          dnType: dto.dnType,
          vendorAccepted: dto.vendorAccepted ?? false,
          vendorAcceptedAt: dto.vendorAccepted ? new Date() : undefined,
          lineItems: computedLines,
          taxableValuePaise: taxableTotal,
          cgstPaise: isIntraState ? cgstTotal : 0,
          sgstPaise: isIntraState ? sgstTotal : 0,
          igstPaise: isIntraState ? 0 : igstTotal,
          grandTotalPaise: grandTotal,
          tdsAdjustmentNote,
          vendorItcReversalStatus: 'pending',
          narration: dto.narration,
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'create_draft' }],
        });
        await dn.save();
        // Fire-and-forget product analytics on the successful draft write (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_debit_note',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            debitNoteId: String(dn._id),
          },
        });
        return dn;
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // update (draft only)
  // ═══════════════════════════════════════════════════════════════════════════
  async update(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: UpdateDebitNoteDto,
    userId: string,
  ): Promise<DebitNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateDebitNote',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const dn = await this.debitNoteModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!dn) throw new NotFoundException('Debit Note not found');
        if (dn.state !== 'draft') {
          throw new BadRequestException('Only draft Debit Notes can be updated');
        }

        // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate
        await this.fyLock.assertOpen(workspaceId, firmId, dn.voucherDate);
        if ((dto as any).voucherDate) {
          await this.fyLock.assertOpen(workspaceId, firmId, new Date((dto as any).voucherDate));
        }

        if (dto.lineItems) {
          // Reload source bill — required for isCapitalGoods re-derivation (WR-07: throw if missing)
          const sourceBill = await this.purchaseBillModel
            .findOne({ _id: dn.sourceBillId, workspaceId, firmId, isDeleted: { $ne: true } })
            .lean();
          if (!sourceBill)
            throw new NotFoundException('Source purchase bill not found during update');

          const sourceBillLineMap = new Map<string, any>();
          for (const sl of (sourceBill as any).lineItems ?? []) {
            if (sl.itemId) sourceBillLineMap.set(String(sl.itemId), sl);
          }

          let taxableTotal = 0;
          let cgstTotal = 0;
          let sgstTotal = 0;
          let igstTotal = 0;

          const computedLines = dto.lineItems.map((line) => {
            const qty = line.qty ?? 0;
            const rate = line.ratePaise ?? 0;
            const taxRate = line.taxRate ?? 0;
            const taxablePaise = Math.round(qty * rate);
            const cgstPaise = dn.isIntraState ? Math.round((taxablePaise * taxRate) / 100 / 2) : 0;
            const sgstPaise = dn.isIntraState ? Math.round((taxablePaise * taxRate) / 100 / 2) : 0;
            const igstPaise = !dn.isIntraState ? Math.round((taxablePaise * taxRate) / 100) : 0;
            const lineTotal = taxablePaise + cgstPaise + sgstPaise + igstPaise;
            taxableTotal += taxablePaise;
            cgstTotal += cgstPaise;
            sgstTotal += sgstPaise;
            igstTotal += igstPaise;
            const sourceLine = line.itemId ? sourceBillLineMap.get(String(line.itemId)) : undefined;
            const isCapitalGoods = sourceLine?.isCapitalGoods === true;
            return {
              itemId: line.itemId ? new Types.ObjectId(line.itemId) : undefined,
              itemName: line.itemName,
              hsnSacCode: line.hsnSacCode,
              qty,
              unit: line.unit,
              ratePaise: rate,
              taxRate,
              isCapitalGoods,
              taxableValuePaise: taxablePaise,
              cgstPaise,
              sgstPaise,
              igstPaise,
              lineTotalPaise: lineTotal,
            };
          });

          const newGrandTotal = taxableTotal + cgstTotal + sgstTotal + igstTotal;

          // Re-validate cumulative cap on update (WR-02: cap was only checked at createDraft)
          await this.assertCumulativeCapNotExceeded(
            workspaceId,
            firmId,
            dn.sourceBillId,
            newGrandTotal,
            (sourceBill as any).grandTotalPaise,
            (dn as any)._id as Types.ObjectId, // exclude this DN itself from the aggregate
          );

          dn.lineItems = computedLines as any;
          dn.taxableValuePaise = taxableTotal;
          dn.cgstPaise = dn.isIntraState ? cgstTotal : 0;
          dn.sgstPaise = dn.isIntraState ? sgstTotal : 0;
          dn.igstPaise = dn.isIntraState ? 0 : igstTotal;
          dn.grandTotalPaise = newGrandTotal;
        }

        if (dto.voucherDate) dn.voucherDate = new Date(dto.voucherDate);
        if (dto.vendorBillRef !== undefined) dn.vendorBillRef = dto.vendorBillRef;
        if (dto.dnType) dn.dnType = dto.dnType;
        if (dto.vendorAccepted !== undefined) {
          dn.vendorAccepted = dto.vendorAccepted;
          if (dto.vendorAccepted) dn.vendorAcceptedAt = new Date();
        }
        if (dto.narration !== undefined) dn.narration = dto.narration;

        dn.auditLog.push({ at: new Date(), by: new Types.ObjectId(userId), action: 'update' });
        await dn.save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_debit_note',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            debitNoteId: String(dn._id),
          },
        });
        return dn;
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // post
  // ═══════════════════════════════════════════════════════════════════════════
  async post(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    userId: string,
  ): Promise<DebitNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.postDebitNote',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const dn = await this.debitNoteModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!dn) throw new NotFoundException('Debit Note not found');
        if (dn.state !== 'draft') {
          throw new BadRequestException('Only draft Debit Notes can be posted');
        }

        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, dn.voucherDate);

        // Generate voucherNumber BEFORE the transaction. generateNextNumber does not
        // participate in MongoDB sessions — calling it inside withTransaction still
        // commits the counter increment independently. By moving it outside we make
        // the intent explicit: a gap in the sequence is acceptable if the transaction
        // later fails, but duplicate numbers caused by concurrent calls are prevented
        // by the unique partial index on (workspaceId, firmId, voucherNumber, financialYear)
        // where state='posted'.
        const voucherNumber = await this.voucherSeriesService.generateNextNumber(
          firmId.toString(),
          'debit_note',
          dn.financialYear,
        );

        const session = await this.connection.startSession();
        try {
          await session.withTransaction(async () => {
            // 1. Assign pre-generated voucherNumber
            dn.voucherNumber = voucherNumber;

            // 2. Reload bill inside session for fresh outstanding values
            const bill = await this.purchaseBillModel
              .findOne({ _id: dn.sourceBillId, workspaceId, firmId, isDeleted: { $ne: true } })
              .session(session);
            if (!bill) throw new NotFoundException('Source bill not found at post time');
            if ((bill as any).state === 'cancelled') {
              throw new BadRequestException('Source bill was cancelled');
            }

            // 2b. Final cumulative cap guard inside transaction (WR-02: draft may have been
            //     inflated via update() between createDraft and post())
            const capAggregate = await this.debitNoteModel.aggregate([
              {
                $match: {
                  workspaceId,
                  firmId,
                  sourceBillId: dn.sourceBillId,
                  state: 'posted',
                },
              },
              { $group: { _id: null, total: { $sum: '$grandTotalPaise' } } },
            ]);
            const alreadyPostedPaise: number = capAggregate[0]?.total ?? 0;
            if (alreadyPostedPaise + dn.grandTotalPaise > (bill as any).grandTotalPaise) {
              const remainingPaise = Math.max(
                0,
                (bill as any).grandTotalPaise - alreadyPostedPaise,
              );
              throw new BadRequestException(
                `Cannot post Debit Note: cumulative DN amount exceeds bill total. ` +
                  `Remaining returnable: ₹${(remainingPaise / 100).toFixed(2)}.`,
              );
            }

            // 3. Post LedgerEntry
            await this.ledgerPostingService.postDebitNote(dn, {
              session,
              userId,
              firm: { _id: firmId, workspaceId },
            });

            // 4. Update PurchaseBill outstanding (bounds-check per Pitfall 4)
            const newAmountDue = Math.max(0, (bill as any).amountDuePaise - dn.grandTotalPaise);
            const newPaymentStatus = this.recomputePaymentStatus(
              (bill as any).amountPaidPaise,
              newAmountDue,
            );
            await this.purchaseBillModel.updateOne(
              { _id: (bill as any)._id },
              { $set: { amountDuePaise: newAmountDue, paymentStatus: newPaymentStatus } },
              { session },
            );

            // 5. Capital goods ITC schedule reversal (Edge Case 4 — unreleased portion only)
            // CapitalGoodsItcSchedule uses sourceLineNo (0-based index in bill.lineItems), not itemId.
            // Identify which line indices in the source bill are capital goods lines referenced by this DN.
            const billLines: any[] = (bill as any).lineItems ?? [];
            const capitalGoodsSourceLineNos: number[] = [];
            for (let i = 0; i < billLines.length; i++) {
              if (billLines[i].isCapitalGoods === true) {
                const billItemIdStr = billLines[i].itemId ? String(billLines[i].itemId) : null;
                if (
                  billItemIdStr &&
                  dn.lineItems.some(
                    (l: any) =>
                      l.isCapitalGoods === true && l.itemId && String(l.itemId) === billItemIdStr,
                  )
                ) {
                  capitalGoodsSourceLineNos.push(i);
                }
              }
            }
            if (capitalGoodsSourceLineNos.length > 0) {
              await this.capitalGoodsItcModel.updateMany(
                {
                  workspaceId,
                  firmId,
                  sourceBillId: (bill as any)._id,
                  sourceLineNo: { $in: capitalGoodsSourceLineNos },
                  status: 'amortising',
                },
                { $set: { status: 'reversed' } },
                { session },
              );
            }

            // 6. Update DN state
            dn.state = 'posted';
            dn.postedBy = new Types.ObjectId(userId);
            dn.postedAt = new Date();
            // R10: clear any prior quarantine flag on a successful post.
            dn.postingStatus = undefined;
            dn.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'post',
              after: {
                voucherNumber: dn.voucherNumber,
                capitalReversalLineNos: capitalGoodsSourceLineNos,
              },
            });
            await dn.save({ session });
          });

          // Back-populate linkedDebitNoteId on the GRN-Return (WR-05).
          // Called outside the transaction because linkDebitNote uses a plain updateOne
          // with no session. A failure here is non-fatal — the DN is already posted;
          // the GRN-Return page will just continue to show "Create Debit Note" until
          // a retry or manual reconciliation.
          if (dn.sourceGrnReturnId) {
            await this.grnReturnsService.linkDebitNote(
              workspaceId,
              firmId,
              dn.sourceGrnReturnId.toString(),
              (dn as any)._id as Types.ObjectId,
              dn.voucherNumber,
            );
          }

          // Phase 17 / FIN-16-03 — debit_note.created emit AFTER commit (D-17 non-blocking).
          try {
            this.events.emit('party.timeline', {
              type: 'debit_note.created',
              workspaceId,
              firmId,
              partyId: (dn as any).partyId,
              refModel: 'DebitNote',
              refId: (dn as any)._id,
              occurredAt: (dn as any).voucherDate ?? new Date(),
              actorUserId: userId,
              summary: `Debit Note ${(dn as any).voucherNumber}`,
              meta: {
                voucherNumber: (dn as any).voucherNumber,
                amountPaise: (dn as any).grandTotalPaise,
              },
            });
          } catch (err) {
            this.logger.warn(
              `party.timeline emit failed for debit_note.created (id=${(dn as any)._id}): ${(err as Error)?.message ?? String(err)}`,
            );
          }

          // Fire-and-forget product analytics on the successful post (ids / voucher no only).
          this.postHog?.capture({
            distinctId: userId,
            event: 'purchases.posted_debit_note',
            properties: {
              workspaceId: workspaceId.toString(),
              firmId: firmId.toString(),
              debitNoteId: String((dn as any)._id),
              voucherNumber: (dn as any).voucherNumber,
            },
          });
          return dn;
        } catch (err) {
          // R10: the transaction aborted (ledger write rolled back, DN stays draft). Flag the
          // doc 'needs_attention' in a SEPARATE write OUTSIDE the aborted session (else it would
          // roll back too), so the failed post is visible in lists for follow-up. Then rethrow.
          await this.debitNoteModel
            .updateOne(
              { _id: new Types.ObjectId(id) },
              { $set: { postingStatus: 'needs_attention' } },
            )
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
  ): Promise<DebitNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelDebitNote',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const dn = await this.debitNoteModel.findOne({
          _id: new Types.ObjectId(id),
          workspaceId,
          firmId,
        });
        if (!dn) throw new NotFoundException('Debit Note not found');
        if (dn.state !== 'posted') {
          throw new BadRequestException('Only posted Debit Notes can be cancelled');
        }

        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(workspaceId, firmId, dn.voucherDate);

        const session = await this.connection.startSession();
        try {
          await session.withTransaction(async () => {
            // 1. Find original LedgerEntry for this DN
            const originalEntry = await this.ledgerEntryModel
              .findOne({
                workspaceId,
                firmId,
                sourceVoucherId: dn._id,
                sourceVoucherType: 'debit_note',
              })
              .session(session);
            if (!originalEntry) {
              throw new NotFoundException('Original LedgerEntry not found for Debit Note');
            }

            // 2. Post reversal entry (sourceVoucherType='debit_note_reversal' — distinct)
            await this.ledgerPostingService.postDebitNoteReversal(dn, originalEntry, {
              session,
              userId,
              firm: { _id: firmId, workspaceId },
            });

            // 3. Restore PurchaseBill outstanding
            const bill = await this.purchaseBillModel
              .findOne({ _id: dn.sourceBillId, workspaceId, firmId, isDeleted: { $ne: true } })
              .session(session);
            if (bill) {
              // Cap restoration so amountDuePaise never exceeds grandTotalPaise (WR-04)
              const restoredAmountDue = Math.min(
                (bill as any).amountDuePaise + dn.grandTotalPaise,
                (bill as any).grandTotalPaise,
              );
              await this.purchaseBillModel.updateOne(
                { _id: (bill as any)._id },
                {
                  $set: {
                    amountDuePaise: restoredAmountDue,
                    paymentStatus: this.recomputePaymentStatus(
                      (bill as any).amountPaidPaise,
                      restoredAmountDue,
                    ),
                  },
                },
                { session },
              );

              // 4. Restore CapitalGoodsItcSchedule rows — reverse only what this DN's post() reversed.
              // Recover capitalGoodsSourceLineNos from the audit log (stored at post time).
              const postEntry = dn.auditLog.find((e: any) => e.action === 'post');
              const capitalGoodsSourceLineNos: number[] =
                postEntry?.after?.capitalReversalLineNos ?? [];
              if (capitalGoodsSourceLineNos.length > 0) {
                await this.capitalGoodsItcModel.updateMany(
                  {
                    workspaceId,
                    firmId,
                    sourceBillId: (bill as any)._id,
                    sourceLineNo: { $in: capitalGoodsSourceLineNos },
                    status: 'reversed',
                  },
                  { $set: { status: 'amortising' } },
                  { session },
                );
              }
            }

            // 5. Mark DN as cancelled
            dn.state = 'cancelled';
            dn.cancelledBy = new Types.ObjectId(userId);
            dn.cancelledAt = new Date();
            dn.cancellationReason = reason;
            dn.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'cancel',
              reason,
            } as any);
            await dn.save({ session });
          });
          // Fire-and-forget product analytics on the successful cancel (ids only).
          this.postHog?.capture({
            distinctId: userId,
            event: 'purchases.cancelled_debit_note',
            properties: {
              workspaceId: workspaceId.toString(),
              firmId: firmId.toString(),
              debitNoteId: String((dn as any)._id),
            },
          });
          return dn;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // findAll
  // ═══════════════════════════════════════════════════════════════════════════
  async findAll(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    query: ListDebitNotesQueryDto,
  ): Promise<{ items: DebitNote[]; total: number }> {
    const filter: any = { workspaceId, firmId, isDeleted: { $ne: true } };
    if (query.state) filter.state = query.state;
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    // R10: quarantine filter — 'needs_attention' shows failed-post follow-ups; 'clean' excludes them.
    if (query.postingStatus === 'needs_attention') filter.postingStatus = 'needs_attention';
    else if (query.postingStatus === 'clean') filter.postingStatus = { $exists: false };
    if (query.fromDate || query.toDate) {
      filter.voucherDate = {};
      if (query.fromDate) filter.voucherDate.$gte = new Date(query.fromDate);
      if (query.toDate) filter.voucherDate.$lte = new Date(query.toDate);
    }
    const limit = Math.min(query.limit ?? 50, 200);
    const skip = query.skip ?? 0;
    const [items, total] = await Promise.all([
      this.debitNoteModel.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).lean(),
      this.debitNoteModel.countDocuments(filter),
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
  ): Promise<DebitNote> {
    const dn = await this.debitNoteModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
        firmId,
        isDeleted: { $ne: true },
      })
      .lean();
    if (!dn) throw new NotFoundException('Debit Note not found');
    return dn as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // listByBill
  // ═══════════════════════════════════════════════════════════════════════════
  async listByBill(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    billId: string,
  ): Promise<DebitNote[]> {
    return (await this.debitNoteModel
      .find({
        workspaceId,
        firmId,
        sourceBillId: new Types.ObjectId(billId),
        isDeleted: { $ne: true },
      })
      .sort({ voucherDate: -1 })
      .lean()) as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validates that adding `newGrandTotalPaise` to the already-posted DNs against
   * `sourceBillId` does not exceed `billGrandTotalPaise`.
   * Pass `excludeDnId` to exclude the current DN itself from the aggregate
   * (used during update() where the DN is a draft being edited, not yet posted).
   */
  private async assertCumulativeCapNotExceeded(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    sourceBillId: Types.ObjectId,
    newGrandTotalPaise: number,
    billGrandTotalPaise: number,
    excludeDnId?: Types.ObjectId,
  ): Promise<void> {
    const matchFilter: any = {
      workspaceId,
      firmId,
      sourceBillId,
      state: 'posted',
    };
    if (excludeDnId) {
      matchFilter._id = { $ne: excludeDnId };
    }
    const aggregate = await this.debitNoteModel.aggregate([
      { $match: matchFilter },
      { $group: { _id: null, total: { $sum: '$grandTotalPaise' } } },
    ]);
    const alreadyReturnedPaise: number = aggregate[0]?.total ?? 0;

    if (alreadyReturnedPaise + newGrandTotalPaise > billGrandTotalPaise) {
      const remainingPaise = Math.max(0, billGrandTotalPaise - alreadyReturnedPaise);
      throw new BadRequestException(
        `Cannot exceed original purchase bill amount. Remaining returnable: ₹${(remainingPaise / 100).toFixed(2)}.`,
      );
    }
  }

  private recomputePaymentStatus(amountPaidPaise: number, amountDuePaise: number): string {
    if (amountDuePaise <= 0) return 'paid';
    if (amountPaidPaise > 0) return 'partial';
    return 'unpaid';
  }
}
