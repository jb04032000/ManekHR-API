/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { Types } from 'mongoose';
import { ErpVerificationService } from '../erp-verification.service';

/**
 * Unit coverage for the person consent service (ADR-0004 / 2026-06-18 spec):
 * grant / revoke / dismiss write the right ConnectProfile sub-doc + audit, and
 * getState reports eligibility (≥ 1 active WorkspaceMember) + consent status.
 */

const USER = new Types.ObjectId().toHexString();

function makeProfileModel(stateDoc?: any) {
  const updateOne = vi.fn(() => ({
    exec: async () => ({ matchedCount: 1, modifiedCount: 1 }),
  }));
  return {
    updateOne,
    findOne: vi.fn(() => ({
      select: () => ({ lean: () => ({ exec: async () => stateDoc ?? null }) }),
    })),
  } as any;
}

function makeMemberModel(activeCount: number) {
  return {
    countDocuments: vi.fn(() => ({ exec: async () => activeCount })),
  } as any;
}

function build(opts?: { stateDoc?: any; activeMemberships?: number }) {
  const profileModel = makeProfileModel(opts?.stateDoc);
  const memberModel = makeMemberModel(opts?.activeMemberships ?? 0);
  const audit = { logEvent: vi.fn(async () => undefined) };
  const posthog = { capture: vi.fn() };
  const svc = new ErpVerificationService(profileModel, memberModel, audit as any, posthog as any);
  return { svc, profileModel, memberModel, audit, posthog };
}

describe('ErpVerificationService (ADR-0004)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('grant: writes status=granted + consentVersion, audits + PostHog', async () => {
    const { svc, profileModel, audit, posthog } = build({
      stateDoc: { erpVerificationConsent: { status: 'granted', consentVersion: 'erp-verify-v1' } },
      activeMemberships: 1,
    });

    const state = await svc.grant(USER);

    expect(profileModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.anything() }),
      expect.objectContaining({
        $set: expect.objectContaining({
          erpVerificationConsent: expect.objectContaining({
            status: 'granted',
            consentVersion: 'erp-verify-v1',
            revokedAt: null,
          }),
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'erp_verification_consent_granted' }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.erp_verification_consent_granted' }),
    );
    expect(state.consentStatus).toBe('granted');
    expect(state.consentVersion).toBe('erp-verify-v1');
  });

  it('revoke: writes status=revoked + revokedAt, audits + PostHog', async () => {
    const { svc, profileModel, audit, posthog } = build({
      stateDoc: { erpVerificationConsent: { status: 'revoked', consentVersion: 'erp-verify-v1' } },
    });

    const state = await svc.revoke(USER);

    expect(profileModel.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          erpVerificationConsent: expect.objectContaining({ status: 'revoked', grantedAt: null }),
        }),
      }),
    );
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'erp_verification_consent_revoked' }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'connect.erp_verification_consent_revoked' }),
    );
    expect(state.consentStatus).toBe('revoked');
    // consentVersion only surfaces while granted.
    expect(state.consentVersion).toBeNull();
  });

  it('dismiss: stamps erpSuggestionDismissedAt (upsert), audits, no PostHog', async () => {
    const { svc, profileModel, audit, posthog } = build({
      stateDoc: { erpSuggestionDismissedAt: new Date() },
    });

    const state = await svc.dismissSuggestion(USER);

    expect(profileModel.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ erpSuggestionDismissedAt: expect.any(Date) }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'erp_verification_suggestion_dismissed' }),
    );
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(state.suggestionDismissed).toBe(true);
  });

  it('getState: eligible=true when the user has ≥ 1 active membership', async () => {
    const { svc, memberModel } = build({ activeMemberships: 2 });
    const state = await svc.getState(USER);
    expect(memberModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
    );
    expect(state.eligible).toBe(true);
  });

  it('getState: eligible=false when the user has no active membership; consent absent', async () => {
    const { svc } = build({ activeMemberships: 0, stateDoc: null });
    const state = await svc.getState(USER);
    expect(state.eligible).toBe(false);
    expect(state.consentStatus).toBeNull();
    expect(state.suggestionDismissed).toBe(false);
  });

  it('getState: degrades to eligible=false when the membership read throws', async () => {
    const { svc, memberModel } = build({ stateDoc: null });
    memberModel.countDocuments = vi.fn(() => ({
      exec: async () => {
        throw new Error('mongo down');
      },
    }));
    const state = await svc.getState(USER);
    expect(state.eligible).toBe(false);
  });
});
