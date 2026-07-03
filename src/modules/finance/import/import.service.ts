import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PartiesService } from '../parties/parties.service';
import { AccountsService } from '../ledger/accounts.service';
import { OpeningBalanceService } from '../sales/ledger-posting/opening-balance.service';
import { ItemsService } from '../items/items.service';
import { LedgerPostingService } from '../sales/ledger-posting/ledger-posting.service';
import { LedgerLine } from '../sales/ledger-posting/ledger-entry.schema';
import { FyLockService } from '../fiscal-year/fy-lock.service';
import { OpeningInvoice } from './opening-invoice.schema';
import { validateGstin } from '../gstin/gstin-validator';

// D19 onboarding import. Step 1 (this file): parties. The wizard maps the user's Excel/CSV columns
// to these party fields client-side, then calls validate (dry-run) and commit. Opening balances,
// item masters and pending invoices are the remaining D19 entities (build on this same pattern).
// Links: PartiesService (persistence + dedup source), gstin-validator (offline GSTIN check).

const VALID_PARTY_TYPES = ['customer', 'vendor', 'broker', 'transporter', 'employee_advance'];

export type RawPartyRow = Record<string, string | undefined>;
export type ImportRowStatus = 'valid' | 'error' | 'duplicate';

export interface MappedParty {
  name: string;
  partyType: string;
  gstin?: string;
  pan?: string;
  state?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface PartyRowResult {
  index: number;
  status: ImportRowStatus;
  error?: string;
  party?: MappedParty;
}

export interface PartyImportDryRun {
  summary: { total: number; valid: number; errors: number; duplicates: number };
  rows: PartyRowResult[];
}

export type RawImportRow = Record<string, string | undefined>;

export interface OpeningBalanceRowResult {
  index: number;
  status: ImportRowStatus;
  error?: string;
  ob?: {
    accountId: string;
    accountCode: string;
    accountName: string;
    amountPaise: number;
    drOrCr: string;
    asOfDate: string;
  };
}

export interface OpeningBalanceDryRun {
  summary: {
    total: number;
    valid: number;
    errors: number;
    duplicates: number;
    // R9: net amount (debits - credits across valid rows) that will post to 3004 Opening Balance
    // Equity - the plug that balances the opening trial balance. A large/unexpected figure usually
    // means a missing or mis-keyed row, so the wizard surfaces it instead of letting it silently
    // pile into 3004. Positive = net debit to equity, negative = net credit.
    netToOpeningEquityPaise: number;
  };
  rows: OpeningBalanceRowResult[];
}

export interface MappedItem {
  name: string;
  itemType: string;
  unit: string;
  hsnSacCode?: string;
  gstRate?: number;
  category?: string;
}

export interface ItemRowResult {
  index: number;
  status: ImportRowStatus;
  error?: string;
  item?: MappedItem;
}

export interface ItemImportDryRun {
  summary: { total: number; valid: number; errors: number; duplicates: number };
  rows: ItemRowResult[];
}

export interface MappedBill {
  partyId: string;
  partyName: string;
  voucherNumber: string;
  voucherDate: string;
  dueDate?: string;
  amountPaise: number;
}

export interface PendingInvoiceRowResult {
  index: number;
  status: ImportRowStatus;
  error?: string;
  bill?: MappedBill;
}

export interface PendingInvoiceDryRun {
  summary: { total: number; valid: number; errors: number; duplicates: number };
  rows: PendingInvoiceRowResult[];
}

// R9: commit-time failure detail. A row can pass dry-run validation yet fail at write time (the
// period lock guard rejects its date, a DB write errors). Commits no longer abort the whole batch
// on one bad row - they record the failure here and continue. Re-running an import is safe (the
// dedup checks skip already-created rows), so a partial commit is resumable.
export interface CommitRowFailure {
  index: number;
  error: string;
}

export interface ImportCommitResult {
  created: number;
  skipped: number;
  failed: CommitRowFailure[];
}

@Injectable()
export class ImportService {
  constructor(
    private readonly parties: PartiesService,
    private readonly accounts: AccountsService,
    private readonly openingBalance: OpeningBalanceService,
    private readonly items: ItemsService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly fyLock: FyLockService,
    @InjectModel(OpeningInvoice.name)
    private readonly openingInvoiceModel: Model<OpeningInvoice>,
  ) {}

  // Indian FY (Apr-Mar) label, e.g. 2026-27, from a YYYY-MM-DD date string.
  private deriveFy(dateStr: string): string {
    const d = new Date(dateStr);
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-${String(y + 1).slice(2)}`;
  }

  // Dedup key: name (case-insensitive) + GSTIN (upper). Two parties with the same name but
  // different GSTIN are distinct; a blank GSTIN dedups on name alone.
  private key(name: string, gstin?: string): string {
    return `${name.trim().toLowerCase()}|${(gstin ?? '').trim().toUpperCase()}`;
  }

  /**
   * Dry-run a parties import: validate + classify every row WITHOUT writing. The wizard shows this
   * report (valid / error / duplicate per row) so the user fixes the file before committing.
   */
  async validateParties(
    wsId: string,
    firmId: string,
    rows: RawPartyRow[],
  ): Promise<PartyImportDryRun> {
    const existing = await this.parties.findAll(wsId, firmId);
    const existingKeys = new Set(
      existing.items.map((p) => this.key(p.name, (p as { gstin?: string }).gstin)),
    );
    const seen = new Set<string>();

    const results: PartyRowResult[] = rows.map((row, index) => {
      const name = (row.name ?? '').trim();
      const partyType = (row.partyType ?? 'customer').trim().toLowerCase();
      const gstin = (row.gstin ?? '').trim() || undefined;

      if (!name) return { index, status: 'error', error: 'Name is required' };
      if (!VALID_PARTY_TYPES.includes(partyType)) {
        return {
          index,
          status: 'error',
          error: `Invalid party type "${partyType}" (allowed: ${VALID_PARTY_TYPES.join(', ')})`,
        };
      }
      if (gstin && !validateGstin(gstin).valid) {
        return { index, status: 'error', error: 'Invalid GSTIN (format / check digit)' };
      }

      const k = this.key(name, gstin);
      if (seen.has(k)) {
        return { index, status: 'duplicate', error: 'Duplicate of an earlier row in this file' };
      }
      seen.add(k);
      if (existingKeys.has(k)) {
        return {
          index,
          status: 'duplicate',
          error: 'A party with this name + GSTIN already exists',
        };
      }

      return {
        index,
        status: 'valid',
        party: {
          name,
          partyType,
          gstin,
          pan: (row.pan ?? '').trim() || undefined,
          state: (row.state ?? '').trim() || undefined,
          phone: (row.phone ?? '').trim() || undefined,
          email: (row.email ?? '').trim() || undefined,
          address: (row.address ?? '').trim() || undefined,
        },
      };
    });

    return {
      summary: {
        total: rows.length,
        valid: results.filter((r) => r.status === 'valid').length,
        errors: results.filter((r) => r.status === 'error').length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
      },
      rows: results,
    };
  }

  /**
   * Commit a parties import: re-validate server-side (never trust the client's dry-run) and create
   * only the rows that pass. Error/duplicate rows are skipped. Returns created/skipped counts.
   */
  async commitParties(
    wsId: string,
    firmId: string,
    rows: RawPartyRow[],
  ): Promise<ImportCommitResult> {
    const dry = await this.validateParties(wsId, firmId, rows);
    let created = 0;
    const failed: CommitRowFailure[] = [];
    for (const r of dry.rows) {
      if (r.status === 'valid' && r.party) {
        // R9: per-row try/catch so one bad row doesn't abort the batch (re-run dedups).
        try {
          await this.parties.create(wsId, firmId, r.party);
          created++;
        } catch (e) {
          failed.push({ index: r.index, error: e instanceof Error ? e.message : 'create failed' });
        }
      }
    }
    return { created, skipped: dry.rows.length - created, failed };
  }

  // ─── opening balances ───────────────────────────────────────────────────────
  // D19 entity 2: account opening balances (trial-balance carry-forward). Resolve each account by
  // code, then post through OpeningBalanceService (lock-aware, zero-sum, contra 3004).

  async validateOpeningBalances(
    wsId: string,
    firmId: string,
    rows: RawImportRow[],
  ): Promise<OpeningBalanceDryRun> {
    const accounts = await this.accounts.findAll(wsId, firmId);
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const seen = new Set<string>();

    const results: OpeningBalanceRowResult[] = rows.map((row, index) => {
      const accountCode = (row.accountCode ?? '').trim();
      const drOrCr = (row.drOrCr ?? '').trim().toLowerCase();
      const asOfDate = (row.asOfDate ?? '').trim();
      const amount = Number((row.amount ?? '').trim());

      if (!accountCode) return { index, status: 'error', error: 'Account code is required' };
      const acc = byCode.get(accountCode);
      if (!acc) return { index, status: 'error', error: `No account with code "${accountCode}"` };
      if (drOrCr !== 'debit' && drOrCr !== 'credit') {
        return { index, status: 'error', error: 'Dr/Cr must be "debit" or "credit"' };
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return { index, status: 'error', error: 'Amount must be a positive number' };
      }
      if (!asOfDate || Number.isNaN(Date.parse(asOfDate))) {
        return { index, status: 'error', error: 'A valid as-of date (YYYY-MM-DD) is required' };
      }
      if (seen.has(accountCode)) {
        return { index, status: 'duplicate', error: 'Account repeated earlier in this file' };
      }
      seen.add(accountCode);

      return {
        index,
        status: 'valid',
        ob: {
          accountId: String((acc as unknown as { _id: unknown })._id),
          accountCode,
          accountName: acc.name,
          amountPaise: Math.round(amount * 100),
          drOrCr,
          asOfDate: asOfDate.slice(0, 10),
        },
      };
    });

    // R9: net plug that will land in 3004 Opening Balance Equity (debit rows add, credit rows
    // subtract). Surfaced in the dry-run so the user can sanity-check it before committing.
    const netToOpeningEquityPaise = results.reduce((net, r) => {
      if (r.status !== 'valid' || !r.ob) return net;
      return net + (r.ob.drOrCr === 'debit' ? r.ob.amountPaise : -r.ob.amountPaise);
    }, 0);

    return {
      summary: {
        total: rows.length,
        valid: results.filter((r) => r.status === 'valid').length,
        errors: results.filter((r) => r.status === 'error').length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
        netToOpeningEquityPaise,
      },
      rows: results,
    };
  }

  async commitOpeningBalances(
    wsId: string,
    firmId: string,
    rows: RawImportRow[],
    userId: string,
  ): Promise<ImportCommitResult> {
    const dry = await this.validateOpeningBalances(wsId, firmId, rows);
    let created = 0;
    const failed: CommitRowFailure[] = [];
    for (const r of dry.rows) {
      if (r.status === 'valid' && r.ob) {
        // R9: setOpeningBalance already enforces the period lock (assertOpen) internally; the
        // per-row try/catch turns a locked-period or DB failure into a recorded row failure
        // instead of aborting the whole batch.
        try {
          await this.openingBalance.setOpeningBalance(
            wsId,
            firmId,
            r.ob.accountId,
            {
              amountPaise: r.ob.amountPaise,
              drOrCr: r.ob.drOrCr as 'debit' | 'credit',
              asOfDate: r.ob.asOfDate,
            },
            userId,
          );
          created++;
        } catch (e) {
          failed.push({ index: r.index, error: e instanceof Error ? e.message : 'post failed' });
        }
      }
    }
    return { created, skipped: dry.rows.length - created, failed };
  }

  // ─── item masters ─────────────────────────────────────────────────────────
  // D19 entity 3: item/product master. Validate + dedup by name (in-file + in-DB), create via
  // ItemsService. itemType defaults to goods, unit to NOS, when the column is blank.

  async validateItems(
    wsId: string,
    firmId: string,
    rows: RawImportRow[],
  ): Promise<ItemImportDryRun> {
    const existing = await this.items.findAll(wsId, firmId);
    const existingNames = new Set(existing.map((i) => i.name.trim().toLowerCase()));
    const seen = new Set<string>();

    const results: ItemRowResult[] = rows.map((row, index) => {
      const name = (row.name ?? '').trim();
      const itemType = (row.itemType ?? 'goods').trim().toLowerCase();
      const unit = (row.unit ?? '').trim() || 'NOS';
      const hsnSacCode = (row.hsnSacCode ?? '').trim() || undefined;
      const gstRaw = (row.gstRate ?? '').trim();
      const category = (row.category ?? '').trim() || undefined;

      if (!name) return { index, status: 'error', error: 'Name is required' };
      if (itemType !== 'goods' && itemType !== 'services') {
        return { index, status: 'error', error: 'Type must be "goods" or "services"' };
      }
      if (hsnSacCode && !/^[0-9]{4,8}$/.test(hsnSacCode)) {
        return { index, status: 'error', error: 'HSN/SAC must be 4-8 digits' };
      }
      let gstRate: number | undefined;
      if (gstRaw) {
        gstRate = Number(gstRaw);
        if (![0, 5, 12, 18, 28].includes(gstRate)) {
          return { index, status: 'error', error: 'GST rate must be one of 0, 5, 12, 18, 28' };
        }
      }
      const k = name.toLowerCase();
      if (seen.has(k)) {
        return { index, status: 'duplicate', error: 'Duplicate item name earlier in this file' };
      }
      seen.add(k);
      if (existingNames.has(k)) {
        return { index, status: 'duplicate', error: 'An item with this name already exists' };
      }

      return {
        index,
        status: 'valid',
        item: { name, itemType, unit, hsnSacCode, gstRate, category },
      };
    });

    return {
      summary: {
        total: rows.length,
        valid: results.filter((r) => r.status === 'valid').length,
        errors: results.filter((r) => r.status === 'error').length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
      },
      rows: results,
    };
  }

  async commitItems(
    wsId: string,
    firmId: string,
    rows: RawImportRow[],
  ): Promise<ImportCommitResult> {
    const dry = await this.validateItems(wsId, firmId, rows);
    let created = 0;
    const failed: CommitRowFailure[] = [];
    for (const r of dry.rows) {
      if (r.status === 'valid' && r.item) {
        // R9: per-row try/catch so one bad row doesn't abort the batch (re-run dedups).
        try {
          await this.items.create(wsId, firmId, r.item);
          created++;
        } catch (e) {
          failed.push({ index: r.index, error: e instanceof Error ? e.message : 'create failed' });
        }
      }
    }
    return { created, skipped: dry.rows.length - created, failed };
  }

  // ─── pending invoices (bill-wise opening AR) ────────────────────────────────
  // D19 entity 4: pre-onboarding outstanding bills. Each row references an EXISTING party (import
  // parties first). Stored in the SEPARATE OpeningInvoice collection (never SaleInvoice -> cannot
  // leak into sales/GST/revenue) + posted Dr Debtors (with partyId) / Cr 3004 Opening Equity, so
  // total AR via the ledger is correct. No revenue, no GST: that was in the old books.

  async validatePendingInvoices(
    wsId: string,
    firmId: string,
    rows: RawImportRow[],
  ): Promise<PendingInvoiceDryRun> {
    const parties = await this.parties.findAll(wsId, firmId);
    const partyByName = new Map(parties.items.map((p) => [p.name.trim().toLowerCase(), p]));
    const existing = await this.openingInvoiceModel
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .select('partyId voucherNumber')
      .lean();
    const existingKeys = new Set(
      existing.map((b) => `${String(b.partyId)}|${String(b.voucherNumber).toLowerCase()}`),
    );
    const seen = new Set<string>();

    const results: PendingInvoiceRowResult[] = rows.map((row, index) => {
      const partyName = (row.party ?? '').trim();
      const voucherNumber = (row.voucherNumber ?? '').trim();
      const voucherDate = (row.voucherDate ?? '').trim();
      const dueDate = (row.dueDate ?? '').trim();
      const amount = Number((row.amount ?? '').trim());

      if (!partyName) return { index, status: 'error', error: 'Party name is required' };
      const party = partyByName.get(partyName.toLowerCase()) as
        | { _id: unknown; name: string }
        | undefined;
      if (!party) {
        return {
          index,
          status: 'error',
          error: `No party named "${partyName}" - import parties first`,
        };
      }
      if (!voucherNumber) {
        return { index, status: 'error', error: 'Invoice / bill number is required' };
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return { index, status: 'error', error: 'Amount must be a positive number' };
      }
      if (!voucherDate || Number.isNaN(Date.parse(voucherDate))) {
        return { index, status: 'error', error: 'A valid invoice date (YYYY-MM-DD) is required' };
      }
      if (dueDate && Number.isNaN(Date.parse(dueDate))) {
        return { index, status: 'error', error: 'Invalid due date' };
      }

      const k = `${String(party._id)}|${voucherNumber.toLowerCase()}`;
      if (seen.has(k)) {
        return {
          index,
          status: 'duplicate',
          error: 'Duplicate bill number for this party in the file',
        };
      }
      seen.add(k);
      if (existingKeys.has(k)) {
        return { index, status: 'duplicate', error: 'This bill already exists' };
      }

      return {
        index,
        status: 'valid',
        bill: {
          partyId: String(party._id),
          partyName: party.name,
          voucherNumber,
          voucherDate: voucherDate.slice(0, 10),
          dueDate: dueDate ? dueDate.slice(0, 10) : undefined,
          amountPaise: Math.round(amount * 100),
        },
      };
    });

    return {
      summary: {
        total: rows.length,
        valid: results.filter((r) => r.status === 'valid').length,
        errors: results.filter((r) => r.status === 'error').length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
      },
      rows: results,
    };
  }

  async commitPendingInvoices(
    wsId: string,
    firmId: string,
    rows: RawImportRow[],
    userId: string,
  ): Promise<ImportCommitResult> {
    const dry = await this.validatePendingInvoices(wsId, firmId, rows);
    if (dry.summary.valid === 0) return { created: 0, skipped: dry.rows.length, failed: [] };

    const debtors = await this.accounts.findByCode(wsId, firmId, '1003');
    const equity = await this.accounts.findByCode(wsId, firmId, '3004');

    let created = 0;
    const failed: CommitRowFailure[] = [];
    for (const r of dry.rows) {
      if (r.status === 'valid' && r.bill) {
        const b = r.bill;
        const fy = this.deriveFy(b.voucherDate);
        // R9: per-row try/catch makes the batch resilient (one bad row no longer aborts the rest;
        // re-running dedups). The whole posting (ledger + tracking doc) is inside the try.
        try {
          // R9: postManualJournal has NO internal period-lock guard, so the opening-AR import
          // could write into a filed/locked period. Enforce the same lock every voucher path hits.
          await this.fyLock.assertOpen(
            new Types.ObjectId(wsId),
            new Types.ObjectId(firmId),
            new Date(b.voucherDate),
          );
          const lines: LedgerLine[] = [
            {
              accountId: debtors._id,
              accountCode: '1003',
              accountName: debtors.name,
              debit: b.amountPaise,
              credit: 0,
              partyId: new Types.ObjectId(b.partyId),
            },
            {
              accountId: equity._id,
              accountCode: '3004',
              accountName: equity.name,
              debit: 0,
              credit: b.amountPaise,
            },
          ];
          const entry = await this.ledgerPosting.postManualJournal(
            {
              workspaceId: new Types.ObjectId(wsId),
              firmId: new Types.ObjectId(firmId),
              financialYear: fy,
              entryDate: new Date(b.voucherDate),
              sourceVoucherType: 'opening_invoice',
              sourceVoucherNumber: b.voucherNumber,
              narration: `Opening outstanding ${b.voucherNumber} - ${b.partyName}`,
              lines,
            },
            { userId },
          );
          await this.openingInvoiceModel.create({
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
            partyId: new Types.ObjectId(b.partyId),
            partyName: b.partyName,
            voucherNumber: b.voucherNumber,
            voucherDate: new Date(b.voucherDate),
            dueDate: b.dueDate ? new Date(b.dueDate) : undefined,
            amountPaise: b.amountPaise,
            ledgerEntryId: (entry as { _id?: Types.ObjectId })._id,
            financialYear: fy,
          });
          created++;
        } catch (e) {
          failed.push({ index: r.index, error: e instanceof Error ? e.message : 'post failed' });
        }
      }
    }
    return { created, skipped: dry.rows.length - created, failed };
  }
}
