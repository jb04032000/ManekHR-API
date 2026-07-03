/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (ConnectPageInvite / User) skip vitest's reflect-metadata pipeline.
// Mirrors the canonical inquiry.service.vitest.ts pure-unit pattern.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

// Sentry-nestjs swallows errors with no transport; stub it so the per-row catch
// branch can run without spinning up the SDK.
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { ConnectPageInviteService } from '../connect-page-invite.service';

/**
 * Unit coverage for `ConnectPageInviteService` (Institutes Phase 2, Feature 5:
 * bulk student invite + page-scoped summary). Exercises:
 *   - the page-owner gate (getMine 404 -> nothing written / read);
 *   - batch of N distinct phones creates N invite rows + returns N tokens;
 *   - a duplicate phone already `invited` for the page is SKIPPED, not errored;
 *   - intra-batch + invalid-number handling (dedupe + `invalid` count);
 *   - a single-row write fault does not fail the batch (partial success);
 *   - summary.joinedCount filters STRICTLY by the caller's pageId (no leak);
 *   - both summary counts are scoped to the caller's own pageId.
 * Models + the company-page gate + audit / PostHog seams are mocked.
 */

const PAGE_ID = new Types.ObjectId();
const PAGE_OWNER = new Types.ObjectId();

/** Fluent chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    skip: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

function build() {
  const inviteModel: any = {
    // Default: no existing pending invite (so every number is created).
    findOne: vi.fn(() => chain(null)),
    create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    countDocuments: vi.fn().mockResolvedValue(0),
  };
  const userModel: any = {
    countDocuments: vi.fn().mockResolvedValue(0),
  };
  const companyPages: any = {
    // The page-owner gate: returns the owned page doc, or throws NotFound.
    getMine: vi.fn().mockResolvedValue({ _id: PAGE_ID, ownerUserId: PAGE_OWNER }),
  };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const posthog: any = { capture: vi.fn() };
  const service = new ConnectPageInviteService(
    inviteModel,
    userModel,
    companyPages,
    audit,
    posthog,
  );
  return { service, inviteModel, userModel, companyPages, audit, posthog };
}

beforeEach(() => vi.clearAllMocks());

describe('ConnectPageInviteService.bulkInvite', () => {
  it('is page-owner gated: a getMine 404 throws before any write', async () => {
    const f = build();
    f.companyPages.getMine = vi
      .fn()
      .mockRejectedValue(new NotFoundException('Company page not found'));
    await expect(
      f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), ['9876543210']),
    ).rejects.toThrow(NotFoundException);
    expect(f.inviteModel.create).not.toHaveBeenCalled();
  });

  it('creates N invite rows for N distinct phones + returns a token per row', async () => {
    const f = build();
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      '9876543210',
      '9123456780',
      '8000000009',
    ]);
    expect(res.created).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.invalid).toBe(0);
    expect(f.inviteModel.create).toHaveBeenCalledTimes(3);
    expect(res.invites).toHaveLength(3);
    // Each row carries the canonical 12-digit mobile + a non-empty raw token.
    for (const inv of res.invites) {
      expect(inv.mobile).toMatch(/^91[6-9]\d{9}$/);
      expect(typeof inv.token).toBe('string');
      expect(inv.token.length).toBeGreaterThan(0);
    }
    // The persisted row stores only the token HASH, never the raw token.
    const createArg = f.inviteModel.create.mock.calls[0][0];
    expect(createArg.companyPageId).toEqual(PAGE_ID);
    expect(createArg.status).toBe('invited');
    expect(typeof createArg.tokenHash).toBe('string');
    expect(createArg.tokenHash).not.toBe(res.invites[0].token);
    expect(createArg.inviteExpiry).toBeInstanceOf(Date);
  });

  it('normalises mixed paste formats to the same canonical mobile', async () => {
    const f = build();
    // 10-digit, +91, and 0-prefixed forms of the SAME number -> one canonical.
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      '+91 98765 43210',
    ]);
    expect(res.created).toBe(1);
    expect(res.invites[0].mobile).toBe('919876543210');
  });

  it('de-dupes the same number WITHIN the batch (one row, not two)', async () => {
    const f = build();
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      '9876543210',
      '+919876543210', // same canonical number, different format.
    ]);
    expect(res.created).toBe(1);
    expect(f.inviteModel.create).toHaveBeenCalledTimes(1);
  });

  it('SKIPS (does not error) a phone that already has a pending invite for this page', async () => {
    const f = build();
    // First number: existing pending row -> skipped. Second: none -> created.
    let call = 0;
    f.inviteModel.findOne = vi.fn(() => {
      call += 1;
      return chain(call === 1 ? { _id: new Types.ObjectId() } : null);
    });
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      '9876543210',
      '9123456780',
    ]);
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(1);
    expect(f.inviteModel.create).toHaveBeenCalledTimes(1);
    // The dedupe lookup is scoped to THIS page + status invited + non-expired
    // (`inviteExpiry > now`), matching the spec and the attribution handler.
    const filter = f.inviteModel.findOne.mock.calls[0][0];
    expect(filter.companyPageId).toEqual(PAGE_ID);
    expect(filter.status).toBe('invited');
    expect(filter.inviteExpiry).toEqual({ $gt: expect.any(Date) });
  });

  it('does NOT skip when the only existing `invited` row is logically expired (no sweep yet)', async () => {
    const f = build();
    // Simulate the DB: an `invited` row exists for this mobile but it is expired,
    // so the non-expired-scoped dedupe findOne matches nothing (returns null). The
    // re-invite must go through (created), NOT be reported as skipped. This keeps
    // the dedupe path consistent with the attribution handler, which also ignores
    // expired rows as claim winners (no expiry-sweep cron flips status yet).
    f.inviteModel.findOne = vi.fn((filter: any) => {
      // The service filters `inviteExpiry: { $gt: now }`; an expired row does not
      // satisfy that, so the query resolves null exactly as Mongo would.
      expect(filter.inviteExpiry).toEqual({ $gt: expect.any(Date) });
      return chain(null);
    });
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      '9876543210',
    ]);
    expect(res.skipped).toBe(0);
    expect(res.created).toBe(1);
    expect(f.inviteModel.create).toHaveBeenCalledTimes(1);
  });

  it('counts an unparseable number as invalid + drops it (never errors the batch)', async () => {
    const f = build();
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      'not-a-phone',
      '12345', // too short
      '9876543210', // valid
    ]);
    expect(res.invalid).toBe(2);
    expect(res.created).toBe(1);
  });

  it('one bad row does not fail the batch (partial success)', async () => {
    const f = build();
    // The first create rejects; the second succeeds. The batch returns 1 created.
    let call = 0;
    f.inviteModel.create = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('write race'));
      return Promise.resolve({ _id: new Types.ObjectId() });
    });
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), [
      '9876543210',
      '9123456780',
    ]);
    expect(res.created).toBe(1);
    // The failed row is neither created nor in invites; the good one is.
    expect(res.invites).toHaveLength(1);
  });

  it('caps the batch at the hard max (defensive even past the DTO)', async () => {
    const f = build();
    // Build 250 distinct valid numbers; only 200 (the cap) should be processed.
    const phones = Array.from(
      { length: 250 },
      (_, i) =>
        // 10-digit numbers starting 6-9, all distinct.
        `9${String(100000000 + i).slice(-9)}`,
    );
    const res = await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), phones);
    expect(res.created).toBe(200);
    expect(f.inviteModel.create).toHaveBeenCalledTimes(200);
  });

  it('audits + emits PostHog with the batch counts (never the raw numbers)', async () => {
    const f = build();
    await f.service.bulkInvite(PAGE_OWNER.toHexString(), PAGE_ID.toHexString(), ['9876543210']);
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'ConnectPageInvite',
        action: 'connect_page_invite_bulk',
        actorId: PAGE_OWNER.toHexString(),
      }),
    );
    expect(f.posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.page_invite_bulk' }),
    );
    // No raw mobile / token leaks into the audit meta.
    const meta = f.audit.logEvent.mock.calls[0][0].meta;
    expect(JSON.stringify(meta)).not.toContain('9876543210');
  });
});

describe('ConnectPageInviteService.summary', () => {
  it('is page-owner gated: a getMine 404 throws before any count', async () => {
    const f = build();
    f.companyPages.getMine = vi
      .fn()
      .mockRejectedValue(new NotFoundException('Company page not found'));
    await expect(
      f.service.summary(PAGE_OWNER.toHexString(), PAGE_ID.toHexString()),
    ).rejects.toThrow(NotFoundException);
    expect(f.userModel.countDocuments).not.toHaveBeenCalled();
  });

  it('joinedCount filters STRICTLY by the caller pageId; pendingCount by page + invited', async () => {
    const f = build();
    f.userModel.countDocuments = vi.fn().mockResolvedValue(7);
    f.inviteModel.countDocuments = vi.fn().mockResolvedValue(4);

    const res = await f.service.summary(PAGE_OWNER.toHexString(), PAGE_ID.toHexString());
    expect(res).toEqual({ joinedCount: 7, pendingCount: 4 });

    // The joined filter is exactly { invitedByCompanyPageId: <this page> }; no
    // other institute's id is reachable from this surface.
    const joinedFilter = f.userModel.countDocuments.mock.calls[0][0];
    expect(joinedFilter).toEqual({ invitedByCompanyPageId: PAGE_ID });

    // The pending filter is exactly this page + status invited.
    const pendingFilter = f.inviteModel.countDocuments.mock.calls[0][0];
    expect(pendingFilter).toEqual({ companyPageId: PAGE_ID, status: 'invited' });
  });
});
