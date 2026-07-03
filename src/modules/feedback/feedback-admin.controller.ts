import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { FeedbackAdminService } from './feedback-admin.service';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import { AdminPaginationDto } from '../admin/dto/admin.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller('admin/feedback')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class FeedbackAdminController {
  constructor(private readonly feedbackAdminService: FeedbackAdminService) {}

  @Get()
  list(@Query() query: AdminPaginationDto) {
    return this.feedbackAdminService.list(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.feedbackAdminService.getOne(id);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateFeedbackStatusDto, @Req() req: Request) {
    const user = req.user as { sub?: string; _id?: string };
    const actorId = user.sub ?? user._id ?? '';
    return this.feedbackAdminService.updateStatus(id, dto, actorId);
  }
}
