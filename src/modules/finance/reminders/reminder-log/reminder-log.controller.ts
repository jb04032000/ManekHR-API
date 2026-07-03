import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { ReminderLog } from './reminder-log.schema';

class ListReminderLogsQueryDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsMongoId()
  ruleId?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

@ApiTags('Reminder Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.REMINDERS, subFeature: 'reminder_audit_log' })
@Controller('workspaces/:wsId/finance/firms/:firmId/reminder-logs')
export class ReminderLogController {
  constructor(
    @InjectModel(ReminderLog.name) private readonly logModel: Model<ReminderLog>,
  ) {}

  @Get()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List reminder logs with pagination and filters' })
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListReminderLogsQueryDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const skip = (page - 1) * pageSize;

    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
    };
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.ruleId) filter.ruleId = new Types.ObjectId(query.ruleId);
    if (query.channel) filter.channel = query.channel;
    if (query.status) filter.status = query.status;
    if (query.fromDate || query.toDate) {
      filter.createdAt = {};
      if (query.fromDate) filter.createdAt.$gte = new Date(query.fromDate);
      if (query.toDate) filter.createdAt.$lte = new Date(query.toDate);
    }

    const [items, total] = await Promise.all([
      this.logModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
      this.logModel.countDocuments(filter),
    ]);

    return { items, total, page, pageSize };
  }
}
