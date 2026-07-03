/**
 * Bill & Account — reconciliation acceptance gate (BILL-ACCOUNT-MODULE-PLAN §8.3 / D14).
 *
 * "The books are provably right." A seeded textile firm + a representative batch of documents
 * covering every accounting dimension (sales intra + inter-state, job-work income, a customer
 * receipt with allocation, a purchase bill with input ITC, and a credit-note sales return) are
 * posted through the REAL LedgerPostingService into a real (in-memory) Mongo. We then run the
 * REAL report services and assert they all agree:
 *
 *   - Trial balance balances (sum of debits === sum of credits) — the master invariant.
 *   - Balance sheet balances (Assets === Liabilities + Capital + retained P&L) — classification
 *     is internally consistent.
 *   - P&L net profit === (total income - total expense) derived independently from the same ledger.
 *   - Specific control accounts (debtors, sales, cash/bank, creditors, output/input GST, sales
 *     returns) carry exactly the balances the posted documents imply.
 *   - The daybook (every LedgerEntry) is present and each entry is internally balanced.
 *
 * Because every posting batch is balanced at the source (LedgerPostingService.enforceInvariant),
 * and every report reads from the single LedgerEntry journal, agreement here is the end-to-end
 * proof that the engine + reports reconcile. All amounts are in PAISE.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Types, Model, Schema as MongooseSchema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMemoryMongo, stopMemoryMongo } from '../../../../../test-utils/mongo-memory';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { FinancialStatementsService } from '../services/financial-statements.service';

// The decorator-based Account / LedgerEntry schemas carry untyped `@Prop()`s that vitest's
// reflect-metadata transform can't resolve (the repo's documented "@nestjs/mongoose decorator
// trips vitest" caveat). For this real-DB reconciliation test we register equivalent raw Mongoose
// schemas under the SAME model tokens ('Account' -> collection 'accounts', which the report
// $lookup hardcodes; 'LedgerEntry'). The posting engine and the report services share the injected
// models, so the journal they write and read is the same collection. Field shapes mirror what the
// posting writes + the reports read.
const ACCOUNT_TOKEN = 'Account';
const LEDGER_TOKEN = 'LedgerEntry';
const AccountSchemaLocal = new MongooseSchema(
  {
    workspaceId: { type: MongooseSchema.Types.ObjectId, required: true, index: true },
    firmId: { type: MongooseSchema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    code: { type: String, required: true },
    group: String,
    subGroup: String,
    type: { type: String, enum: ['asset', 'liability', 'capital', 'income', 'expense'] },
    // accountExists() filters isDeleted:false; the real schema defaults it, so mirror that
    // here or the 4009 sales-returns existence check (and others) would miss seeded accounts.
    isDeleted: { type: Boolean, default: false },
  },
  { collection: 'accounts' },
);
const LedgerLineSchemaLocal = new MongooseSchema(
  {
    accountId: MongooseSchema.Types.ObjectId,
    accountCode: String,
    accountName: String,
    debit: Number,
    credit: Number,
    partyId: MongooseSchema.Types.ObjectId,
  },
  { _id: false },
);
const LedgerEntrySchemaLocal = new MongooseSchema(
  {
    workspaceId: { type: MongooseSchema.Types.ObjectId, index: true },
    firmId: { type: MongooseSchema.Types.ObjectId, index: true },
    financialYear: String,
    entryDate: Date,
    entryType: String,
    sourceVoucherId: MongooseSchema.Types.ObjectId,
    sourceVoucherType: String,
    sourceVoucherNumber: String,
    narration: String,
    lines: [LedgerLineSchemaLocal],
    isReversed: { type: Boolean, default: false },
    postedBy: MongooseSchema.Types.ObjectId,
    postedAt: Date,
    auditLog: [{ type: MongooseSchema.Types.Mixed }],
  },
  { collection: 'ledgerentries' },
);

const wsId = new Types.ObjectId();
const firmId = new Types.ObjectId();
const partyId = new Types.ObjectId();
const FY = '2026-27';
const D = (day: number) => new Date(Date.UTC(2026, 4, day)); // May 2026 (in the FY window)
const firm = { _id: firmId, workspaceId: wsId };
const party = { _id: partyId, name: 'Surat Textiles' };

// Chart of accounts the posting methods resolve by code. type drives the P&L / balance-sheet split.
const ACCOUNTS: Array<{ code: string; name: string; type: string; subGroup?: string }> = [
  { code: '1001', name: 'Cash', type: 'asset', subGroup: 'Cash-in-hand' },
  { code: '1002', name: 'Bank', type: 'asset', subGroup: 'Bank Accounts' },
  { code: '1003', name: 'Sundry Debtors', type: 'asset', subGroup: 'Sundry Debtors' },
  { code: '1101', name: 'Input CGST', type: 'asset', subGroup: 'Duties & Taxes' },
  { code: '1102', name: 'Input SGST', type: 'asset', subGroup: 'Duties & Taxes' },
  { code: '1100', name: 'Input IGST', type: 'asset', subGroup: 'Duties & Taxes' },
  { code: '2001', name: 'Sundry Creditors', type: 'liability', subGroup: 'Sundry Creditors' },
  {
    code: '2002',
    name: 'Advance from Customers',
    type: 'liability',
    subGroup: 'Current Liabilities',
  },
  { code: '2006', name: 'Output IGST', type: 'liability', subGroup: 'Duties & Taxes' },
  { code: '2007', name: 'Output CGST', type: 'liability', subGroup: 'Duties & Taxes' },
  { code: '2008', name: 'Output SGST', type: 'liability', subGroup: 'Duties & Taxes' },
  { code: '4001', name: 'Sales', type: 'income', subGroup: 'Trading Income' },
  { code: '4009', name: 'Sales Returns', type: 'income', subGroup: 'Trading Income' },
  { code: '4020', name: 'Job Work Income', type: 'income', subGroup: 'Trading Income' },
  { code: '5001', name: 'Purchases', type: 'expense', subGroup: 'Direct Expenses' },
];

describe('Bill & Account reconciliation gate (§8.3) — books are provably right', () => {
  let moduleRef: TestingModule;
  let reports: FinancialStatementsService;
  let posting: LedgerPostingService;
  let ledgerModel: Model<any>;
  let accountModel: Model<any>;

  beforeAll(async () => {
    const uri = await startMemoryMongo();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: LEDGER_TOKEN, schema: LedgerEntrySchemaLocal },
          { name: ACCOUNT_TOKEN, schema: AccountSchemaLocal },
        ]),
      ],
      providers: [FinancialStatementsService],
    }).compile();

    reports = moduleRef.get(FinancialStatementsService);
    ledgerModel = moduleRef.get(getModelToken(LEDGER_TOKEN));
    accountModel = moduleRef.get(getModelToken(ACCOUNT_TOKEN));

    // Seed the chart of accounts.
    await accountModel.insertMany(
      ACCOUNTS.map((a) => ({ ...a, workspaceId: wsId, firmId, group: a.subGroup })),
    );

    // Real accounts service surface the posting engine needs: findByCode reads the seeded CoA so
    // the lines carry the SAME accountId the reports $lookup against (proves the join, not a mock).
    const accountsServiceStub = {
      findByCode: async (_ws: string, _firm: string, code: string) => {
        const acc = await accountModel.findOne({ firmId, code }).lean();
        if (!acc) throw new Error(`Test CoA missing account ${code}`);
        return acc;
      },
    };
    posting = new LedgerPostingService(
      ledgerModel as any,
      accountModel as any,
      accountsServiceStub as any,
    );

    // ── Post a representative document batch (all amounts in paise) ──────────
    // 1. Sale invoice, intra-state: Rs 10,000 @ 5% (CGST 250 + SGST 250) -> grand 10,500.
    await posting.postSaleInvoice(
      {
        grandTotalPaise: 1_050_000,
        taxableValuePaise: 1_000_000,
        cgstPaise: 25_000,
        sgstPaise: 25_000,
        igstPaise: 0,
        cessPaise: 0,
        tcsPaise: 0,
        roundOffPaise: 0,
      } as any,
      {
        userId: new Types.ObjectId().toString(),
        firm,
        party,
        invoice: {
          _id: new Types.ObjectId(),
          voucherNumber: 'INV-1',
          voucherType: 'sale_invoice',
          invoiceDate: D(2),
          financialYear: FY,
        },
        isIntraState: true,
      } as any,
    );

    // 2. Sale invoice, inter-state: Rs 20,000 @ 5% IGST 1,000 -> grand 21,000.
    await posting.postSaleInvoice(
      {
        grandTotalPaise: 2_100_000,
        taxableValuePaise: 2_000_000,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 100_000,
        cessPaise: 0,
        tcsPaise: 0,
        roundOffPaise: 0,
      } as any,
      {
        userId: new Types.ObjectId().toString(),
        firm,
        party,
        invoice: {
          _id: new Types.ObjectId(),
          voucherNumber: 'INV-2',
          voucherType: 'sale_invoice',
          invoiceDate: D(3),
          financialYear: FY,
        },
        isIntraState: false,
      } as any,
    );

    // 3. Job-work invoice, intra-state: Rs 5,000 general-textile @ 5% (CGST 125 + SGST 125).
    await posting.postJobWorkInvoice(
      {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        firmId,
        financialYear: FY,
        voucherDate: D(4),
        voucherNumber: 'JW-1',
        partyId,
        totalPaise: 525_000,
        subTotalPaise: 500_000,
        cgstPaise: 12_500,
        sgstPaise: 12_500,
        igstPaise: 0,
        incomeLines: [{ jobWorkType: 'general_textile', amountPaise: 500_000 }],
      } as any,
      true,
      { userId: new Types.ObjectId().toString() },
    );

    // 4. Payment in: customer pays the intra-state invoice in full (Rs 10,500) into bank.
    await posting.postPaymentIn(
      {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        firmId,
        financialYear: FY,
        receiptDate: D(6),
        partyId,
        partySnapshot: { name: party.name },
        paymentMode: 'bank',
        totalAmountPaise: 1_050_000,
        allocations: [{ allocatedPaise: 1_050_000 }],
        unappliedPaise: 0,
        voucherNumber: 'RCPT-1',
      } as any,
      { userId: new Types.ObjectId().toString(), firm },
    );

    // 5. Purchase bill, intra-state: Rs 8,000 + input CGST 200 + input SGST 200 -> creditor 8,400.
    await posting.postPurchaseBill(
      {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        firmId,
        financialYear: FY,
        voucherDate: D(8),
        voucherNumber: 'PB-1',
        partyId,
        partySnapshot: { name: 'Yarn Supplier' },
        taxableValuePaise: 800_000,
        netPayableToCreditorsAfterTdsPaise: 840_000,
        lineItems: [{ cgstPaise: 20_000, sgstPaise: 20_000, igstPaise: 0, isCapitalGoods: false }],
      } as any,
      { userId: new Types.ObjectId().toString(), firm, isIntraState: true },
    );

    // 6. Credit note (sales return) against the intra-state invoice: Rs 2,000 @ 5% -> grand 2,100.
    await posting.postCreditNote(
      {
        _id: new Types.ObjectId(),
        workspaceId: wsId,
        firmId,
        financialYear: FY,
        voucherDate: D(10),
        voucherNumber: 'CN-1',
        sourceInvoiceNumber: 'INV-1',
        partyId,
        isCommercial: false,
        isIntraState: true,
        taxableValuePaise: 200_000,
        cgstPaise: 5_000,
        sgstPaise: 5_000,
        igstPaise: 0,
        grandTotalPaise: 210_000,
      } as any,
      1_050_000, // invoiceAmountDuePaise — full reduction lands on debtors
      { userId: new Types.ObjectId().toString(), firm },
    );
  });

  afterAll(async () => {
    await moduleRef?.close();
    await stopMemoryMongo();
  });

  it('every posted LedgerEntry is internally balanced (debits === credits per batch)', async () => {
    const entries = await ledgerModel.find({ workspaceId: wsId, firmId }).lean();
    expect(entries.length).toBe(6); // the 6 documents above
    for (const e of entries as any[]) {
      const dr = e.lines.reduce((s: number, l: any) => s + l.debit, 0);
      const cr = e.lines.reduce((s: number, l: any) => s + l.credit, 0);
      expect(dr).toBe(cr);
      expect(dr).toBeGreaterThan(0);
    }
  });

  it('trial balance balances (master invariant: total debits === total credits)', async () => {
    const tb = await reports.getTrialBalance(wsId.toString(), firmId.toString(), D(1), D(28));
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebitPaise).toBe(tb.totalCreditPaise);
    expect(tb.totalDebitPaise).toBeGreaterThan(0);
  });

  it('control accounts carry exactly the balances the documents imply', async () => {
    const tb = await reports.getTrialBalance(wsId.toString(), firmId.toString(), D(1), D(28));
    const byCode = new Map(tb.rows.map((r: any) => [r.accountCode, r]));
    const net = (code: string) => {
      const r: any = byCode.get(code);
      return r ? r.closingDebitPaise - r.closingCreditPaise : 0;
    };
    // Debtors: +10,500 (INV-1) +21,000 (INV-2) +5,250 (JW-1) -10,500 (receipt) -2,100 (CN)
    // = 24,150 debit (the job-work invoice also raises a receivable on the same party).
    expect(net('1003')).toBe(2_415_000);
    // Sales gross credit: 10,000 + 20,000 = 30,000 (returns kept separate on 4009).
    expect(net('4001')).toBe(-3_000_000);
    expect(net('4009')).toBe(200_000); // sales returns sit as a debit (contra-revenue)
    expect(net('4020')).toBe(-500_000); // job-work income credit
    expect(net('1002')).toBe(1_050_000); // bank received the receipt
    expect(net('2001')).toBe(-840_000); // creditor for the purchase
    // Output GST liability: CGST 250+125=375, SGST 375, IGST 1,000; less the CN reversal (CGST/SGST -50 each).
    expect(net('2007')).toBe(-32_500); // 25,000 + 12,500 - 5,000
    expect(net('2008')).toBe(-32_500);
    expect(net('2006')).toBe(-100_000); // inter-state IGST output
    // Input ITC on the purchase.
    expect(net('1101')).toBe(20_000);
    expect(net('1102')).toBe(20_000);
  });

  it('P&L net profit === income - expense computed independently from the same ledger', async () => {
    const pl = await reports.getProfitLoss(wsId.toString(), firmId.toString(), D(1), D(28));
    // Income: sales 30,000 + JW 5,000 - returns 2,000 = 33,000. Expense: purchases 8,000.
    // Net profit = 33,000 - 8,000 = 25,000 (2,500,000 paise).
    expect(pl.netProfitPaise).toBe(2_500_000);
  });

  it('balance sheet balances (Assets === Liabilities + Capital + retained P&L)', async () => {
    const bs = await reports.getBalanceSheet(wsId.toString(), firmId.toString(), D(28));
    expect(bs.isBalanced).toBe(true);
    expect(bs.totalAssetsPaise).toBe(bs.totalLiabilitiesCapitalPaise);
  });
});
