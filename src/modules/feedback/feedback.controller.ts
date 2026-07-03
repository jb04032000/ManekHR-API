import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

@Controller('workspaces/:workspaceId/feedback')
@UseGuards(JwtAuthGuard, RolesGuard, ThrottlerGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  @RequirePermissions(AppModule.WORKSPACES, ModuleAction.VIEW)
  @Throttle({ 'feedback-create': { limit: 5, ttl: 60_000 } })
  create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateFeedbackDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const userId = user.sub ?? user._id ?? '';
    return this.feedbackService.create(workspaceId, userId, dto);
  }
}
