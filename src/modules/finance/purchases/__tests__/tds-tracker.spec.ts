import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { TdsService } from '../tds/tds.service';

// ─── Mock TdsTracker model factory ──────────────────────────────────────────

function makeTrackerModel(overrides: Partial<{
  findOneAndUpdateResult: any;
  updateOneResult: any;
}> = {}) {
  const defaultTracker = { _id: new Types.ObjectId(), cumulativePaise: 0, totalTdsDeductedPaise: 0 };
  return {
    findOneAndUpdate: vi.fn().mockResolvedValue(overrides.findOneAndUpdateResult ?? defaultTracker),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
}

// ─── Shared test fixtures ────────────────────────────────────────────────────

const wsId = new Types.ObjectId();
const firmId = new Types.ObjectId();
const partyId = new Types.ObjectId();
const session = undefined;

// ₹10Cr + 1 paise in paise (above firm AATO threshold)
const AATO_ABOVE_10CR = 10 * 10_000_000 * 100 + 1; // 10_000_000_001
// ₹50L in paise
const THRESHOLD_194Q = 50 * 100_000 * 100; // 5_000_000_00 = 5000000000 -- Wait, let me recalculate
// ₹50L = 50 * 1_00_000 = 50_00_000 rupees → 50_00_000 * 100 = 50_00_00_000 paise = 5_000_000_000

const PAISE_50L = 50 * 100_000 * 100; // 500,000,000 paise = ₹50L

// ─── TdsService.compute194Q ──────────────────────────────────────────────────

describe('TdsService.compute194Q', () => {
  it('SC-2: returns null when firm.aato <= ₹10Cr (firm not covered by 194Q)', async () => {
    const model = makeTrackerModel();
    const svc = new TdsService(model as any);

    const bill = {
      workspaceId: wsId, firmId, partyId,
      taxableValuePaise: 1_00_000_00, // ₹10L
      financialYear: '2025-26',
    };
    const firm = { aato: 9 * 10_000_000 * 100 }; // ₹9Cr — below threshold

    const result = await svc.compute194Q(bill, { pan: 'ABCDE1234F' }, firm, session);
    expect(result).toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('SC-2: returns null when partyId is absent', async () => {
    const model = makeTrackerModel();
    const svc = new TdsService(model as any);

    const bill = {
      workspaceId: wsId, firmId, partyId: undefined,
      taxableValuePaise: 1_00_000_00,
      financialYear: '2025-26',
    };

    const result = await svc.compute194Q(bill as any, { pan: 'ABCDE1234F' }, { aato: AATO_ABOVE_10CR }, session);
    expect(result).toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('SC-2: returns null when cumulative <= ₹50L after increment (below threshold)', async () => {
    const billPaise = 1_00_000_00; // ₹10L — still below ₹50L threshold
    const model = makeTrackerModel({
      findOneAndUpdateResult: {
        _id: new Types.ObjectId(),
        cumulativePaise: billPaise, // post-increment value still <= 50L
      },
    });
    const svc = new TdsService(model as any);

    const bill = { workspaceId: wsId, firmId, partyId, taxableValuePaise: billPaise, financialYear: '2025-26' };
    const result = await svc.compute194Q(bill, { pan: 'ABCDE1234F' }, { aato: AATO_ABOVE_10CR }, session);
    expect(result).toBeNull();
  });

  it('SC-2: $inc called with { cumulativePaise: taxableValuePaise } inside session', async () => {
    const billPaise = PAISE_50L + 1_00_000_00; // ₹60L → crosses threshold
    const model = makeTrackerModel({
      findOneAndUpdateResult: {
        _id: new Types.ObjectId(),
        cumulativePaise: billPaise, // post-increment
      },
    });
    const svc = new TdsService(model as any);

    const bill = { workspaceId: wsId, firmId, partyId, taxableValuePaise: billPaise, financialYear: '2025-26' };
    await svc.compute194Q(bill, { pan: 'ABCDE1234F' }, { aato: AATO_ABOVE_10CR }, session);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'sec_194q' }),
      { $inc: { cumulativePaise: billPaise } },
      expect.objectContaining({ new: true, upsert: true }),
    );
  });

  it('SC-2: first crossing: deducts TDS only on excess above ₹50L (0.1% rate with PAN)', async () => {
    // Vendor cumulative was 0, this bill is ₹60L → cumulative = ₹60L
    const billPaise = 60 * 100_000 * 100; // ₹60L in paise
    const postIncrement = billPaise; // first bill, so cumulativeAfter = billPaise
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: postIncrement },
    });
    const svc = new TdsService(model as any);

    const bill = { workspaceId: wsId, firmId, partyId, taxableValuePaise: billPaise, financialYear: '2025-26' };
    const result = await svc.compute194Q(bill, { pan: 'ABCDE1234F' }, { aato: AATO_ABOVE_10CR }, session);

    expect(result).not.toBeNull();
    expect(result!.section).toBe('sec_194q');
    expect(result!.rate).toBe(0.001);
    // excess = ₹60L - ₹50L = ₹10L in paise
    const excessPaise = postIncrement - PAISE_50L;
    expect(result!.basePaise).toBe(excessPaise);
    expect(result!.tdsPaise).toBe(Math.round(excessPaise * 0.001));
  });

  it('SC-2: subsequent bills (already crossed): TDS on full taxable value', async () => {
    // Vendor cumulative was already ₹55L, this bill adds ₹10L → cumulative = ₹65L
    const priorCumulative = 55 * 100_000 * 100; // ₹55L in paise
    const billPaise = 10 * 100_000 * 100; // ₹10L
    const postIncrement = priorCumulative + billPaise; // ₹65L
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: postIncrement },
    });
    const svc = new TdsService(model as any);

    const bill = { workspaceId: wsId, firmId, partyId, taxableValuePaise: billPaise, financialYear: '2025-26' };
    const result = await svc.compute194Q(bill, { pan: 'ABCDE1234F' }, { aato: AATO_ABOVE_10CR }, session);

    expect(result).not.toBeNull();
    // basePaise = full bill (already crossed)
    expect(result!.basePaise).toBe(billPaise);
    expect(result!.tdsPaise).toBe(Math.round(billPaise * 0.001));
  });

  it('SC-2: applies 20% rate when vendor has no PAN (Sec 206AA)', async () => {
    const billPaise = 60 * 100_000 * 100; // ₹60L
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: billPaise },
    });
    const svc = new TdsService(model as any);

    const bill = { workspaceId: wsId, firmId, partyId, taxableValuePaise: billPaise, financialYear: '2025-26' };
    const result = await svc.compute194Q(bill, { pan: undefined }, { aato: AATO_ABOVE_10CR }, session);

    expect(result).not.toBeNull();
    expect(result!.rate).toBe(0.20);
  });

  it('SC-2: findOneAndUpdate called with upsert:true to create tracker on first PB', async () => {
    const billPaise = 60 * 100_000 * 100;
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: billPaise },
    });
    const svc = new TdsService(model as any);

    const bill = { workspaceId: wsId, firmId, partyId, taxableValuePaise: billPaise, financialYear: '2025-26' };
    await svc.compute194Q(bill, { pan: 'ABCDE1234F' }, { aato: AATO_ABOVE_10CR }, session);

    const call = model.findOneAndUpdate.mock.calls[0];
    expect(call[2]).toMatchObject({ upsert: true });
  });
});

// ─── TdsService.computeAtPaymentOut ─────────────────────────────────────────

describe('TdsService.computeAtPaymentOut', () => {
  it('SC-2: returns null when supplierType is null', async () => {
    const model = makeTrackerModel();
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: null, deducteeStatus: null, pan: 'ABCDE1234F' },
      5_00_000_00, '2025-26', session,
    );
    expect(result).toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('SC-2: 194C — 1% rate for individual_huf contractor with PAN', async () => {
    const paymentPaise = 40_000 * 100; // ₹40k — single > ₹30k threshold
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'contractor', deducteeStatus: 'individual_huf', pan: 'ABCDE1234F' },
      paymentPaise, '2025-26', session,
    );

    expect(result).not.toBeNull();
    expect(result!.section).toBe('sec_194c');
    expect(result!.rate).toBe(0.01);
    expect(result!.tdsPaise).toBe(Math.round(paymentPaise * 0.01));
  });

  it('SC-2: 194C — 2% rate for company_firm contractor with PAN', async () => {
    const paymentPaise = 40_000 * 100; // ₹40k — crosses single threshold
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'contractor', deducteeStatus: 'company_firm', pan: 'ABCDE1234F' },
      paymentPaise, '2025-26', session,
    );

    expect(result).not.toBeNull();
    expect(result!.rate).toBe(0.02);
  });

  it('SC-2: 194H — 5% rate for broker with PAN (post-Oct 2024)', async () => {
    const paymentPaise = 20_000 * 100; // ₹20k — above ₹15k cumulative threshold
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'broker', deducteeStatus: null, pan: 'ABCDE1234F' },
      paymentPaise, '2025-26', session,
    );

    expect(result).not.toBeNull();
    expect(result!.section).toBe('sec_194h');
    expect(result!.rate).toBe(0.05);
  });

  it('SC-2: 194J — 10% rate for professional with PAN', async () => {
    const paymentPaise = 40_000 * 100; // ₹40k — above ₹30k threshold
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'professional', deducteeStatus: null, pan: 'ABCDE1234F' },
      paymentPaise, '2025-26', session,
    );

    expect(result).not.toBeNull();
    expect(result!.section).toBe('sec_194j');
    expect(result!.rate).toBe(0.10);
  });

  it('SC-2: 20% rate (Sec 206AA) when vendor has no PAN — any section', async () => {
    const paymentPaise = 40_000 * 100; // ₹40k crosses single threshold for 194C
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'contractor', deducteeStatus: 'individual_huf', pan: undefined },
      paymentPaise, '2025-26', session,
    );

    expect(result).not.toBeNull();
    expect(result!.rate).toBe(0.20);
  });

  it('SC-2: returns null when cumulative <= threshold and single payment <= singleThreshold (194C)', async () => {
    const paymentPaise = 20_000 * 100; // ₹20k — below ₹30k single AND post-inc cumulative ₹20k < ₹1L
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    const result = await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'contractor', deducteeStatus: 'individual_huf', pan: 'ABCDE1234F' },
      paymentPaise, '2025-26', session,
    );

    expect(result).toBeNull();
  });

  it('SC-2: uses $inc inside session for concurrent safety', async () => {
    const paymentPaise = 40_000 * 100;
    const mockSession = { id: 'test-session' } as any;
    const model = makeTrackerModel({
      findOneAndUpdateResult: { _id: new Types.ObjectId(), cumulativePaise: paymentPaise },
    });
    const svc = new TdsService(model as any);

    await svc.computeAtPaymentOut(
      wsId, firmId,
      { _id: partyId, supplierType: 'contractor', deducteeStatus: 'individual_huf', pan: 'ABCDE1234F' },
      paymentPaise, '2025-26', mockSession,
    );

    const call = model.findOneAndUpdate.mock.calls[0];
    expect(call[1]).toEqual({ $inc: { cumulativePaise: paymentPaise } });
    expect(call[2]).toMatchObject({ session: mockSession });
  });
});
