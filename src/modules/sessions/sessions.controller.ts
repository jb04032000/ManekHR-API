import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Body,
  Req,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { issueTokens } from '../auth/utils/token-issuer';
import { Platform } from '../../common/enums/platform-access.enum';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { SessionsService } from './sessions.service';
import { TerminateAndLoginDto } from './dto/sessions.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';

// @SkipPinUnlock: a user managing their own active sessions/devices is a
// product-neutral identity action backing the shared `/account/devices` area.
// App Lock (Quick PIN) is ERP-only, so it must NOT gate this - a Connect-only
// user (no PIN) must still see and revoke their own sessions. The admin
// session controller below is NOT exempt (it stays under the lock + IsAdminGuard).
// Keep in sync with the web `appLockEnabled = mode === 'erp'` gate.
@SkipPinUnlock()
@LegacyUnclassified()
@Controller('sessions')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class SessionsController {
  constructor(
    private sessionsService: SessionsService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  @Get()
  @Throttle({ auth: { limit: 30, ttl: 60_000 } })
  async getActiveSessions(@CurrentUser('sub') userId: string) {
    const sessions = await this.sessionsService.getActiveSessions(userId);
    return {
      data: sessions.map((s) => ({
        id: s._id,
        deviceName: s.deviceName,
        platform: s.platform,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        location: s.location,
        lastActiveAt: s.lastActiveAt,
      })),
    };
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  async invalidateSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.sessionsService.invalidateSession(sessionId, userId);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  async invalidateAllOtherSessions(@CurrentUser('sub') userId: string, @Req() req: Request) {
    const authHeader = req.headers['authorization'];
    const currentTokenHash = authHeader?.startsWith('Bearer ')
      ? crypto.createHash('sha256').update(authHeader.substring(7)).digest('hex')
      : null;

    const sessions = await this.sessionsService.getActiveSessions(userId);
    const currentSession = currentTokenHash
      ? sessions.find((s) => s.jwtTokenHash === currentTokenHash)
      : null;

    // If we cannot match the caller's token to one of their active session
    // rows we must NOT fall through to invalidating every session — that would
    // log the caller out of the very tab they pressed the button from. The
    // only honest answer is to refuse and let the client surface a re-login
    // prompt. Historic behaviour silently kicked the user themselves.
    if (!currentSession) {
      throw new ConflictException({
        message: 'Could not identify the current session. Please refresh and try again.',
        code: 'CURRENT_SESSION_UNRESOLVED',
      });
    }

    const count = await this.sessionsService.invalidateAllOtherSessions(
      userId,
      String(currentSession._id),
    );
    return { count };
  }

  @Post('terminate-and-login')
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  async terminateAndLogin(@Body() body: TerminateAndLoginDto, @CurrentUser('sub') userId: string) {
    // Use shared issuer so the access + refresh pair carry `jti` claims —
    // required for AuthService.revokeTokens / JwtAuthGuard's denylist check.
    // Minting tokens directly here (legacy path) silently bypassed revocation.
    const { accessToken: newToken, refreshToken: newRefreshToken } = await issueTokens(
      this.jwtService,
      this.configService,
      userId,
      body.platform as Platform,
    );

    const session = await this.sessionsService.terminateAndCreate(
      userId,
      body.sessionId,
      newToken,
      {
        deviceId: '',
        deviceName: body.deviceName,
        platform: body.platform,
        ipAddress: body.ipAddress,
        userAgent: body.userAgent,
      },
    );

    return {
      accessToken: newToken,
      refreshToken: newRefreshToken,
      session: {
        id: session._id,
        deviceName: session.deviceName,
        platform: session.platform,
      },
    };
  }
}

@LegacyUnclassified()
@Controller('admin/users/:userId/sessions')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class AdminSessionsController {
  constructor(
    private sessionsService: SessionsService,
    private auditService: AuditService,
  ) {}

  @Get()
  async getUserSessions(@Param('userId') userId: string) {
    const sessions = await this.sessionsService.getActiveSessionsForAdmin(userId);
    return {
      data: sessions.map((s) => ({
        id: s._id,
        deviceName: s.deviceName,
        platform: s.platform,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        location: s.location,
        lastActiveAt: s.lastActiveAt,
        isActive: s.isActive,
      })),
    };
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forceTerminateSession(
    @Param('sessionId') sessionId: string,
    @Param('userId') userId: string,
    @CurrentUser('sub') actorId: string,
  ) {
    await this.sessionsService.invalidateSession(sessionId, userId);
    await this.auditService
      .logEvent({
        module: AppModule.AUTH,
        entityType: 'session',
        entityId: sessionId,
        action: 'admin_force_terminate_session',
        actorId,
        meta: { targetUserId: userId },
      })
      .catch(() => undefined);
  }
}
