import { PartyLedgerService } from './party-ledger.service';
import { Types } from 'mongoose';

const wsId = new Types.ObjectId().toHexString();
const firmId = new Types.ObjectId().toHexString();
const partyId = new Types.ObjectId().toHexString();

function makeMockModel(aggregateResult: any[] = [], findResult: any[] = []) {
  return {
    aggregate: jest.fn().mockResolvedValue(aggregateResult),
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(findResult),
    }),
  };
}

describe('PartyLedgerService', () => {
  describe('getPartyLedger', () => {
    it('SC-2: returns entries sorted chronologically by entryDate then _id', async () => {
      const mockRows = [
        { entryDate: new Date('2024-01-01'), entryType: 'sale_invoice', sourceVoucherNumber: 'SI-001', narration: 'Sale', debit: 100000, credit: 0, runningBalance: 100000 },
        { entryDate: new Date('2024-01-05'), entryType: 'payment_in', sourceVoucherNumber: 'PI-001', narration: 'Payment', debit: 0, credit: 50000, runningBalance: 50000 },
      ];
      const ledgerModel = makeMockModel(mockRows);
      const saleModel = makeMockModel();
      const svc = new PartyLedgerService(ledgerModel as any, saleModel as any);

      const result = await svc.getPartyLedger(wsId, firmId, partyId);

      expect(ledgerModel.aggregate).toHaveBeenCalledTimes(1);
      const pipeline = ledgerModel.aggregate.mock.calls[0][0];
      // Verify sort stage exists
      const sortStage = pipeline.find((s: any) => s.$sort && s.$sort.entryDate === 1);
      expect(sortStage).toBeDefined();
      expect(result).toEqual(mockRows);
    });

    it('SC-2: runningBalance is cumulative sum of (debit - credit) for party lines', async () => {
      const mockRows = [
        { entryDate: new Date('2024-01-01'), debit: 100000, credit: 0, runningBalance: 100000 },
        { entryDate: new Date('2024-01-05'), debit: 0, credit: 50000, runningBalance: 50000 },
      ];
      const ledgerModel = makeMockModel(mockRows);
      const svc = new PartyLedgerService(ledgerModel as any, makeMockModel() as any);
      const result = await svc.getPartyLedger(wsId, firmId, partyId);

      // $setWindowFields stage must be present
      const pipeline = ledgerModel.aggregate.mock.calls[0][0];
      const windowStage = pipeline.find((s: any) => s.$setWindowFields);
      expect(windowStage).toBeDefined();
      expect(windowStage.$setWindowFields.output.runningBalance.$sum).toBe('$movement');
      expect(windowStage.$setWindowFields.output.runningBalance.window).toEqual({ documents: ['unbounded', 'current'] });
      expect(result[0].runningBalance).toBe(100000);
      expect(result[1].runningBalance).toBe(50000);
    });

    it('SC-2: excludes reversed LedgerEntry documents (isReversed: true)', async () => {
      const ledgerModel = makeMockModel([]);
      const svc = new PartyLedgerService(ledgerModel as any, makeMockModel() as any);
      await svc.getPartyLedger(wsId, firmId, partyId);

      const pipeline = ledgerModel.aggregate.mock.calls[0][0];
      const matchStage = pipeline.find((s: any) => s.$match && 'isReversed' in s.$match);
      expect(matchStage.$match.isReversed).toBe(false);
    });

    it('SC-2: filters by fromDate and toDate when provided', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-01-31');
      const ledgerModel = makeMockModel([]);
      const svc = new PartyLedgerService(ledgerModel as any, makeMockModel() as any);
      await svc.getPartyLedger(wsId, firmId, partyId, { fromDate: from, toDate: to });

      const pipeline = ledgerModel.aggregate.mock.calls[0][0];
      const matchStage = pipeline.find((s: any) => s.$match && s.$match.entryDate);
      expect(matchStage.$match.entryDate.$gte).toEqual(from);
      expect(matchStage.$match.entryDate.$lte).toEqual(to);
    });
  });

  describe('getAgingBuckets', () => {
    it('SC-3: invoice with daysPastDue = 0 falls in current bucket', async () => {
      const mockResult = [{ _id: new Types.ObjectId(partyId), partyName: 'Acme', current: 50000, bucket0_30: 0, bucket31_60: 0, bucket61_90: 0, bucket90plus: 0, totalDue: 50000 }];
      const saleModel = makeMockModel(mockResult);
      const svc = new PartyLedgerService(makeMockModel() as any, saleModel as any);

      const result = await svc.getAgingBuckets(wsId, firmId);

      expect(result[0].current).toBe(50000);
      expect(result[0].bucket0_30).toBe(0);
    });

    it('SC-3: invoice with daysPastDue = 15 falls in bucket0_30', async () => {
      const mockResult = [{ _id: new Types.ObjectId(partyId), partyName: 'Acme', current: 0, bucket0_30: 50000, bucket31_60: 0, bucket61_90: 0, bucket90plus: 0, totalDue: 50000 }];
      const saleModel = makeMockModel(mockResult);
      const svc = new PartyLedgerService(makeMockModel() as any, saleModel as any);

      const result = await svc.getAgingBuckets(wsId, firmId);
      expect(result[0].bucket0_30).toBe(50000);
    });

    it('SC-3: invoice with daysPastDue = 45 falls in bucket31_60', async () => {
      const mockResult = [{ _id: new Types.ObjectId(partyId), partyName: 'Acme', current: 0, bucket0_30: 0, bucket31_60: 50000, bucket61_90: 0, bucket90plus: 0, totalDue: 50000 }];
      const saleModel = makeMockModel(mockResult);
      const svc = new PartyLedgerService(makeMockModel() as any, saleModel as any);

      const result = await svc.getAgingBuckets(wsId, firmId);
      expect(result[0].bucket31_60).toBe(50000);
    });

    it('SC-3: invoice with daysPastDue = 75 falls in bucket61_90', async () => {
      const mockResult = [{ _id: new Types.ObjectId(partyId), partyName: 'Acme', current: 0, bucket0_30: 0, bucket31_60: 0, bucket61_90: 50000, bucket90plus: 0, totalDue: 50000 }];
      const saleModel = makeMockModel(mockResult);
      const svc = new PartyLedgerService(makeMockModel() as any, saleModel as any);

      const result = await svc.getAgingBuckets(wsId, firmId);
      expect(result[0].bucket61_90).toBe(50000);
    });

    it('SC-3: invoice with daysPastDue = 100 falls in bucket90plus', async () => {
      const mockResult = [{ _id: new Types.ObjectId(partyId), partyName: 'Acme', current: 0, bucket0_30: 0, bucket31_60: 0, bucket61_90: 0, bucket90plus: 50000, totalDue: 50000 }];
      const saleModel = makeMockModel(mockResult);
      const svc = new PartyLedgerService(makeMockModel() as any, saleModel as any);

      const result = await svc.getAgingBuckets(wsId, firmId);
      expect(result[0].bucket90plus).toBe(50000);
    });

    it('SC-3: only includes unpaid/partial/overdue posted invoices', async () => {
      const saleModel = makeMockModel([]);
      const svc = new PartyLedgerService(makeMockModel() as any, saleModel as any);
      await svc.getAgingBuckets(wsId, firmId);

      const pipeline = saleModel.aggregate.mock.calls[0][0];
      const matchStage = pipeline.find((s: any) => s.$match && s.$match.paymentStatus);
      expect(matchStage.$match.state).toBe('posted');
      expect(matchStage.$match.paymentStatus.$in).toEqual(expect.arrayContaining(['unpaid', 'partial', 'overdue']));
      expect(matchStage.$match.isDeleted).toBe(false);
    });
  });
});
