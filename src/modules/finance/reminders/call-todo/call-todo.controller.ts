import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { CallTodoService } from './call-todo.service';
import {
  CompleteCallTodoDto,
  CreateCallTodoDto,
  ListCallTodosQueryDto,
  SnoozeCallTodoDto,
  UpdateCallTodoDto,
} from './call-todo.dto';

@ApiTags('Call Todos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.REMINDERS, subFeature: 'reminder_call_todo_manage' })
@Controller('workspaces/:wsId/finance/firms/:firmId/call-todos')
export class CallTodoController {
  constructor(private readonly callTodoService: CallTodoService) {}

  @Post()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.CREATE)
  @ApiOperation({ summary: 'Create a new call todo' })
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateCallTodoDto,
    @CurrentUser() user: any,
  ) {
    return this.callTodoService.create(wsId, firmId, dto, user._id ?? user.sub);
  }

  @Get()
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List call todos with optional filters' })
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListCallTodosQueryDto,
  ) {
    return this.callTodoService.list(wsId, firmId, query);
  }

  @Get('count')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Count pending call todos for the current user' })
  async count(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @CurrentUser() user: any,
  ) {
    return this.callTodoService.countPending(wsId, firmId, user._id ?? user.sub);
  }

  @Get(':id')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Get a single call todo by ID' })
  async get(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return this.callTodoService.get(wsId, firmId, id);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Update a call todo' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCallTodoDto,
  ) {
    return this.callTodoService.update(wsId, firmId, id, dto);
  }

  @Post(':id/snooze')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Snooze a call todo by N days' })
  async snooze(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: SnoozeCallTodoDto,
  ) {
    return this.callTodoService.snooze(wsId, firmId, id, dto);
  }

  @Post(':id/complete')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Mark a call todo as done' })
  async complete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: CompleteCallTodoDto,
    @CurrentUser() user: any,
  ) {
    return this.callTodoService.complete(wsId, firmId, id, user._id ?? user.sub, dto);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.REMINDERS, ModuleAction.DELETE)
  @ApiOperation({ summary: 'Cancel a call todo (soft delete)' })
  async softDelete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    await this.callTodoService.softDelete(wsId, firmId, id);
    return { cancelled: true };
  }
}
