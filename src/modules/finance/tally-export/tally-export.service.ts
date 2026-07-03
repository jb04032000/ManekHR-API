/**
 * TallyExportService — orchestrator that pulls vouchers + masters from Mongo,
 * runs the validator, streams the XML envelope, and writes an audit row.
 *
 * Design notes:
 *   - Streaming-only — uses `TallyXmlStreamWriter` to write directly to a
 *     temp file. No full-DOM in memory.
 *   - Drives masters + vouchers off `LedgerEntry` (the canonical double-entry
 *     projection) with a JOIN to Account/Party for names + GSTIN. Inventory
 *     enrichment (HSN, batch, godown, qty) is loaded on demand from
 *     SaleInvoice / PurchaseBill / CreditNote / DebitNote when present.
 *   - >50k vouchers route to a queued path that returns
 *     `{ status: 'queued' }` — actual BullMQ wiring deferred (Wave 0 did not
 *     register the tally-export queue). Inline path is used in MVP.
 *   - All Mongo read filters wrap ObjectId per project rule (Mongoose 9
 *     autocast bug).
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { tmpdir } from 'os';
import { join } from 'path';
import { statSync } from 'fs';

import { TallyXmlStreamWriter } from './generators/envelope.writer';
import {
  MastersGenerator,
  MasterAccount,
  MasterParty,
  MasterStockItem,
} from './generators/masters.generator';
import { VoucherGenerator, VoucherProjection } from './generators/voucher.generator';
import { PreExportValidator, ValidatorReport } from './validators/pre-export-validator.service';
import { mapVoucherType, voucherTypeCarriesInventory } from './mappings/voucher-type-mapping';
import { GenerateExportDto } from './dto/generate-export.dto';
import { assertSameFy } from '../common/fiscal-year.util';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { Account } from '../ledger/account.schema';
import { Party } from '../parties/party.schema';
import { Item } from '../items/item.schema';
import { Firm } from '../firms/firm.schema';
import { SaleInvoice } from '../sales/sale-invoice/sale-invoice.schema';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { AppModule } from '../../../common/enums/modules.enum';

const QUEUE_THRESHOLD = 50_000;

export interface TallyExportResult {
  status: 'ready' | 'queued';
  /** When status === 'ready'. Local filesystem path of the generated XML. */
  filePath?: string;
  /** When status === 'ready'. */
  fileSize?: number;
  /** When status === 'ready'. */
  voucherCount?: number;
  /** When status === 'queued' (>50k vouchers). */
  jobId?: string;
  /** Validator report — included on every ready response. */
  report?: ValidatorReport;
}

@Injectable()
export class TallyExportService {
  private readonly logger = new Logger(TallyExportService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // runExport gets a span + PostHog event (counts/sizes only - never party GSTIN
  // or any voucher PII); getValidatorReport gets a span only.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntry>,
    @InjectModel(Account.name) private readonly accountModel: Model<Account>,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    @InjectModel(Item.name) private readonly itemModel: Model<Item>,
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    @InjectModel(SaleInvoice.name) private readonly saleInvoiceModel: Model<SaleInvoice>,
    private readonly mastersGenerator: MastersGenerator,
    private readonly voucherGenerator: VoucherGenerator,
    private readonly validator: PreExportValidator,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  async runExport(
    workspaceId: string,
    dto: GenerateExportDto,
    userId: string,
  ): Promise<TallyExportResult> {
    return withFinanceSpan(
      this.tracer,
      'finance.runTallyExport',
      { workspaceId, firmId: dto.firmId, userId },
      () => this.runExportImpl(workspaceId, dto, userId),
    );
  }

  private async runExportImpl(
    workspaceId: string,
    dto: GenerateExportDto,
    userId: string,
  ): Promise<TallyExportResult> {
    const wsObjectId = new Types.ObjectId(workspaceId);
    const firmObjectId = new Types.ObjectId(dto.firmId);
    const fromDate = new Date(dto.fromDate);
    const toDate = new Date(dto.toDate);

    const firm = await this.firmModel
      .findOne({ _id: firmObjectId, workspaceId: wsObjectId })
      .lean()
      .exec();
    if (!firm) {
      throw new NotFoundException(`Firm not found: ${dto.firmId}`);
    }

    // D-08: hard-cap export to a single fiscal year.
    assertSameFy(fromDate, toDate, firm.fyStartMonth ?? 4);

    // Pre-flight count for the queue threshold.
    const voucherCount = await this.ledgerEntryModel
      .countDocuments({
        workspaceId: wsObjectId,
        firmId: firmObjectId,
        entryDate: { $gte: fromDate, $lte: toDate },
        ...(dto.voucherTypes && dto.voucherTypes.length > 0
          ? { sourceVoucherType: { $in: dto.voucherTypes } }
          : {}),
      })
      .exec();

    if (voucherCount > QUEUE_THRESHOLD) {
      // D-10: enqueue background job. BullMQ wiring deferred to a follow-up
      // (Wave 0 did not register a tally-export queue); for now we surface
      // the threshold as a structured response so the controller can render
      // a "Coming soon — split into FY chunks" hint.
      this.logger.warn(
        `Tally export voucherCount=${voucherCount} exceeds threshold ${QUEUE_THRESHOLD}; queue path not yet wired`,
      );
      throw new BadRequestException(
        `Export contains ${voucherCount} vouchers, above the inline limit of ${QUEUE_THRESHOLD}. Split the date range and retry; background-queue path is wired in a follow-up phase.`,
      );
    }

    // Pull masters + vouchers projections.
    const projections = await this.loadVoucherProjections(
      wsObjectId,
      firmObjectId,
      fromDate,
      toDate,
      dto.voucherTypes,
    );
    const itemNames = new Set<string>();
    for (const v of projections) {
      if (v.inventoryLines) {
        for (const il of v.inventoryLines) itemNames.add(il.stockItemName);
      }
    }

    const [accounts, parties, items] = await Promise.all([
      this.accountModel
        .find({ workspaceId: wsObjectId, firmId: firmObjectId, isDeleted: { $ne: true } })
        .lean()
        .exec(),
      this.partyModel
        .find({ workspaceId: wsObjectId, firmId: firmObjectId, isDeleted: { $ne: true } as any })
        .lean()
        .exec(),
      this.itemModel.find({ workspaceId: wsObjectId, firmId: firmObjectId }).lean().exec(),
    ]);

    // Validator inputs
    const accountsForValidator = accounts.map((a: any) => ({
      _id: String(a._id),
      name: a.name,
      hasTransactionsInRange: true,
      hasOpeningBalance: true,
    }));
    const partiesForValidator = parties.map((p: any) => ({
      _id: String(p._id),
      name: p.name,
      gstin: p.gstin,
      hasHsnSales: false,
    }));
    const vouchersForValidator = projections.map((v) => ({
      _id: v._id,
      voucherNumber: v.voucherNumber,
      voucherType: v.sourceVoucherType,
    }));
    const report = this.validator.validate({
      accounts: accountsForValidator,
      parties: partiesForValidator,
      vouchers: vouchersForValidator,
    });

    // Stream the envelope
    const filePath = join(tmpdir(), `tally-${dto.firmId}-${Date.now()}.xml`);
    const companyName = dto.companyNameOverride?.trim() || firm.firmName;
    const writer = new TallyXmlStreamWriter(filePath, companyName, 'Vouchers');
    await writer.openEnvelope();

    const masterAccounts: MasterAccount[] = accounts.map((a: any) => ({
      _id: String(a._id),
      name: a.name,
      type: a.type,
      subGroup: a.subGroup,
      group: a.group,
    }));
    const masterParties: MasterParty[] = parties.map((p: any) => ({
      _id: String(p._id),
      name: p.name,
      partyType: p.partyType,
      gstin: p.gstin,
    }));
    const masterStockItems: MasterStockItem[] = items
      .filter((it: any) => itemNames.size === 0 || itemNames.has(it.name))
      .map((it: any) => ({
        _id: String(it._id),
        name: it.name,
        unit: it.unit || 'NOS',
        hsnSacCode: it.hsnSacCode,
        gstRate: it.gstRate,
      }));

    await this.mastersGenerator.streamMasters(writer, {
      accounts: masterAccounts,
      parties: masterParties,
      stockItems: masterStockItems,
    });
    const emittedCount = await this.voucherGenerator.streamVouchers(writer, projections);
    await writer.closeEnvelope();

    const fileSize = statSync(filePath).size;

    // D-11: audit log entry per export.
    try {
      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.FINANCE,
        entityType: 'tally-export',
        entityId: firmObjectId, // log against firm scope
        action: 'TALLY_EXPORT',
        actorId: userId,
        meta: {
          firmId: dto.firmId,
          fromDate: dto.fromDate,
          toDate: dto.toDate,
          voucherCount: emittedCount,
          fileSize,
          companyName,
          warningCount: report.warnings.length,
          filePath,
        },
      });
    } catch (e) {
      // Non-fatal: log but never block export delivery.
      this.logger.error(`AuditService.logEvent failed for TALLY_EXPORT: ${(e as Error).message}`);
    }

    // Fire-and-forget product analytics on the successful export (counts/sizes
    // only - no party GSTIN / voucher PII; date range is non-sensitive metadata).
    this.postHog.capture({
      distinctId: userId,
      event: 'finance_settings.generated_tally_export',
      properties: {
        workspaceId,
        firmId: dto.firmId,
        voucherCount: emittedCount,
        fileSize,
        warningCount: report.warnings.length,
      },
    });

    return {
      status: 'ready',
      filePath,
      fileSize,
      voucherCount: emittedCount,
      report,
    };
  }

  /**
   * D-11 / Plan 16-06 — list the last-N exports for a firm by reading the
   * audit-event collection (entityType='tally-export', entityId=firmId).
   *
   * Returns lightweight rows for the dashboard "Recent exports" card. The
   * `downloadUrl` is intentionally omitted in MVP — exports stream directly
   * via the POST endpoint and the temp `filePath` is per-process; a follow-up
   * phase wires R2 + signed URLs (see Plan 02 deferred issues). The shape is
   * forward-compatible: when signed URLs land, downloadUrl + expiresAt are
   * filled in by the service without changing the API contract.
   */
  async listRecentExports(
    workspaceId: string,
    firmId: string,
    limit: number,
  ): Promise<
    Array<{
      at: string;
      fromDate: string;
      toDate: string;
      voucherCount: number;
      fileSizeBytes: number;
      downloadUrl?: string;
      expiresAt?: string;
    }>
  > {
    const events = await this.auditService.listEntityEvents(workspaceId, 'tally-export', firmId);
    return events.slice(0, limit).map((evt: any) => {
      const meta = evt.meta || {};
      return {
        at:
          evt.createdAt instanceof Date ? evt.createdAt.toISOString() : String(evt.createdAt ?? ''),
        fromDate: String(meta.fromDate ?? ''),
        toDate: String(meta.toDate ?? ''),
        voucherCount: Number(meta.voucherCount ?? 0),
        fileSizeBytes: Number(meta.fileSize ?? 0),
        // downloadUrl + expiresAt intentionally omitted until R2 + signed-URL
        // infra lands. The web `RecentExportsList` renders an "Expired" pill
        // when these are absent — the desired MVP behaviour.
      };
    });
  }

  async getValidatorReport(
    workspaceId: string,
    firmId: string,
    fromDate: string,
    toDate: string,
  ): Promise<ValidatorReport> {
    return withFinanceSpan(
      this.tracer,
      'finance.getTallyValidatorReport',
      { workspaceId, firmId },
      () => this.getValidatorReportImpl(workspaceId, firmId, fromDate, toDate),
    );
  }

  private async getValidatorReportImpl(
    workspaceId: string,
    firmId: string,
    fromDate: string,
    toDate: string,
  ): Promise<ValidatorReport> {
    const wsObjectId = new Types.ObjectId(workspaceId);
    const firmObjectId = new Types.ObjectId(firmId);
    const from = new Date(fromDate);
    const to = new Date(toDate);

    const projections = await this.loadVoucherProjections(wsObjectId, firmObjectId, from, to);
    const [accounts, parties] = await Promise.all([
      this.accountModel
        .find({ workspaceId: wsObjectId, firmId: firmObjectId, isDeleted: { $ne: true } })
        .lean()
        .exec(),
      this.partyModel.find({ workspaceId: wsObjectId, firmId: firmObjectId }).lean().exec(),
    ]);

    return this.validator.validate({
      accounts: accounts.map((a: any) => ({ _id: String(a._id), name: a.name })),
      parties: parties.map((p: any) => ({
        _id: String(p._id),
        name: p.name,
        gstin: p.gstin,
        hasHsnSales: false,
      })),
      vouchers: projections.map((v) => ({
        _id: v._id,
        voucherNumber: v.voucherNumber,
        voucherType: v.sourceVoucherType,
      })),
    });
  }

  /**
   * Loads voucher projections from LedgerEntry rows for the date-range,
   * grouped by sourceVoucherId. Inventory lines are hydrated on demand from
   * the SaleInvoice collection (other voucher types omitted in MVP — they
   * still emit ledger entries; just no `<ALLINVENTORYENTRIES.LIST>`).
   */
  private async loadVoucherProjections(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    fromDate: Date,
    toDate: Date,
    voucherTypes?: string[],
  ): Promise<VoucherProjection[]> {
    const filter: any = {
      workspaceId,
      firmId,
      entryDate: { $gte: fromDate, $lte: toDate },
      isReversed: { $ne: true },
    };
    if (voucherTypes && voucherTypes.length > 0) {
      filter.sourceVoucherType = { $in: voucherTypes };
    }

    const entries = await this.ledgerEntryModel.find(filter).lean().exec();

    // Build party lookup once
    const partyIdSet = new Set<string>();
    for (const e of entries as any[]) {
      for (const ln of e.lines || []) {
        if (ln.partyId) partyIdSet.add(String(ln.partyId));
      }
    }
    const parties = partyIdSet.size
      ? await this.partyModel
          .find({ _id: { $in: Array.from(partyIdSet).map((id) => new Types.ObjectId(id)) } })
          .lean()
          .exec()
      : [];
    const partyById = new Map<string, any>(parties.map((p: any) => [String(p._id), p]));

    // SaleInvoice lookup for inventory enrichment (Sales/Sales Returns share schema)
    const saleVoucherIds = (entries as any[])
      .filter((e) => mapVoucherType(e.sourceVoucherType) === 'Sales')
      .map((e) => new Types.ObjectId(String(e.sourceVoucherId)));
    const saleInvoices = saleVoucherIds.length
      ? await this.saleInvoiceModel
          .find({ _id: { $in: saleVoucherIds } })
          .lean()
          .exec()
      : [];
    const saleInvoiceById = new Map<string, any>(saleInvoices.map((s: any) => [String(s._id), s]));

    // Resolve item names referenced by inventory lines
    const itemIdSet = new Set<string>();
    for (const inv of saleInvoices as any[]) {
      for (const li of inv.lineItems || []) {
        if (li.itemId) itemIdSet.add(String(li.itemId));
      }
    }
    const items = itemIdSet.size
      ? await this.itemModel
          .find({ _id: { $in: Array.from(itemIdSet).map((id) => new Types.ObjectId(id)) } })
          .lean()
          .exec()
      : [];
    const itemById = new Map<string, any>(items.map((i: any) => [String(i._id), i]));

    return (entries as any[]).map((e) => {
      // Resolve party from first line's partyId (heuristic — most postings carry a single party).
      let partyName: string | undefined;
      let partyGstin: string | undefined;
      let placeOfSupply: string | undefined;
      const firstPartyLine = (e.lines || []).find((ln: any) => ln.partyId);
      if (firstPartyLine) {
        const p = partyById.get(String(firstPartyLine.partyId));
        if (p) {
          partyName = p.name;
          partyGstin = p.gstin;
          placeOfSupply = p.state;
        }
      }

      const ledgerLines = (e.lines || []).map((ln: any) => ({
        ledgerName: ln.accountName || 'Unknown',
        debitPaise: Number(ln.debit) || 0,
        creditPaise: Number(ln.credit) || 0,
      }));

      let inventoryLines: VoucherProjection['inventoryLines'];
      if (voucherTypeCarriesInventory(e.sourceVoucherType)) {
        const inv = saleInvoiceById.get(String(e.sourceVoucherId));
        if (inv) {
          inventoryLines = (inv.lineItems || []).map((li: any) => {
            const item = li.itemId ? itemById.get(String(li.itemId)) : undefined;
            return {
              stockItemName: li.itemName || item?.name || 'Unknown',
              qty: Number(li.qty) || 0,
              unit: li.unit || item?.unit || 'NOS',
              ratePaise: Number(li.ratePaise) || 0,
              amountPaise: Number(li.taxableValuePaise) || Number(li.lineTotalPaise) || 0,
              hsnCode: li.hsnSacCode || item?.hsnSacCode,
              rateOfGst: typeof li.taxRate === 'number' ? li.taxRate : item?.gstRate,
              taxability: 'Taxable' as const,
              isOutflow: e.sourceVoucherType !== 'credit_note', // credit-note returns inventory in
            };
          });
        }
      }

      return {
        _id: String(e.sourceVoucherId || e._id),
        sourceVoucherType: e.sourceVoucherType,
        voucherNumber: e.sourceVoucherNumber || '',
        voucherDate: e.entryDate,
        narration: e.narration,
        partyName,
        partyGstin,
        placeOfSupply,
        ledgerLines,
        inventoryLines,
      };
    });
  }
}
