import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';
import { AnomaliesService } from './anomalies.service';
import { AnomalyRule } from './schemas/anomaly-rule.schema';
import { AnomalyRuleType } from './schemas/anomaly.schema';
import { ListAnomaliesDto } from './dto/list-anomalies.dto';
import { AnomalyRuleToggleDto } from './dto/anomaly-rule-toggle.dto';

const ALL_RULE_TYPES: AnomalyRuleType[] = [
  'unknown_sn',
  'rapid_dup',
  'missed_streak',
  'off_shift_punch',
  'time_travel',
];

/**
 * Workspace-scoped anomaly feed and rule management controller.
 * All routes require authentication (global JwtAuthGuard via APP_GUARD in app.module.ts).
 * All 5 routes additionally require ATTENDANCE:MANAGE_ANOMALIES permission (DI-03).
 */
@Controller('workspaces/:wsId')
export class AnomaliesController {
  constructor(
    private readonly anomaliesService: AnomaliesService,
    @InjectModel(AnomalyRule.name) private readonly ruleModel: Model<AnomalyRule>,
  ) {}

  /**
   * GET /workspaces/:wsId/anomalies
   * Paginated anomaly feed with optional unacknowledgedOnly filter.
   */
  @Get('anomalies')
  @UseGuards(RolesGuard, SubscriptionGuard)
  @RequirePermission('attendance.anomaly.manage')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'anomaly_detection' })
  async list(@Param('wsId') wsId: string, @Query() query: ListAnomaliesDto) {
    return this.anomaliesService.list(wsId, query);
  }

  /**
   * PATCH /workspaces/:wsId/anomalies/:id/acknowledge
   * Marks an anomaly acknowledged. Cross-workspace ids rejected with 404 (STRIDE-T).
   */
  @Patch('anomalies/:id/acknowledge')
  @HttpCode(200)
  @UseGuards(RolesGuard, SubscriptionGuard)
  @RequirePermission('attendance.anomaly.manage')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'anomaly_detection' })
  async acknowledge(@Param('wsId') wsId: string, @Param('id') id: string, @Req() req: any) {
    const userId = req.user?.userId ?? req.user?.sub ?? req.user?._id;
    return this.anomaliesService.acknowledge(wsId, id, String(userId));
  }

  /**
   * GET /workspaces/:wsId/anomalies/count
   * Unacknowledged anomaly count in the last 24 hours — powers dashboard widget.
   */
  @Get('anomalies/count')
  @UseGuards(RolesGuard, SubscriptionGuard)
  @RequirePermission('attendance.anomaly.manage')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'anomaly_detection' })
  async count(@Param('wsId') wsId: string) {
    const count = await this.anomaliesService.count24h(wsId);
    return { count };
  }

  /**
   * GET /workspaces/:wsId/anomaly-rules
   * Returns per-rule enabled flags for this workspace.
   * Missing rules are seeded with defaults (enabled=true) without DB write.
   */
  @Get('anomaly-rules')
  @UseGuards(RolesGuard, SubscriptionGuard)
  @RequirePermission('attendance.anomaly.manage')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'anomaly_detection' })
  async listRules(@Param('wsId') wsId: string) {
    const existing = await this.ruleModel
      .find({ wsId: new Types.ObjectId(wsId) })
      .lean()
      .exec();
    // Seed missing rule types with defaults (enabled=true) without a DB write
    const existingByType = new Map(existing.map((r: any) => [r.ruleType, r]));
    return ALL_RULE_TYPES.map(
      (rt) =>
        existingByType.get(rt) ?? {
          wsId,
          ruleType: rt,
          enabled: true,
        },
    );
  }

  /**
   * PATCH /workspaces/:wsId/anomaly-rules/:ruleType
   * Toggles enabled flag for a specific rule. Upserts to prevent cross-workspace drift (STRIDE-T).
   */
  @Patch('anomaly-rules/:ruleType')
  @UseGuards(RolesGuard, SubscriptionGuard)
  @RequirePermission('attendance.anomaly.manage')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'anomaly_detection' })
  async toggleRule(
    @Param('wsId') wsId: string,
    @Param('ruleType') ruleType: string,
    @Body() body: AnomalyRuleToggleDto,
  ) {
    if (!ALL_RULE_TYPES.includes(ruleType as AnomalyRuleType)) {
      throw new BadRequestException('invalid_rule_type');
    }
    const updated = await this.ruleModel.findOneAndUpdate(
      { wsId: new Types.ObjectId(wsId), ruleType },
      { $set: { enabled: body.enabled } },
      { new: true, upsert: true },
    );
    return updated;
  }
}
