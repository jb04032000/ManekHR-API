import { Body, Controller, Post, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsMongoId, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { ReminderDispatcherService } from './reminder-dispatcher.service';

class ManualTriggerDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsMongoId()
  ruleId?: string;
}

@ApiTags('Reminders - Dispatcher')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.REMINDERS, subFeature: 'reminder_dispatcher_run' })
@Controller('workspaces/:wsId/finance/firms/:firmId/reminders')
export class ReminderDispatcherController {
  constructor(private readonly dispatcher: ReminderDispatcherService) {}

  @Post('trigger')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.CREATE)
  @ApiOperation({ summary: 'Manually trigger dispatcher for testing or one-off dispatch' })
  async trigger(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() body: ManualTriggerDto,
  ) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const result = await this.dispatcher.runForFirm(
      wsId,
      firmId,
      todayIso,
      { workspaceName: '', firmName: '' },
      body,
    );
    return { triggered: true, ...result };
  }
}
