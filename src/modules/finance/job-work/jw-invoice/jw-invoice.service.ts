import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { JobWorkInvoice, JobWorkInvoiceDocument } from './jw-invoice.schema';
import { Firm } from '../../firms/firm.schema';
import { Party } from '../../parties/party.schema';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { KarigarLinkageService } from '../karigar-linkage/karigar-linkage.service';
import { CreateJwInvoiceDto } from './dto/create-jw-invoice.dto';
import { UpdateJwInvoiceDto } from './dto/update-jw-invoice.dto';
import { ListJwInvoiceDto } from './dto/list-jw-invoice.dto';
import { resolveJobWorkRate } from './job-work-rate';
import {
  gstHalves,
  igstPaise,
  effectiveRateCentiPaise,
  lineAmountPaise,
  ratePaiseFromCentiPaise,
} from '../../common/precision';

@Injectable()
export class JwInvoiceService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel(JobWorkInvoice.name)
    private readonly invoiceModel: Model<JobWorkInvoiceDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,
    @InjectModel(Party.name)
    private readonly partyModel: Model<Party>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntry>,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly karigarLinkageService: KarigarLinkageService,
  ) {}

  /**
   * D-19: called by JWO post (Plan 04) to auto-create draft invoice.
   * Also used internally by create() for manual creation.
   * taxRate derived from jobWorkType per resolveJobWorkRate(); hsnCode LOCKED to '9988'.
   */
  async createDraft(args: {
    workspaceId: Types.ObjectId;
    firmId: Types.ObjectId;
    partyId: Types.ObjectId;
    jwOutwardChallanId: Types.ObjectId;
    jwOutwardChallanNo?: string;
    voucherDate: Date;
    placeOfSupplyStateCode: string;
    lines: {
      description: string;
      qty: number;
      unit: string;
      ratePaise?: number;
      rateCentiPaise?: number;
      jobWorkType?: string;
      jobWorkLotId?: Types.ObjectId;
      karigarIds?: Types.ObjectId[];
    }[];
    karigarIds: Types.ObjectId[];
    machineIds?: Types.ObjectId[];
    narration?: string;
    userId: string;
    session?: ClientSession;
  }): Promise<JobWorkInvoiceDocument> {
    const fy = this.voucherSeriesService.getFYForDate(args.voucherDate);
    const doc = new this.invoiceModel({
      workspaceId: args.workspaceId,
      firmId: args.firmId,
      voucherType: 'job_work_invoice',
      voucherNumber: '',
      voucherDate: args.voucherDate,
      status: 'draft',
      partyId: args.partyId,
      jwOutwardChallanId: args.jwOutwardChallanId,
      jwOutwardChallanNo: args.jwOutwardChallanNo,
      placeOfSupplyStateCode: args.placeOfSupplyStateCode,
      reverseCharge: false,
      lines: args.lines.map((l, i) => ({
        lineNo: i + 1,
        description: l.description,
        hsnCode: '9988', // LOCKED per D-04
        jobWorkType: (l as any).jobWorkType ?? 'general_textile',
        qty: l.qty,
        unit: l.unit,
        rateCentiPaise: (l as any).rateCentiPaise,
        ratePaise:
          (l as any).rateCentiPaise != null
            ? ratePaiseFromCentiPaise((l as any).rateCentiPaise)
            : (l.ratePaise ?? 0),
        taxRate: resolveJobWorkRate((l as any).jobWorkType),
        amountPaise: lineAmountPaise(
          l.qty ?? 0,
          effectiveRateCentiPaise({
            rateCentiPaise: (l as any).rateCentiPaise,
            ratePaise: l.ratePaise ?? 0,
          }),
        ),
        jobWorkLotId: l.jobWorkLotId,
        karigarIds: l.karigarIds ?? [],
      })),
      subTotalPaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      cessAmountPaise: 0,
      roundOffPaise: 0,
      totalPaise: 0,
      karigarIds: args.karigarIds,
      machineIds: args.machineIds ?? [],
      ledgerEntryIds: [],
      paymentStatus: 'unpaid',
      paidAmountPaise: 0,
      financialYear: fy,
      narration: args.narration,
      isDeleted: false,
      createdBy: new Types.ObjectId(args.userId),
    });
    return args.session ? doc.save({ session: args.session }) : doc.save();
  }

  /**
   * Standard create — manual draft creation via REST endpoint.
   */
  async create(
    wsId: string,
    firmId: string,
    userId: string,
    dto: CreateJwInvoiceDto,
  ): Promise<JobWorkInvoiceDocument> {
    return this.createDraft({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      partyId: new Types.ObjectId(dto.partyId),
      jwOutwardChallanId: new Types.ObjectId(dto.jwOutwardChallanId),
      voucherDate: dto.voucherDate,
      placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
      lines: dto.lines.map((l) => ({
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        ratePaise: l.ratePaise,
        rateCentiPaise: l.rateCentiPaise, // forward 4dp precision (was dropped here)
        jobWorkType: (l as any).jobWorkType,
        jobWorkLotId: l.jobWorkLotId ? new Types.ObjectId(l.jobWorkLotId) : undefined,
        karigarIds: l.karigarIds?.map((id) => new Types.ObjectId(id)),
      })),
      karigarIds: (dto.karigarIds ?? []).map((id) => new Types.ObjectId(id)),
      machineIds: dto.machineIds?.map((id) => new Types.ObjectId(id)),
      narration: dto.narration,
      userId,
    });
  }

  async list(wsId: string, firmId: string, q: ListJwInvoiceDto) {
    const filter: any = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (q.partyId) filter.partyId = new Types.ObjectId(q.partyId);
    if (q.status) filter.status = q.status;
    if (q.paymentStatus) filter.paymentStatus = q.paymentStatus;
    // R10: surface the quarantine bucket. 'needs_attention' returns failed-post drafts;
    // 'clean' returns everything not flagged. Mirrors SaleInvoice (D23).
    if (q.postingStatus === 'needs_attention') filter.postingStatus = 'needs_attention';
    else if (q.postingStatus === 'clean') filter.postingStatus = { $exists: false };
    if (q.dateFrom || q.dateTo) {
      filter.voucherDate = {};
      if (q.dateFrom) filter.voucherDate.$gte = q.dateFrom;
      if (q.dateTo) filter.voucherDate.$lte = q.dateTo;
    }
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const [items, total] = await Promise.all([
      this.invoiceModel
        .find(filter)
        .sort({ voucherDate: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .populate('partyId', 'name gstin')
        .exec(),
      this.invoiceModel.countDocuments(filter),
    ]);
    return { items, total, page, pageSize };
  }

  async get(wsId: string, firmId: string, id: string): Promise<JobWorkInvoiceDocument> {
    const doc = await this.invoiceModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .populate('partyId', 'name gstin address state')
      .exec();
    if (!doc) throw new NotFoundException('JW Invoice not found');
    return doc;
  }

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateJwInvoiceDto,
  ): Promise<JobWorkInvoiceDocument> {
    const doc = await this.get(wsId, firmId, id);
    if (doc.status !== 'draft') throw new BadRequestException('Only draft invoice can be edited');

    if (dto.lines) {
      (doc as any).lines = dto.lines.map((l, i) => ({
        lineNo: i + 1,
        description: l.description ?? '',
        hsnCode: '9988', // LOCKED
        jobWorkType: (l as any).jobWorkType ?? 'general_textile',
        qty: l.qty ?? 0,
        unit: l.unit ?? '',
        rateCentiPaise: (l as any).rateCentiPaise,
        ratePaise:
          (l as any).rateCentiPaise != null
            ? ratePaiseFromCentiPaise((l as any).rateCentiPaise)
            : (l.ratePaise ?? 0),
        taxRate: resolveJobWorkRate((l as any).jobWorkType),
        amountPaise: lineAmountPaise(
          l.qty ?? 0,
          effectiveRateCentiPaise({
            rateCentiPaise: (l as any).rateCentiPaise,
            ratePaise: l.ratePaise ?? 0,
          }),
        ),
        jobWorkLotId: l.jobWorkLotId ? new Types.ObjectId(l.jobWorkLotId) : undefined,
        karigarIds: l.karigarIds?.map((id) => new Types.ObjectId(id)) ?? [],
      }));
    }
    if (dto.placeOfSupplyStateCode !== undefined)
      doc.placeOfSupplyStateCode = dto.placeOfSupplyStateCode;
    if (dto.reverseCharge !== undefined) doc.reverseCharge = dto.reverseCharge;
    if (dto.dueDate !== undefined) doc.dueDate = dto.dueDate;
    if (dto.narration !== undefined) doc.narration = dto.narration;
    if (dto.karigarIds !== undefined)
      (doc as any).karigarIds = dto.karigarIds.map((id) => new Types.ObjectId(id));
    if (dto.machineIds !== undefined)
      (doc as any).machineIds = dto.machineIds.map((id) => new Types.ObjectId(id));
    return doc.save();
  }

  /**
   * D-04: Post invoice - assign voucherNumber, compute taxes, create LedgerEntry.
   * RESEARCH Pitfall 5: rejects if any line has ratePaise === 0.
   * taxRate derived from jobWorkType per resolveJobWorkRate(); hsnCode LOCKED to '9988'.
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<JobWorkInvoiceDocument> {
    const session = await this.conn.startSession();
    session.startTransaction();
    try {
      const invoice = await this.invoiceModel
        .findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          status: 'draft',
          isDeleted: false,
        })
        .session(session);
      if (!invoice) throw new NotFoundException('Invoice not in draft');

      // RESEARCH Pitfall 5: validate all lines have ratePaise > 0
      const zeroRateLines = invoice.lines.filter((l) => !l.ratePaise || l.ratePaise === 0);
      if (zeroRateLines.length > 0) {
        throw new BadRequestException('All invoice lines must have a rate before posting');
      }

      // Recompute amounts - taxRate derived from jobWorkType, hsnCode LOCKED to '9988'
      (invoice as any).lines = invoice.lines.map((l) => ({
        ...(l.toObject?.() ?? l),
        taxRate: resolveJobWorkRate((l as any).jobWorkType),
        hsnCode: '9988',
        rateCentiPaise: (l as any).rateCentiPaise,
        ratePaise:
          (l as any).rateCentiPaise != null
            ? ratePaiseFromCentiPaise((l as any).rateCentiPaise)
            : l.ratePaise,
        amountPaise: lineAmountPaise(
          l.qty,
          effectiveRateCentiPaise({
            rateCentiPaise: (l as any).rateCentiPaise,
            ratePaise: l.ratePaise,
          }),
        ),
      }));

      const subTotal = invoice.lines.reduce((s, l) => s + l.amountPaise, 0);
      invoice.subTotalPaise = subTotal;

      // Load firm for state code (first 2 chars of GSTIN = state code)
      const firm = await this.firmModel.findById(invoice.firmId).session(session);
      if (!firm) throw new NotFoundException('Firm not found');

      // Derive firm state code from GSTIN (e.g. "24ACIFA..." → "24")
      const firmStateCode = (firm as any).gstin ? String((firm as any).gstin).substring(0, 2) : '';
      const isIntrastate = firmStateCode !== '' && firmStateCode === invoice.placeOfSupplyStateCode;

      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      for (const l of invoice.lines) {
        if (isIntrastate) {
          const halves = gstHalves(l.amountPaise, l.taxRate);
          cgst += halves.cgstPaise;
          sgst += halves.sgstPaise;
        } else {
          igst += igstPaise(l.amountPaise, l.taxRate);
        }
      }
      const taxAmt = cgst + sgst + igst;
      invoice.cgstPaise = cgst;
      invoice.sgstPaise = sgst;
      invoice.igstPaise = igst;
      invoice.totalPaise = subTotal + taxAmt;

      // Assign voucher number from VoucherSeries
      const fy = this.voucherSeriesService.getFYForDate(
        invoice.voucherDate,
        (firm as any).fyStartMonth ?? 4,
      );
      invoice.voucherNumber = await this.voucherSeriesService.generateNextNumber(
        String(invoice.firmId),
        'job_work_invoice',
        fy,
      );
      invoice.financialYear = fy;
      invoice.status = 'posted';
      invoice.postingStatus = undefined; // R10: this post succeeded - clear any prior needs_attention
      await invoice.save({ session });

      // Double-entry ledger posting via LedgerPostingService
      const ledgerEntry = await this.ledgerPostingService.postJobWorkInvoice(
        {
          _id: invoice._id,
          workspaceId: invoice.workspaceId,
          firmId: invoice.firmId,
          financialYear: invoice.financialYear,
          voucherDate: invoice.voucherDate,
          voucherNumber: invoice.voucherNumber,
          partyId: invoice.partyId,
          narration: invoice.narration,
          totalPaise: invoice.totalPaise,
          subTotalPaise: invoice.subTotalPaise,
          cgstPaise: invoice.cgstPaise,
          sgstPaise: invoice.sgstPaise,
          igstPaise: invoice.igstPaise,
          // Split job-work income by activity (D13/§4): dyeing/printing -> 4021, other -> 4024,
          // general -> 4020 (falls back to 4020 when a process ledger isn't seeded).
          incomeLines: invoice.lines.map((l) => ({
            jobWorkType: l.jobWorkType,
            amountPaise: l.amountPaise,
          })),
        },
        isIntrastate,
        { session, userId },
      );

      // Link ledger entry ID back onto invoice
      invoice.ledgerEntryIds = [ledgerEntry._id];

      // Create KarigarLinkage if karigars assigned at invoice level
      if (invoice.karigarIds && invoice.karigarIds.length > 0) {
        await this.karigarLinkageService.createBulk({
          workspaceId: invoice.workspaceId,
          firmId: invoice.firmId,
          voucher: {
            _id: invoice._id,
            voucherType: 'job_work_invoice',
            voucherDate: invoice.voucherDate,
          },
          karigarIds: invoice.karigarIds,
          machineIds: invoice.machineIds ?? undefined,
          session,
        });
      }

      await invoice.save({ session });
      await session.commitTransaction();
      return invoice;
    } catch (err) {
      await session.abortTransaction();
      // R10: the transaction rolled back (doc stays draft), so flag the failed post with a
      // SEPARATE write OUTSIDE the aborted session/transaction - else it would roll back too.
      // Best-effort: swallow its own error so we still surface the original failure. Mirrors
      // SaleInvoice (D23). Cleared on a later successful post.
      await this.invoiceModel
        .updateOne({ _id: new Types.ObjectId(id) }, { $set: { postingStatus: 'needs_attention' } })
        .catch(() => undefined);
      throw err;
    } finally {
      session.endSession();
    }
  }

  /**
   * D-04 cancel path: only posted invoices can be cancelled.
   * Posts reversal LedgerEntry (full audit trail — original entry NOT deleted).
   */
  async cancel(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<JobWorkInvoiceDocument> {
    const session = await this.conn.startSession();
    session.startTransaction();
    try {
      const invoice = await this.invoiceModel
        .findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          status: 'posted',
          isDeleted: false,
        })
        .session(session);
      if (!invoice) throw new NotFoundException('Invoice not posted (or not found)');

      const originalEntry = await this.ledgerEntryModel
        .findById(invoice.ledgerEntryIds[0])
        .session(session);
      if (!originalEntry) throw new NotFoundException('Original ledger entry missing');

      const reversal = await this.ledgerPostingService.reverseJobWorkInvoice(
        originalEntry,
        {
          _id: invoice._id,
          voucherNumber: invoice.voucherNumber,
        },
        { session, userId },
      );

      invoice.ledgerEntryIds.push(reversal._id);
      invoice.status = 'cancelled';
      await invoice.save({ session });

      await session.commitTransaction();
      return invoice;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }
}
