import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { Types, model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import {
  startMemoryMongo,
  stopMemoryMongo,
  clearAllCollections,
} from '../../../../../test-utils/mongo-memory';
import {
  PortalAccessToken,
  PortalAccessTokenSchema,
} from '../portal-access-token.schema';
import { PortalTokenService } from '../portal-token.service';

/**
 * PortalTokenService verify suite (Plan 04 Task 1).
 *
 * Covers:
 *   1. Issue token → verify returns expected payload
 *   2. Tampered signature → UnauthorizedException
 *   3. Token signed with wrong audience → UnauthorizedException
 *   4. Revoked token → 410 Gone
 *   5. Expired token (expiresAt set in the past) → UnauthorizedException
 *   6. Re-issue after revokeAll still works
 */
describe('PortalTokenService — issue / verify / revoke', () => {
  let TokenModel: any;
  let portalJwt: JwtService;
  let service: PortalTokenService;

  const wsId = new Types.ObjectId();
  const firmId = new Types.ObjectId();
  const partyId = new Types.ObjectId();
  const userId = new Types.ObjectId();

  const PORTAL_SECRET = 'test-portal-secret-1234567890abcdef';

  beforeAll(async () => {
    await startMemoryMongo();
    TokenModel = model('PortalAccessToken', PortalAccessTokenSchema);
    portalJwt = new JwtService({
      secret: PORTAL_SECRET,
      signOptions: { audience: 'party-portal' },
      verifyOptions: { audience: 'party-portal' },
    });
    service = new PortalTokenService(TokenModel, portalJwt);
  });

  afterAll(async () => {
    await stopMemoryMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  it('issue → verify returns expected payload', async () => {
    const r = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement', 'invoices'],
      expiresInDays: 30,
      issuedBy: userId,
    });
    expect(r.token).toBeDefined();
    expect(r.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const ctx = await service.verify(r.token);
    expect(ctx.jti).toBe(r.jti);
    expect(ctx.wsId).toBe(String(wsId));
    expect(ctx.firmId).toBe(String(firmId));
    expect(ctx.partyId).toBe(String(partyId));
    expect(ctx.scope).toEqual(['statement', 'invoices']);
  });

  it('tampered signature → UnauthorizedException', async () => {
    const r = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement'],
      expiresInDays: 30,
      issuedBy: userId,
    });
    const tampered = r.token.slice(0, -2) + 'XX';
    await expect(service.verify(tampered)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('token signed with wrong audience → UnauthorizedException', async () => {
    const wrongAud = new JwtService({ secret: PORTAL_SECRET });
    const bogus = await wrongAud.signAsync(
      { wsId: String(wsId), partyId: String(partyId) },
      { audience: 'something-else', jwtid: 'no-such-jti' },
    );
    await expect(service.verify(bogus)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revoked token → 410 Gone', async () => {
    const r = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement'],
      expiresInDays: 30,
      issuedBy: userId,
    });
    await service.revoke(r.jti, userId, 'test');
    await expect(service.verify(r.token)).rejects.toMatchObject({
      status: 410,
    });
  });

  it('expired token → UnauthorizedException', async () => {
    const r = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement'],
      expiresInDays: 30,
      issuedBy: userId,
    });
    // Force expiry in the row.
    await TokenModel.updateOne(
      { jti: r.jti },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await expect(service.verify(r.token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokeAll then re-issue still works (new jti, old revoked)', async () => {
    const a = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement'],
      expiresInDays: 30,
      issuedBy: userId,
    });
    const b = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement'],
      expiresInDays: 30,
      issuedBy: userId,
    });

    await service.revokeAll(wsId, firmId, partyId, userId);

    // Old tokens revoked.
    await expect(service.verify(a.token)).rejects.toThrow();
    await expect(service.verify(b.token)).rejects.toThrow();

    // Fresh issue produces a new active token.
    const c = await service.issue({
      wsId,
      firmId,
      partyId,
      scope: ['statement'],
      expiresInDays: 30,
      issuedBy: userId,
    });
    const ctx = await service.verify(c.token);
    expect(ctx.jti).toBe(c.jti);
    expect(c.jti).not.toBe(a.jti);
    expect(c.jti).not.toBe(b.jti);
  });
});
