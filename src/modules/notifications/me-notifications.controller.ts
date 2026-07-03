import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  Post,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';
import { ListNotificationsQueryDto } from './dto/list-notifications.dto';
import {
  NOTIFICATIONS_SOCKET_TICKET_AUDIENCE,
  NOTIFICATIONS_SOCKET_TICKET_TTL,
} from './notifications-realtime';
import type { ChannelPrefs, GlobalChannelPrefs, DeliverySettings } from './notification-categories';

/** Narrow a raw `?product=` query string to the typed product enum (or
 *  `undefined` for anything else — the service then treats it as unscoped). */
function toProduct(raw?: string): 'connect' | 'erp' | undefined {
  return raw === 'connect' || raw === 'erp' ? raw : undefined;
}

/**
 * `/me/notifications` — cross-workspace, user-scoped surface (P2.0,
 * extended Phase 7a with preferences + socket-ticket mint).
 *
 * The original `NotificationsController` is workspace-scoped, so a user who
 * has been invited to (but not yet joined) a workspace cannot read invite
 * notifications addressed to them in that workspace — they have no
 * (userId, workspaceId) membership letting them through that controller's
 * tenant filter.
 *
 * `JwtAuthGuard` only — no SubscriptionGuard either — invitees whose own
 * workspace subscription has lapsed must still see invites from other
 * workspaces (mirrors the Wave 2 `/me/invites/pending` decision).
 */
// @SkipPinUnlock - the notification bell is shared chrome on BOTH shells, and
// the Connect shell must keep working while an ERP session is App-Locked (App
// Lock is ERP-data-only; see PinUnlockGuard). Notifications are low-sensitivity
// (titles / links, no payroll), so reaching them while locked is safe. Without
// this, a Connect-only (PIN-less) user's bell poll would 423 forever.
@LegacyUnclassified()
@SkipPinUnlock()
@Controller('me/notifications')
@UseGuards(JwtAuthGuard)
export class MeNotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly preferencesService: NotificationPreferencesService,
    private readonly jwtService: JwtService,
  ) {}

  @Get()
  list(@Req() req, @Query() query: ListNotificationsQueryDto) {
    return this.notificationsService.listForUser(req.user.sub, {
      unreadOnly: query.unreadOnly ?? false,
      category: query.category,
      limit: query.limit,
      before: query.before,
      product: query.product,
    });
  }

  @Get('unread-count')
  async unreadCount(@Req() req, @Query('category') category?: string) {
    const count = await this.notificationsService.countUnreadForUser(req.user.sub, category);
    return { count };
  }

  /** Unseen count — the red bell badge (two-state model). */
  @Get('unseen-count')
  async unseenCount(@Req() req) {
    const count = await this.notificationsService.countUnseenForUser(req.user.sub);
    return { count };
  }

  /** Mark unseen notifications seen — clears the red badge on open. Does NOT
   *  mark them read (rows stay bold until individually clicked). An optional
   *  `?category=` scopes the clear to one category (e.g. visiting
   *  `/connect/network` clears `connect.connection_accepted` only). */
  @Patch('mark-all-seen')
  markAllSeen(
    @Req() req,
    @Query('category') category?: string,
    @Query('product') product?: string,
  ) {
    return this.notificationsService.markAllSeenForUser(req.user.sub, category, toProduct(product));
  }

  @Patch('mark-all-read')
  markAllRead(
    @Req() req,
    @Query('category') category?: string,
    @Query('product') product?: string,
  ) {
    return this.notificationsService.markAllReadForUser(req.user.sub, category, toProduct(product));
  }

  @Patch(':notificationId/read')
  markRead(@Req() req, @Param('notificationId') notificationId: string) {
    return this.notificationsService.markReadForUser(req.user.sub, notificationId);
  }

  /**
   * Clear the caller's notifications. Optional `?product=connect|erp` scopes
   * the wipe to one inbox ("one engine, two inboxes") so a Connect "clear all"
   * never touches the ERP bell. Declared before the `:notificationId` route so
   * a bare `DELETE /me/notifications` is unambiguous.
   */
  @Delete()
  clearAll(@Req() req, @Query('product') product?: string) {
    return this.notificationsService.deleteAllForUser(req.user.sub, toProduct(product));
  }

  /** Delete one of the caller's own notifications (recipient-scoped). */
  @Delete(':notificationId')
  deleteOne(@Req() req, @Param('notificationId') notificationId: string) {
    return this.notificationsService.deleteForUser(req.user.sub, notificationId);
  }

  /* ── Preferences ───────────────────────────────────────────────────── */

  /** Return the user's full preference map PLUS global channel + delivery
   *  settings (the settings drawer reads all three). */
  @Get('preferences')
  async getPreferences(@Req() req) {
    const [prefs, settings] = await Promise.all([
      this.preferencesService.getForUser(req.user.sub),
      this.preferencesService.getSettingsForUser(req.user.sub),
    ]);
    return { prefs, channels: settings.channels, delivery: settings.delivery };
  }

  /** Patch prefs (per-category module mutes) and/or global channels + delivery.
   *  Unknown/non-toggleable categories dropped server-side; `channels.inApp`
   *  can never be disabled. Returns the merged envelope. */
  @Patch('preferences')
  async updatePreferences(
    @Req() req,
    @Body()
    body: {
      prefs?: Partial<Record<string, Partial<ChannelPrefs>>>;
      channels?: Partial<GlobalChannelPrefs>;
      delivery?: Partial<DeliverySettings>;
    },
  ) {
    const prefs = body?.prefs
      ? await this.preferencesService.update(req.user.sub, body.prefs)
      : await this.preferencesService.getForUser(req.user.sub);
    const settings =
      body?.channels || body?.delivery
        ? await this.preferencesService.updateSettings(req.user.sub, {
            channels: body.channels,
            delivery: body.delivery,
          })
        : await this.preferencesService.getSettingsForUser(req.user.sub);
    return { prefs, channels: settings.channels, delivery: settings.delivery };
  }

  /* ── Realtime ──────────────────────────────────────────────────────── */

  /**
   * Mint a short-lived socket ticket for the `/notifications` gateway.
   * Same pattern as the Connect feed's `realtime/ticket` endpoint — the
   * browser can't read the httpOnly access cookie for a cross-origin
   * socket, so it connects with this `notifications-socket`-audience
   * ticket. The `aud` claim ensures the ticket can never be replayed as
   * an API access token (or as a feed-socket ticket).
   */
  @Post('socket-ticket')
  socketTicket(@Req() req) {
    const ticket = this.jwtService.sign(
      { sub: req.user.sub },
      {
        audience: NOTIFICATIONS_SOCKET_TICKET_AUDIENCE,
        expiresIn: NOTIFICATIONS_SOCKET_TICKET_TTL,
      },
    );
    return { ticket };
  }
}
