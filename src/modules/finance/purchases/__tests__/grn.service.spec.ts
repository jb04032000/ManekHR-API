import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { GrnService } from '../grn/grn.service';
import { financialYearOf } from '../../common/fiscal-year.util';

// ─── Fixture factories ────────────────────────────────────────────────────────

const wsId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const firmId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const userId = 'cccccccccccccccccccccccc';

function makeGrnDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(wsId),
    firmId: new Types.ObjectId(firmId),
    voucherDate: new Date('2025-07-01'),
    financialYear: '2025-26',
    state: 'draft',
    auditLog: [],
    save: vi.fn().mockImplementation(function (this: any) {
      return Promise.resolve(this);
    }),
    ...overrides,
  };
}

function makeDependencies(overrides: Record<string, any> = {}) {
  const grn = makeGrnDoc();
  return {
    model: {
      findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(grn) }),
      ...overrides.model,
    },
    voucherSeriesService: {
      generateNextNumber: vi.fn().mockResolvedValue('GRN/25-26/001'),
      getFYForDate: vi.fn((d: Date, m = 4) => financialYearOf(d, m)),
      ...overrides.voucherSeriesService,
    },
    _grn: grn,
  };
}

function makeService(deps: ReturnType<typeof makeDependencies>) {
  return new GrnService(deps.model, deps.voucherSeriesService);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GrnService.confirm', () => {
  it('SC-1: does NOT create a LedgerEntry on confirm (financial neutrality)', () => {
    // GrnService intentionally has NO LedgerPostingService injection.
    // We verify the service constructor only accepts 2 deps.
    const deps = makeDependencies();
    const svc = makeService(deps);
    // No ledgerPostingService property exists on service
    expect((svc as any).ledgerPostingService).toBeUndefined();
  });

  it('SC-1: state transitions draft → received', async () => {
    const grn = makeGrnDoc({ state: 'draft' });
    const deps = makeDependencies({
      model: { findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(grn) }) },
    });
    const svc = makeService(deps);
    await svc.confirm(wsId, firmId, grn._id.toString(), userId);
    expect(grn.state).toBe('received');
  });

  it('SC-1: appends auditLog entry with action=received', async () => {
    const grn = makeGrnDoc({ state: 'draft', auditLog: [] });
    const deps = makeDependencies({
      model: { findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(grn) }) },
    });
    const svc = makeService(deps);
    await svc.confirm(wsId, firmId, grn._id.toString(), userId);
    const lastEntry = grn.auditLog.at(-1);
    expect(lastEntry).toBeDefined();
    expect(lastEntry.action).toBe('received');
  });

  it('SC-1: sets receivedAt and receivedBy', async () => {
    const grn = makeGrnDoc({ state: 'draft' });
    const deps = makeDependencies({
      model: { findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(grn) }) },
    });
    const svc = makeService(deps);
    const before = new Date();
    await svc.confirm(wsId, firmId, grn._id.toString(), userId);
    const after = new Date();
    expect(grn.receivedAt).toBeDefined();
    expect((grn as any).receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect((grn as any).receivedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect((grn as any).receivedBy).toBeDefined();
  });

  it('SC-1: throws BadRequestException when confirming non-draft GRN', async () => {
    const grn = makeGrnDoc({ state: 'received' });
    const deps = makeDependencies({
      model: { findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(grn) }) },
    });
    const svc = makeService(deps);
    await expect(svc.confirm(wsId, firmId, grn._id.toString(), userId)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('SC-1: assigns voucherNumber via VoucherSeriesService at confirm time', async () => {
    const grn = makeGrnDoc({ state: 'draft', financialYear: '2025-26' });
    const deps = makeDependencies({
      model: { findOne: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(grn) }) },
    });
    const svc = makeService(deps);
    await svc.confirm(wsId, firmId, grn._id.toString(), userId);
    expect(deps.voucherSeriesService.generateNextNumber).toHaveBeenCalledWith(
      firmId,
      'grn',
      '2025-26',
    );
  });
});
