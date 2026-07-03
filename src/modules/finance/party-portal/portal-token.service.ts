import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { PortalAccessToken } from './portal-access-token.schema';
// Platform-bar observability (mirrors other finance sub-modules): shared finance
// tracer + fire-and-forget PostHog on successful admin writes. PostHogService is
// @Global (src/common/posthog/posthog.service.ts) so no module import is needed.
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';

export interface IssueTokenOpts {
  wsId: string | Types.ObjectId;
  firmId: string | Types.ObjectId;
  partyId: string | Types.ObjectId;
  scope: string[];
  expiresInDays: number;
  issuedBy: string | Types.ObjectId;
}

export interface IssueTokenResult {
  token: string;
  jti: string;
  expiresAt: Date;
}

export interface PortalContext {
  jti: string;
  wsId: string;
  firmId: string;
  partyId: string;
  scope: string[];
}

/**
 * PortalTokenService — issue / verify / revoke portal access tokens
 * (Phase 16 Plan 04 Task 1).
 *
 * - issue: signs a JWT with audience='party-portal' and persists ONLY the jti
 *   (raw token never stored — see threat T-16-04-06)
 * - verify: validates JWT signature + audience, then loads the row and checks
 *   revokedAt / expiresAt; 401 for invalid/expired, 410 for revoked
 * - revoke: flips revokedAt + revokedBy + revokeReason
 * - revokeAll: bulk revoke all active tokens for a party
 * - list: returns all tokens (active + revoked) for owner-side UI
 *
 * All ObjectId read filters wrap with `new Types.ObjectId(...)`.
 */
@Injectable()
export class PortalTokenService {
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(PortalAccessToken.name)
    private readonly model: Model<PortalAccessToken>,
    private readonly jwt: JwtService,
    private readonly postHog: PostHogService,
  ) {}

  async issue(opts: IssueTokenOpts): Promise<IssueTokenResult> {
    const wsIdStr = String(opts.wsId);
    const firmIdStr = String(opts.firmId);
    const partyIdStr = String(opts.partyId);
    const userId = String(opts.issuedBy);
    // Observability wrap (additive): span over the issue write + a fire-and-forget
    // PostHog event after the row is persisted. PII rule: never emit the raw token
    // (the signed JWT) or scope-bearing secrets - only ids, the scope array, and counts.
    return withFinanceSpan(
      this.tracer,
      'finance.issuePortalToken',
      {
        workspaceId: wsIdStr,
        firmId: firmIdStr,
        partyId: partyIdStr,
        userId,
        scopeCount: opts.scope.length,
        expiresInDays: opts.expiresInDays,
      },
      async () => {
        const jti = randomUUID();
        const issuedAt = new Date();
        const expiresAt = new Date(Date.now() + opts.expiresInDays * 86400_000);

        // jwtid + audience baked in via JwtModule.signOptions defaults; we still
        // pass jwtid explicitly so the payload's `jti` claim matches our row.
        const token = await this.jwt.signAsync(
          {
            wsId: wsIdStr,
            firmId: firmIdStr,
            partyId: partyIdStr,
            scope: opts.scope,
          },
          {
            expiresIn: `${opts.expiresInDays}d`,
            jwtid: jti,
            audience: 'party-portal',
          },
        );

        await this.model.create({
          jti,
          wsId: new Types.ObjectId(wsIdStr),
          firmId: new Types.ObjectId(firmIdStr),
          partyId: new Types.ObjectId(partyIdStr),
          scope: opts.scope,
          issuedBy: new Types.ObjectId(userId),
          issuedAt,
          expiresAt,
        });

        // PostHog (fire-and-forget, after the successful write). tokenId = the
        // opaque jti, NEVER the raw token / hash / party contact details.
        this.postHog?.capture({
          distinctId: userId,
          event: 'portal.issued_token',
          properties: {
            workspaceId: wsIdStr,
            firmId: firmIdStr,
            partyId: partyIdStr,
            tokenId: jti,
            scope: opts.scope,
            scopeCount: opts.scope.length,
            expiresInDays: opts.expiresInDays,
          },
        });

        return { token, jti, expiresAt };
      },
    );
  }

  async verify(token: string): Promise<PortalContext> {
    if (!token) {
      throw new UnauthorizedException('Missing portal token');
    }

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, {
        audience: 'party-portal',
      });
    } catch (err: any) {
      throw new UnauthorizedException(
        err?.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid or expired token',
      );
    }

    if (!payload?.jti) {
      throw new UnauthorizedException('Token missing jti');
    }

    const row = await this.model.findOne({ jti: payload.jti }).lean();
    if (!row) throw new UnauthorizedException('Token not found');
    if (row.revokedAt) {
      throw new HttpException('Token revoked', HttpStatus.GONE);
    }
    if (row.expiresAt < new Date()) {
      throw new UnauthorizedException('Token expired');
    }

    // Fire-and-forget access counter increment — never await.
    void this.model
      .updateOne(
        { jti: payload.jti },
        {
          $inc: { accessCount: 1 },
          $set: { lastAccessedAt: new Date() },
        },
      )
      .catch(() => undefined);

    return {
      jti: payload.jti,
      wsId: payload.wsId,
      firmId: payload.firmId,
      partyId: payload.partyId,
      scope: payload.scope ?? [],
    };
  }

  async revoke(jti: string, userId: string | Types.ObjectId, reason?: string) {
    const userIdStr = String(userId);
    // Observability wrap (additive). tokenId = jti only; the revoke reason is
    // free-text owner input so it is NOT emitted (could carry party contact info).
    return withFinanceSpan(
      this.tracer,
      'finance.revokePortalToken',
      { userId: userIdStr, tokenId: jti, hasReason: Boolean(reason) },
      async () => {
        const res = await this.model.updateOne(
          { jti },
          {
            $set: {
              revokedAt: new Date(),
              revokedBy: new Types.ObjectId(userIdStr),
              revokeReason: reason ?? null,
            },
          },
        );

        this.postHog?.capture({
          distinctId: userIdStr,
          event: 'portal.revoked_token',
          properties: {
            tokenId: jti,
            bulk: false,
            matchedCount: res.matchedCount,
            modifiedCount: res.modifiedCount,
          },
        });

        return res;
      },
    );
  }

  async revokeAll(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    partyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) {
    const wsIdStr = String(wsId);
    const firmIdStr = String(firmId);
    const partyIdStr = String(partyId);
    const userIdStr = String(userId);
    // Observability wrap (additive): bulk revoke of every active token for a party.
    return withFinanceSpan(
      this.tracer,
      'finance.revokeAllPortalTokens',
      {
        workspaceId: wsIdStr,
        firmId: firmIdStr,
        partyId: partyIdStr,
        userId: userIdStr,
      },
      async () => {
        const res = await this.model.updateMany(
          {
            wsId: new Types.ObjectId(wsIdStr),
            firmId: new Types.ObjectId(firmIdStr),
            partyId: new Types.ObjectId(partyIdStr),
            revokedAt: { $eq: null } as any,
          },
          {
            $set: {
              revokedAt: new Date(),
              revokedBy: new Types.ObjectId(userIdStr),
              revokeReason: 'bulk-revoke',
            },
          },
        );

        this.postHog?.capture({
          distinctId: userIdStr,
          event: 'portal.revoked_token',
          properties: {
            workspaceId: wsIdStr,
            firmId: firmIdStr,
            partyId: partyIdStr,
            bulk: true,
            modifiedCount: res.modifiedCount,
          },
        });

        return res;
      },
    );
  }

  async list(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    partyId: string | Types.ObjectId,
  ) {
    return this.model
      .find({
        wsId: new Types.ObjectId(String(wsId)),
        firmId: new Types.ObjectId(String(firmId)),
        partyId: new Types.ObjectId(String(partyId)),
      })
      .sort({ issuedAt: -1 })
      .lean();
  }

  async findByJti(jti: string) {
    return this.model.findOne({ jti }).lean();
  }
}
