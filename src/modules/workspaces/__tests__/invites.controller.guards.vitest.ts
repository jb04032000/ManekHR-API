/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing the controllers — the
// transitive schema imports would otherwise trip vitest's esbuild
// "Cannot determine type" reflection error.
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

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { IS_SKIP_PIN_UNLOCK_KEY } from '../../../common/decorators/skip-pin-unlock.decorator';
import { MyInvitesController, InvitesController } from '../invites.controller';

/**
 * P1.6 (2026-05-14) — guard-chain contract for the cross-workspace invite
 * endpoints. Owner concern: "if invitee has no active or valid subscription
 * then still he should be able to check the invites from the proper module."
 *
 * The endpoints below MUST NOT have `SubscriptionGuard` in their guard chain
 * — an invitee whose own workspace subscription has lapsed must still be
 * able to list + accept invites from other workspaces (the invite is a
 * pre-conversion surface; gating it defeats the purpose).
 *
 * These tests inspect the @UseGuards() metadata directly so a future
 * refactor that accidentally re-adds SubscriptionGuard breaks CI rather
 * than silently locking invitees out.
 */
describe('Cross-workspace invite controllers — guard chain (P1.6)', () => {
  function getClassGuards(target: any): unknown[] {
    return Reflect.getMetadata(GUARDS_METADATA, target) ?? [];
  }
  function getMethodGuards(target: any, methodName: string): unknown[] {
    return Reflect.getMetadata(GUARDS_METADATA, target.prototype[methodName]) ?? [];
  }

  function allGuardsFor(target: any, methodName: string): unknown[] {
    return [...getClassGuards(target), ...getMethodGuards(target, methodName)];
  }

  describe('MyInvitesController (/me/invites/*)', () => {
    it('has JwtAuthGuard at the class level', () => {
      const guards = getClassGuards(MyInvitesController);
      expect(guards).toContain(JwtAuthGuard);
    });

    it.each(['pending', 'accept', 'decline'])(
      '`%s` does NOT include SubscriptionGuard in its guard chain',
      (methodName) => {
        const guards = allGuardsFor(MyInvitesController, methodName);
        expect(guards).not.toContain(SubscriptionGuard);
      },
    );

    // App-Lock fix (2026-06-20): /me/invites/* is identity-layer (every route is
    // user-self, keyed on req.user.sub, with no workspace payroll/finance/staff
    // data) and is called from OUTSIDE the ERP shell — the Connect switcher
    // pending-invites badge and the /auth/setup-workspace screen. App Lock is an
    // ERP-only protection, so the global PinUnlockGuard must NOT 423-lock these
    // routes for a no-PIN Connect user. Before this, a no-PIN user whose 5-min
    // setup-grace had expired got a 423 on `pending`; the web axios interceptor
    // parked that request forever, so setup-workspace hung on `invites === null`
    // and rendered blank. The class MUST carry @SkipPinUnlock() (mirrors the
    // isConnectRequest / isAccountSelfServiceRequest exemptions in
    // pin-unlock.guard.ts). Keep FE + BE in sync.
    it('carries @SkipPinUnlock() at the class level (App Lock is ERP-only)', () => {
      const skip = Reflect.getMetadata(IS_SKIP_PIN_UNLOCK_KEY, MyInvitesController) as
        | boolean
        | undefined;
      expect(skip).toBe(true);
    });
  });

  describe('InvitesController (/invites/:token/*)', () => {
    it.each(['preview', 'accept', 'decline'])(
      '`%s` does NOT include SubscriptionGuard in its guard chain',
      (methodName) => {
        const guards = allGuardsFor(InvitesController, methodName);
        expect(guards).not.toContain(SubscriptionGuard);
      },
    );
  });
});
