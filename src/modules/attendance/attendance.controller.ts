import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  Req,
  Delete,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AttendanceService } from './attendance.service';
import {
  MarkAttendanceDto,
  BulkMarkAttendanceDto,
  UpdateAttendanceDto,
  MonthYearQueryDto,
  LookbackMonthsQueryDto,
} from './dto/attendance.dto';
import {
  RecomputeAttendanceDto,
  ListEventsQueryDto,
  VoidEventDto,
} from './dto/attendance-events.dto';
import { AttendanceEventService } from './attendance-event.service';
import { AttendanceProjectionService } from './attendance-projection.service';
import { AttendanceWriteGuardService } from './attendance-write-guard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Idempotent } from '../../common/decorators/idempotent.decorator';

@ApiTags('Attendance')
@Controller('workspaces/:workspaceId/attendance')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly eventService: AttendanceEventService,
    private readonly projectionService: AttendanceProjectionService,
    // Attendance hardening: MEMBER_OFFBOARDED write-lock for the controller-owned
    // write paths (recompute + event void) that do not flow through the service
    // write methods. mark / bulk / update / delete enforce it inside the service.
    private readonly writeGuard: AttendanceWriteGuardService,
  ) {}

  // Attendance rollout Phase B (2026-05-23): path-model `@RequirePermission`
  // carries an explicit scope. The row-level list is scope `'self'`: both `self`-
  // and `all`-scoped callers are admitted, and `AttendanceService.findAll`
  // narrows the result to the caller's own rows when their effective
  // grant is `self`. The workspace-aggregate endpoints below
  // (overview / summary / upcoming-leaves) are scope `'all'` — they
  // expose org-wide rollups, so a `self`-scoped worker is denied them
  // outright (their own rollup is served by `/me/dashboard`).
  @Get()
  @RequirePermission('attendance.record.view', 'self')
  findAll(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Query() query: PaginationDto,
  ) {
    return this.attendanceService.findAll(workspaceId, req.user.sub, query);
  }

  @Get('overview')
  @RequirePermission('attendance.analytics.view')
  getOverview(@Param('workspaceId') workspaceId: string, @Query() dto: MonthYearQueryDto) {
    return this.attendanceService.getOverview(workspaceId, dto.month, dto.year);
  }

  // Scope `'all'` — member × day grid (heatmap / muster) is an org-wide rollup.
  @Get('grid')
  @ApiOperation({ summary: 'Get member × day attendance grid for a given month/year' })
  @ApiResponse({ status: 200, description: 'Attendance heatmap grid' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @RequirePermission('attendance.analytics.view')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'attendance_muster' })
  getAttendanceGrid(@Param('workspaceId') workspaceId: string, @Query() dto: MonthYearQueryDto) {
    return this.attendanceService.getAttendanceGrid(workspaceId, dto.month, dto.year);
  }

  // Scope `'all'` — overtime analytics is an org-wide rollup.
  @Get('overtime')
  @ApiOperation({ summary: 'Get overtime analytics for a given month/year' })
  @ApiResponse({ status: 200, description: 'Per-member overtime summary' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @RequirePermission('attendance.analytics.view')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'overtime_analytics' })
  getOvertimeAnalytics(@Param('workspaceId') workspaceId: string, @Query() dto: MonthYearQueryDto) {
    return this.attendanceService.getOvertimeAnalytics(workspaceId, dto.month, dto.year);
  }

  // Scope `'all'` — attendance-compliance report is an org-wide rollup.
  @Get('compliance')
  @ApiOperation({ summary: 'Get attendance compliance report for a given month/year' })
  @ApiResponse({ status: 200, description: 'Workspace-wide compliance breakdown' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @RequirePermission('attendance.analytics.view')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'compliance_report' })
  getComplianceReport(@Param('workspaceId') workspaceId: string, @Query() dto: MonthYearQueryDto) {
    return this.attendanceService.getComplianceReport(workspaceId, dto.month, dto.year);
  }

  // Scope `'all'` — absence-pattern analysis is an org-wide rollup.
  @Get('absence-patterns')
  @ApiOperation({ summary: 'Get absence-pattern analysis over the last N months' })
  @ApiResponse({ status: 200, description: 'Absence frequency patterns per member' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @RequirePermission('attendance.analytics.view')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'absence_patterns' })
  getAbsencePatterns(
    @Param('workspaceId') workspaceId: string,
    @Query() dto: LookbackMonthsQueryDto,
  ) {
    return this.attendanceService.getAbsencePatterns(workspaceId, dto.months ?? 3);
  }

  @Get('summary')
  @RequirePermission('attendance.analytics.view')
  getSummary(@Param('workspaceId') workspaceId: string, @Query('date') date?: string) {
    return this.attendanceService.getSummary(workspaceId, date);
  }

  // Scope `'all'` — live "who's in" board is an org-wide rollup.
  @Get('live-presence')
  @ApiOperation({ summary: 'Get live presence board (who is currently punched in)' })
  @ApiResponse({ status: 200, description: 'Real-time punched-in member list (30s cache)' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @RequirePermission('attendance.analytics.view')
  getLivePresence(@Param('workspaceId') workspaceId: string) {
    return this.attendanceService.getLivePresence(workspaceId);
  }

  @Get('upcoming-leaves')
  @RequirePermission('attendance.analytics.view')
  getUpcomingLeaves(
    @Param('workspaceId') workspaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.attendanceService.getUpcomingLeaves(workspaceId, from, to);
  }

  // No scope arg — `attendance.record.mark` is a `scoped: false` action
  // (manager-only; G2/A+), gated like the other scoped:false attendance
  // routes (analytics / export / events): the path alone is required, so any
  // held scope satisfies. Members never hold it (the Worker preset dropped
  // it). A legacy `mark@self` grant is still restricted to the caller's own
  // row by `AttendanceService.mark`'s self-write guard (defense-in-depth) —
  // never an `'all'` requirement here, which would wrongly deny a manager
  // whose matrix-authored grant defaulted to `self`.
  @Post()
  @Idempotent()
  @RequirePermission('attendance.record.mark')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'mark' })
  mark(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Body() dto: MarkAttendanceDto,
  ) {
    return this.attendanceService.mark(workspaceId, req.user.sub, dto);
  }

  // Scope `'all'` — bulk-mark is an admin operation across many members.
  @Post('bulk')
  @Idempotent()
  @RequirePermission('attendance.record.mark', 'all')
  @RequireSubscription({
    module: AppModule.ATTENDANCE,
    subFeature: 'bulk_mark',
  })
  markBulk(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Body() bulkDto: BulkMarkAttendanceDto,
  ) {
    return this.attendanceService.markBulk(workspaceId, req.user.sub, bulkDto);
  }

  // Scope `'all'` — recompute is an admin range operation.
  @Post('recompute')
  @RequirePermission('attendance.record.edit', 'all')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'edit' })
  async recompute(@Param('workspaceId') workspaceId: string, @Body() dto: RecomputeAttendanceDto) {
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('`to` must be >= `from`');
    }
    const diffDays = Math.floor((to.getTime() - from.getTime()) / 86_400_000);
    if (diffDays > 366) {
      throw new BadRequestException('Range exceeds 366 days');
    }
    // Attendance hardening: when a single member is targeted, block recompute
    // for a removed member (OQ-A5). A null memberId is a workspace-wide range
    // recompute that only re-derives projections from existing events (no new
    // data accepted), so it stays available to admins for muster correctness.
    if (dto.memberId) {
      await this.writeGuard.assertMemberWritable(workspaceId, dto.memberId);
    }
    const result = await this.projectionService.recomputeRange(
      workspaceId,
      dto.memberId ?? null,
      from,
      to,
    );
    return { success: true, data: result };
  }

  // Scope `'all'` — raw event log is an admin/debug surface.
  @Get('events')
  @RequirePermission('attendance.events.view')
  async listEvents(@Param('workspaceId') workspaceId: string, @Query() query: ListEventsQueryDto) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    const result = await this.eventService.queryEvents(
      workspaceId,
      { memberId: query.memberId, from, to },
      query.page ?? 1,
      query.limit ?? 50,
    );
    return { success: true, data: result };
  }

  // Scope `'all'` — stale-session sweep is an admin surface.
  @Get('stale-sessions')
  @RequirePermission('attendance.events.view')
  async getStaleSessions(@Param('workspaceId') workspaceId: string) {
    const data = await this.attendanceService.findStaleSessions(workspaceId);
    return { success: true, data };
  }

  // No scope arg — `attendance.record.edit` is a `scoped: false` action
  // (manager-only; G2/A+), gated by path alone like the sibling scoped:false
  // routes. Members correct via regularization, not direct edit; a legacy
  // `edit@self` grant is restricted to the caller's own record by
  // `AttendanceService.update`'s self-write guard (defense-in-depth).
  @Patch(':recordId')
  @RequirePermission('attendance.record.edit')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'edit' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('recordId') recordId: string,
    @Req() req: Request,
    @Body() dto: UpdateAttendanceDto,
  ) {
    return this.attendanceService.update(workspaceId, req.user.sub, recordId, dto);
  }

  // Scope `'all'` — export produces an org-wide attendance sheet.
  @Get('export')
  @RequirePermission('attendance.export.export')
  @RequireSubscription({
    module: AppModule.ATTENDANCE,
    subFeature: 'export_pdf',
  })
  export(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: Request,
  ) {
    return this.attendanceService.export(workspaceId, month, year, req.user?.sub);
  }

  // Scope `'all'` — per-record audit timeline is an admin surface.
  @Get(':id/audit')
  @RequirePermission('attendance.record.view', 'all')
  getAudit(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.attendanceService.getAuditTimeline(workspaceId, id);
  }

  // Scope `'all'` — voiding punch events is an admin correction.
  @Delete('events/:eventId')
  @RequirePermission('attendance.events.delete')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'mark' })
  async voidEvent(
    @Param('workspaceId') workspaceId: string,
    @Param('eventId') eventId: string,
    @Body() dto: VoidEventDto,
    @Req() req: Request,
  ) {
    const userId = req.user?.sub;
    const { teamMemberId, date } = await this.eventService.voidEvent(
      workspaceId,
      eventId,
      userId,
      dto.reason,
      // MEMBER_OFFBOARDED gate (OQ-A5): a removed member's events cannot be voided.
      (memberId) => this.writeGuard.assertMemberWritable(workspaceId, memberId),
    );
    if (teamMemberId) {
      await this.projectionService.recompute(workspaceId, String(teamMemberId), date);
    }
    return { message: 'Event voided', eventId };
  }

  // Scope `'all'` — deleting a member's attendance is an admin correction.
  @Delete('member/:memberId/date/:date')
  @RequirePermission('attendance.record.delete', 'all')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'edit' })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Param('date') date: string,
    @Req() req: Request,
  ) {
    return this.attendanceService.remove(workspaceId, memberId, date, req.user?.sub);
  }
}
