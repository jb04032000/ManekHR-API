/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators before importing the service (the transitive
// TeamMember schema import would otherwise trip vitest's reflection pipeline).
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

import { ForbiddenException } from '@nestjs/common';
import { SalaryWriteGuardService } from '../salary-write-guard.service';

// Valid 24-char ObjectId hex strings — assertMemberWritable casts via new
// Types.ObjectId, which rejects non-hex inputs.
const WS = '5f8d04b3b54764421b7156aa';
const TM1 = '5f8d04b3b54764421b7156b1';
const TM2 = '5f8d04b3b54764421b7156b2';

/**
 * Workstream G hardening — SalaryWriteGuardService covers two cross-cutting
 * write gates: OQ-S2 SoD self-edit block and OQ-S5 MEMBER_OFFBOARDED write-lock.
 */
function makeService(opts: { member?: any } = { member: { isDeleted: false } }) {
  const teamModel = {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(opts.member ?? null),
    }),
  };
  const callerScope = { resolve: vi.fn() };
  const service = new SalaryWriteGuardService(teamModel as any, callerScope as any);
  return { service, callerScope, teamModel };
}

describe('SalaryWriteGuardService.assertNotSelfSalaryEdit (OQ-S2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks a non-owner editing their own record', async () => {
    const { service, callerScope } = makeService();
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: TM1 });
    await expect(service.assertNotSelfSalaryEdit(WS, 'u', TM1)).rejects.toThrow(ForbiddenException);
  });

  it('allows a non-owner editing another member', async () => {
    const { service, callerScope } = makeService();
    callerScope.resolve.mockResolvedValue({ isOwner: false, teamMemberId: TM1 });
    await expect(service.assertNotSelfSalaryEdit(WS, 'u', TM2)).resolves.toBeUndefined();
  });

  it('allows the owner editing their own record (bypass)', async () => {
    const { service, callerScope } = makeService();
    callerScope.resolve.mockResolvedValue({ isOwner: true, teamMemberId: TM1 });
    await expect(service.assertNotSelfSalaryEdit(WS, 'u', TM1)).resolves.toBeUndefined();
  });
});

describe('SalaryWriteGuardService.assertMemberWritable (OQ-S5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a write against a present, non-deleted member', async () => {
    const { service } = makeService({ member: { _id: TM1, isDeleted: false } });
    await expect(service.assertMemberWritable(WS, TM1)).resolves.toBeUndefined();
  });

  it('blocks a write against a soft-deleted (removed) member with MEMBER_OFFBOARDED', async () => {
    const { service } = makeService({ member: { _id: TM1, isDeleted: true } });
    await expect(service.assertMemberWritable(WS, TM1)).rejects.toMatchObject({
      response: { code: 'MEMBER_OFFBOARDED' },
    });
  });

  it('blocks a write when the member row is missing entirely', async () => {
    const { service } = makeService({ member: null });
    await expect(service.assertMemberWritable(WS, TM1)).rejects.toThrow(ForbiddenException);
  });

  it('honours the allowOffboarded carve-out (F&F / final-month lock)', async () => {
    const { service, teamModel } = makeService({ member: { isDeleted: true } });
    await expect(
      service.assertMemberWritable(WS, TM1, { allowOffboarded: true }),
    ).resolves.toBeUndefined();
    // Carve-out short-circuits before any DB read.
    expect(teamModel.findOne).not.toHaveBeenCalled();
  });
});
