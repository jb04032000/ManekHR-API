import { Controller, Get, Patch, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
// RolesGuard usually not needed for personal notifications, but context validation is good

@LegacyUnclassified()
@Controller('workspaces/:workspaceId/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findAll(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Query('unreadOnly') unreadOnly: string,
  ) {
    const isUnread = unreadOnly === 'true';
    return this.notificationsService.findAll(workspaceId, req.user.sub, isUnread);
  }

  @Patch('mark-all-read')
  markAllAsRead(@Param('workspaceId') workspaceId: string, @Req() req) {
    return this.notificationsService.markAllAsRead(workspaceId, req.user.sub);
  }

  @Patch(':notificationId/read')
  markAsRead(
    @Param('workspaceId') workspaceId: string,
    @Param('notificationId') notificationId: string,
    @Req() req,
  ) {
    return this.notificationsService.markAsRead(workspaceId, req.user.sub, notificationId);
  }

  @Delete(':notificationId')
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('notificationId') notificationId: string,
    @Req() req,
  ) {
    return this.notificationsService.remove(workspaceId, req.user.sub, notificationId);
  }
}
