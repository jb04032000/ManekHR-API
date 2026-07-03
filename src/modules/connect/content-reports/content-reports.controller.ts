import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Types } from 'mongoose';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthenticatedOnly } from '../../../common/decorators/require-permission.decorator';
import { ContentReportsService } from './content-reports.service';
import { CreateContentReportDto } from './dto/content-report.dto';

interface AuthedRequest {
  user: { sub: string };
}

/**
 * `/connect/content-reports` -- any signed-in member can report public UGC
 * (post, comment, profile, listing) for abuse. JwtAuthGuard + @AuthenticatedOnly
 * (open to every member, no workspace permission; without the RBAC marker the
 * fail-closed RolesGuard would 403 the write). Throttled like other Connect
 * writes. Reports land in the admin moderation queue.
 *
 * Links: ContentReportsService.create, content-reports.admin.controller (queue).
 */
@Controller('connect/content-reports')
@UseGuards(JwtAuthGuard)
@AuthenticatedOnly()
export class ContentReportsController {
  constructor(private readonly reports: ContentReportsService) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ 'connect-write': { limit: 20, ttl: 60_000 } })
  @Post()
  async create(@Req() req: AuthedRequest, @Body() dto: CreateContentReportDto) {
    const report = await this.reports.create(req.user.sub, dto);
    return { ok: true, id: String((report as { _id: Types.ObjectId })._id) };
  }
}
