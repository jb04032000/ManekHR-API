import { Controller, Get, Post, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { MeAttendanceService } from './me-attendance.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

/**
 * Self-service attendance — `workspaces/:workspaceId/me/attendance`.
 *
 * The `me` path makes the contract explicit: the caller acts only on their
 * own attendance. The service resolves the caller's `teamMemberId`
 * server-side, so nothing in the request can target another member.
 */
@ApiTags('Attendance')
@Controller('workspaces/:workspaceId/me/attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MeAttendanceController {
  constructor(private readonly meAttendanceService: MeAttendanceService) {}

  /**
   * Punch the caller's own attendance (auto-toggled CHECK_IN / CHECK_OUT).
   * Requires `attendance.selfPunch.create` at `self` scope or better AND the
   * workspace `selfServiceConfig.selfPunch` policy toggle.
   */
  @Post('punch')
  @RequirePermission('attendance.selfPunch.create', 'self')
  punch(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    return this.meAttendanceService.punch(workspaceId, req.user.sub);
  }

  /**
   * The caller's own attendance for one day (defaults to today). Read-only and
   * self-scoped — powers the live "today" clock (state, hours-so-far, punch
   * count, session log) and the calendar day-detail. Gated by
   * `attendance.record.view` at `self` scope or better.
   */
  @Get('day')
  @RequirePermission('attendance.record.view', 'self')
  getDay(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Query('date') date?: string,
  ) {
    return this.meAttendanceService.getDay(workspaceId, req.user.sub, date);
  }
}
