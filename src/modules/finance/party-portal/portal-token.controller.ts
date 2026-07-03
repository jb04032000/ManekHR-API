import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { env } from '../../../config/env';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RequirePermissions, RolesGuard } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Party } from '../parties/party.schema';
import { Firm } from '../firms/firm.schema';
import { PortalTokenService } from './portal-token.service';
import { AuditService } from '../../audit/audit.service';
import { MailService } from '../../mail/mail.service';
import { IssueTokenDto } from './dto/issue-token.dto';
import { ShareTokenDto } from './dto/share-token.dto';
// Platform-bar observability: the share write lives here (not in PortalTokenService),
// so the fire-and-forget PostHog `portal.shared_token` event is emitted here after a
// successful share. PostHogService is @Global. PII rule: emit channel + ids only,
// NEVER the recipient email/phone, the share URL, or the raw token.
import { PostHogService } from '../../../common/posthog/posthog.service';

/**
 * Owner-side portal-token controller (D-29, D-30).
 *
 * Path: /workspaces/:wsId/finance/parties/:partyId/portal-tokens
 *
 * Auth gates (in order):
 *   JwtAuthGuard → RolesGuard → SubscriptionGuard
 * Subscription: 'finance_advanced' (D-43)
 * Permission: 'party_portal_manage' (D-42, FINANCE_F15_PERMISSIONS)
 *
 * Cross-party / cross-firm safety: the partyId in the URL is loaded from
 * Mongo and its workspace + firm fields are asserted to match the request's
 * workspace context. The token's stored partyId derives from this loaded row,
 * not from any client-supplied body.
 */
@ApiTags('Finance - Party Portal')
@Controller('workspaces/:wsId/finance/parties/:partyId/portal-tokens')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.FINANCE,
  subFeature: 'party_portal_access',
})
export class PortalTokenController {
  constructor(
    private readonly tokens: PortalTokenService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    private readonly postHog: PostHogService,
  ) {}

  private async loadParty(wsId: string, partyId: string) {
    const p = await this.partyModel
      .findOne({
        _id: new Types.ObjectId(partyId),
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: { $ne: true },
      })
      .lean();
    if (!p) throw new NotFoundException('Party not found');
    return p;
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, 'party_portal_manage' as any)
  async issue(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Body() dto: IssueTokenDto,
    @CurrentUser() user: { id?: string; _id?: string; userId?: string },
  ) {
    const party = await this.loadParty(wsId, partyId);
    const result = await this.tokens.issue({
      wsId,
      firmId: String(party.firmId),
      partyId,
      scope: dto.scope,
      expiresInDays: dto.expiresInDays,
      issuedBy: user.id ?? user._id ?? user.userId,
    });

    void this.audit
      .logEvent({
        workspaceId: wsId,
        module: AppModule.FINANCE,
        entityType: 'PortalAccessToken',
        entityId: party._id,
        action: 'PORTAL_TOKEN_ISSUED',
        actorId: user.id ?? user._id ?? user.userId,
        meta: {
          jti: result.jti,
          partyId,
          firmId: String(party.firmId),
          scope: dto.scope,
          expiresAt: result.expiresAt,
        },
      })
      .catch(() => undefined);

    const base = env.publicWebUrl;
    return {
      token: result.token,
      jti: result.jti,
      expiresAt: result.expiresAt,
      url: base ? `${base}/portal/${result.token}` : undefined,
    };
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, 'party_portal_manage' as any)
  async list(@Param('wsId') wsId: string, @Param('partyId') partyId: string) {
    const party = await this.loadParty(wsId, partyId);
    return this.tokens.list(wsId, String(party.firmId), partyId);
  }

  @Delete(':jti')
  @RequirePermissions(AppModule.FINANCE, 'party_portal_manage' as any)
  async revoke(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Param('jti') jti: string,
    @Query('reason') reason: string | undefined,
    @CurrentUser() user: { id?: string; _id?: string; userId?: string },
  ) {
    await this.loadParty(wsId, partyId);
    const userId = user.id ?? user._id ?? user.userId;
    await this.tokens.revoke(jti, userId, reason);

    void this.audit
      .logEvent({
        workspaceId: wsId,
        module: AppModule.FINANCE,
        entityType: 'PortalAccessToken',
        entityId: new Types.ObjectId(partyId),
        action: 'PORTAL_TOKEN_REVOKED',
        actorId: userId,
        meta: { jti, partyId, reason },
      })
      .catch(() => undefined);

    return { ok: true };
  }

  @Delete()
  @RequirePermissions(AppModule.FINANCE, 'party_portal_manage' as any)
  async revokeAll(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @CurrentUser() user: { id?: string; _id?: string; userId?: string },
  ) {
    const party = await this.loadParty(wsId, partyId);
    const userId = user.id ?? user._id ?? user.userId;
    await this.tokens.revokeAll(wsId, String(party.firmId), partyId, userId);

    void this.audit
      .logEvent({
        workspaceId: wsId,
        module: AppModule.FINANCE,
        entityType: 'PortalAccessToken',
        entityId: party._id,
        action: 'PORTAL_TOKEN_REVOKED_BULK',
        actorId: userId,
        meta: { partyId, firmId: String(party.firmId) },
      })
      .catch(() => undefined);

    return { ok: true };
  }

  @Post(':jti/share')
  @RequirePermissions(AppModule.FINANCE, 'party_portal_manage' as any)
  async share(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Param('jti') jti: string,
    @Body() dto: ShareTokenDto,
    @CurrentUser() user: { id?: string; _id?: string; userId?: string },
  ) {
    const party = await this.loadParty(wsId, partyId);
    const target = await this.tokens.findByJti(jti);
    if (!target) throw new NotFoundException('Token not found');
    const targetWs =
      (target as { workspaceId?: string | Types.ObjectId; wsId?: string | Types.ObjectId })
        .workspaceId ?? target.wsId;
    if (String(target.partyId) !== partyId || String(targetWs) !== wsId) {
      // The token must belong to the party in the URL - defence in depth
      // against cross-party JTI enumeration.
      throw new NotFoundException('Token not found');
    }

    const userId = user.id ?? user._id ?? user.userId;
    const baseAuditMeta = {
      jti,
      partyId,
      firmId: String(party.firmId),
      channel: dto.channel,
      recipient: dto.recipient,
    };

    if (dto.channel === 'copy') {
      void this.audit
        .logEvent({
          workspaceId: wsId,
          module: AppModule.FINANCE,
          entityType: 'PortalAccessToken',
          entityId: party._id,
          action: 'PORTAL_TOKEN_SHARED',
          actorId: userId,
          meta: { ...baseAuditMeta, url: dto.url },
        })
        .catch(() => undefined);
      this.emitSharedTokenEvent(userId, wsId, String(party.firmId), partyId, jti, 'copy');
      return { ok: true, url: dto.url };
    }

    if (dto.channel === 'email') {
      if (!dto.recipient) {
        throw new BadRequestException('recipient is required for channel=email');
      }
      // Synchronous email send (view-only portal link, no payment link). Mirrors the
      // invoice-send quota pattern: enforce quota -> send -> increment usage.
      const firm = await this.firmModel.findById(party.firmId).lean();
      const firmName = (firm as { firmName?: string } | null)?.firmName ?? 'your supplier';
      const expiryNote = target.expiresAt
        ? `This link is valid until ${new Date(target.expiresAt).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })}.`
        : undefined;
      await this.mail.enforceEmailQuota(wsId);
      await this.mail.sendPortalLinkEmail(dto.recipient, {
        partyName: (party as { name?: string }).name ?? 'Customer',
        firmName,
        portalUrl: dto.url,
        expiryNote,
      });
      await this.mail.incrementEmailUsage(wsId);

      void this.audit
        .logEvent({
          workspaceId: wsId,
          module: AppModule.FINANCE,
          entityType: 'PortalAccessToken',
          entityId: party._id,
          action: 'PORTAL_TOKEN_SHARED',
          actorId: userId,
          // recipient email/phone intentionally NOT logged (PII); channel + jti only.
          meta: { ...baseAuditMeta, recipient: undefined, expiresAt: target.expiresAt },
        })
        .catch(() => undefined);
      this.emitSharedTokenEvent(userId, wsId, String(party.firmId), partyId, jti, 'email');
      return { ok: true };
    }

    if (dto.channel === 'whatsapp') {
      if (!dto.recipient) {
        throw new BadRequestException('recipient is required for channel=whatsapp');
      }
      // WhatsApp dispatch needs the AiSensy adapter (not yet wired - same provider class as
      // the invoice-send whatsapp stub). Record the share intent in the audit log; the
      // reminder-engine dispatcher picks it up on its next cron tick.
      void this.audit
        .logEvent({
          workspaceId: wsId,
          module: AppModule.FINANCE,
          entityType: 'PortalAccessToken',
          entityId: party._id,
          action: 'PORTAL_TOKEN_SHARED',
          actorId: userId,
          meta: {
            ...baseAuditMeta,
            url: dto.url,
            expiresAt: target.expiresAt,
            event: 'PORTAL_TOKEN_SHARE',
          },
        })
        .catch(() => undefined);
      this.emitSharedTokenEvent(userId, wsId, String(party.firmId), partyId, jti, 'whatsapp');
      return { ok: true };
    }

    throw new BadRequestException(`unsupported channel: ${String(dto.channel)}`);
  }

  /**
   * Fire-and-forget PostHog `portal.shared_token` event (additive observability).
   * Emitted only after a successful share. PII rule: channel + ids only - the
   * recipient email/phone, the share URL, and the raw token are NEVER emitted.
   */
  private emitSharedTokenEvent(
    userId: string | undefined,
    wsId: string,
    firmId: string,
    partyId: string,
    jti: string,
    channel: string,
  ): void {
    this.postHog?.capture({
      distinctId: userId ?? partyId,
      event: 'portal.shared_token',
      properties: { workspaceId: wsId, firmId, partyId, tokenId: jti, channel },
    });
  }
}
