import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { ContentReportsService } from './content-reports.service';
import { ResolveContentReportDto } from './dto/content-report.dto';

interface AdminAuthedRequest {
  user: { sub: string };
}

/**
 * Platform-admin content moderation queue.
 *
 * Base path: `admin/connect/content-reports`
 * Guards: JwtAuthGuard + IsAdminGuard (user.isAdmin === true).
 *
 * The admin id is always derived from `req.user.sub`, never the body, so the
 * audit trail reflects the real operator. Mirrors the marketplace + ads review
 * consoles. `action` removes the content (emits the takedown event); `dismiss`
 * closes the report with no action.
 */
@LegacyUnclassified()
@Controller('admin/connect/content-reports')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class ContentReportsAdminController {
  constructor(private readonly reports: ContentReportsService) {}

  /** Open reports awaiting moderation (optionally filtered by target type). */
  @Get()
  list(@Query('targetType') targetType?: string) {
    return this.reports.listOpen(targetType ? { targetType } : undefined);
  }

  /** Open-report count (nav badge). */
  @Get('count')
  async count() {
    return { count: await this.reports.countOpen() };
  }

  /** Action a report: remove the reported content + close the report. */
  @Post(':id/action')
  action(
    @Param('id') id: string,
    @Req() req: AdminAuthedRequest,
    @Body() dto: ResolveContentReportDto,
  ) {
    return this.reports.action(id, req.user.sub, dto.note);
  }

  /** Dismiss a report: no action, close it. */
  @Post(':id/dismiss')
  dismiss(
    @Param('id') id: string,
    @Req() req: AdminAuthedRequest,
    @Body() dto: ResolveContentReportDto,
  ) {
    return this.reports.dismiss(id, req.user.sub, dto.note);
  }
}
