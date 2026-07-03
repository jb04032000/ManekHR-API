import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { InboxService } from './inbox.service';
import { INBOX_SOCKET_TICKET_AUDIENCE, INBOX_SOCKET_TICKET_TTL } from './inbox-realtime';
import {
  MarkReadDto,
  ReportThreadDto,
  SendMessageDto,
  StartContextThreadDto,
  StartDmDto,
} from './dto/inbox.dto';
import type { InboxChannelType } from './inbox.constants';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/inbox` -- the unified messaging hub (Phase 7). Person-centric: the
 * actor is always `req.user.sub`. Literal routes (`threads`, `unread-badge`,
 * `dm`, `context`, `block`) are declared BEFORE `:id` so they are not captured
 * as thread ids. Realtime ticket-mint + the catch-up route arrive in wave I2.
 */
@LegacyUnclassified()
@Controller('connect/inbox')
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly jwtService: JwtService,
  ) {}

  // ── Literal routes (before :id) ────────────────────────────────────────

  /** Mint a short-lived ticket for the `/inbox` Socket.IO handshake (I2). */
  @Post('realtime/ticket')
  realtimeTicket(@Req() req: AuthedRequest) {
    const ticket = this.jwtService.sign(
      { sub: req.user.sub },
      { audience: INBOX_SOCKET_TICKET_AUDIENCE, expiresIn: INBOX_SOCKET_TICKET_TTL },
    );
    return { ticket };
  }

  @Get('threads')
  listThreads(
    @Req() req: AuthedRequest,
    @Query('channel') channel?: InboxChannelType,
    @Query('before') before?: string,
  ) {
    return this.inbox.listThreads(req.user.sub, channel, before);
  }

  @Get('unread-badge')
  unreadBadge(@Req() req: AuthedRequest) {
    return this.inbox.getUnreadBadge(req.user.sub);
  }

  /** Start or resume a free DM. */
  @Post('dm')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  startDm(@Req() req: AuthedRequest, @Body() dto: StartDmDto) {
    return this.inbox.findOrCreateDmThread(req.user.sub, dto.recipientUserId);
  }

  /** Start or resume a context thread (inquiry / application / quote). */
  @Post('context')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  startContext(@Req() req: AuthedRequest, @Body() dto: StartContextThreadDto) {
    return this.inbox.findOrCreateContextThread(
      req.user.sub,
      dto.recipientUserId,
      dto.contextEntityType,
      dto.contextEntityId,
    );
  }

  @Post('block/:userId')
  block(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    return this.inbox.blockUser(req.user.sub, userId);
  }

  @Delete('block/:userId')
  unblock(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    return this.inbox.unblockUser(req.user.sub, userId);
  }

  // Unified per-person timeline (contexts as inline messages). Two path segments
  // so it never collides with the single-segment `:id` route below. Read-only.
  @Get('person/:userId')
  personTimeline(@Req() req: AuthedRequest, @Param('userId') userId: string) {
    return this.inbox.buildPersonTimeline(req.user.sub, userId);
  }

  // ── :id routes ─────────────────────────────────────────────────────────

  @Get(':id')
  getThread(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.inbox.getThread(req.user.sub, id);
  }

  @Get(':id/messages')
  messages(@Req() req: AuthedRequest, @Param('id') id: string, @Query('before') before?: string) {
    const beforeSeq = before !== undefined ? Number(before) : undefined;
    return this.inbox.listMessages(
      req.user.sub,
      id,
      beforeSeq !== undefined && Number.isFinite(beforeSeq) ? beforeSeq : undefined,
    );
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  send(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.inbox.sendMessage(req.user.sub, id, dto);
  }

  /** Since-cursor catch-up after a socket reconnect (`seq > since`). */
  @Get(':id/since')
  since(@Req() req: AuthedRequest, @Param('id') id: string, @Query('seq') seq?: string) {
    const sinceSeq = seq !== undefined ? Number(seq) : 0;
    return this.inbox.messagesSince(req.user.sub, id, Number.isFinite(sinceSeq) ? sinceSeq : 0);
  }

  @Post(':id/read')
  markRead(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: MarkReadDto) {
    return this.inbox.markRead(req.user.sub, id, dto.upToSeq);
  }

  @Post(':id/report')
  report(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: ReportThreadDto) {
    return this.inbox.reportThread(req.user.sub, id, dto);
  }
}
