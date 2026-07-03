/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstituteCredentialsController } from '../institute-credentials.controller';

/**
 * Unit coverage for the Institutes Phase 2 (Feature 2) institute-admin
 * controller. Verifies the actor is ALWAYS taken from `req.user.sub` (never the
 * body / a param) and that each route delegates to the right
 * `ConnectProfileService` method with the validated path params + the decision.
 * The service is stubbed (its own unit spec covers the gate + write rules).
 */

const PAGE_OWNER = '60b0000000000000000000a1';
const PAGE_ID = '60b0000000000000000000b1';
const STUDENT = '60b0000000000000000000c1';
const TRAINING_ID = '60b0000000000000000000d1';

function build() {
  const profiles: any = {
    listPendingCredentialRequests: vi.fn().mockResolvedValue([]),
    decideCredential: vi.fn().mockResolvedValue({ ok: true, confirmStatus: 'confirmed' }),
  };
  const controller = new InstituteCredentialsController(profiles);
  const req: any = { user: { sub: PAGE_OWNER } };
  return { controller, profiles, req };
}

beforeEach(() => vi.clearAllMocks());

describe('InstituteCredentialsController', () => {
  it('list -> listPendingCredentialRequests(actor, pageId)', async () => {
    const f = build();
    await f.controller.listRequests(f.req, { pageId: PAGE_ID });
    expect(f.profiles.listPendingCredentialRequests).toHaveBeenCalledWith(PAGE_OWNER, PAGE_ID);
  });

  it('confirm -> decideCredential(actor, pageId, studentUserId, trainingId, "confirm")', async () => {
    const f = build();
    await f.controller.confirm(f.req, {
      pageId: PAGE_ID,
      studentUserId: STUDENT,
      trainingId: TRAINING_ID,
    });
    expect(f.profiles.decideCredential).toHaveBeenCalledWith(
      PAGE_OWNER,
      PAGE_ID,
      STUDENT,
      TRAINING_ID,
      'confirm',
    );
  });

  it('decline -> decideCredential(actor, pageId, studentUserId, trainingId, "decline")', async () => {
    const f = build();
    await f.controller.decline(f.req, {
      pageId: PAGE_ID,
      studentUserId: STUDENT,
      trainingId: TRAINING_ID,
    });
    expect(f.profiles.decideCredential).toHaveBeenCalledWith(
      PAGE_OWNER,
      PAGE_ID,
      STUDENT,
      TRAINING_ID,
      'decline',
    );
  });

  it('always uses req.user.sub as the actor (never a param/body)', async () => {
    const f = build();
    // Even if a different id appears in params, the actor stays the JWT sub.
    await f.controller.confirm({ user: { sub: 'jwt-actor' } } as any, {
      pageId: PAGE_ID,
      studentUserId: STUDENT,
      trainingId: TRAINING_ID,
    });
    expect(f.profiles.decideCredential.mock.calls[0][0]).toBe('jwt-actor');
  });
});
