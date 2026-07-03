import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { WastageService } from './wastage.service';
import { CreateWastageEntryDto } from './dto/create-wastage-entry.dto';
import { UpdateWastageEntryDto } from './dto/update-wastage-entry.dto';

/**
 * WastageController
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/inventory/wastage
 *
 * All routes require JwtAuthGuard + RolesGuard.
 * Read routes: AppModule.FINANCE + ModuleAction.VIEW
 * Write routes: AppModule.FINANCE + ModuleAction.CREATE
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/wastage')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'wastage' })
export class WastageController {
  constructor(private readonly service: WastageService) {}

  /** GET /...inventory/wastage — list with optional status/date filters */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const data = await this.service.list(wsId, firmId, {
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return { success: true, data };
  }

  /** GET /...inventory/wastage/:id — fetch single entry */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findById(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return { success: true, data: await this.service.findById(wsId, firmId, id) };
  }

  /** POST /...inventory/wastage — create draft */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateWastageEntryDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.service.create(wsId, firmId, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /** PATCH /...inventory/wastage/:id — update draft */
  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWastageEntryDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.service.update(wsId, firmId, id, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /** POST /...inventory/wastage/:id/post — post (atomic: stock movements + ledger) */
  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.service.post(wsId, firmId, id, user._id ?? user.sub);
    return { success: true, data };
  }

  /** DELETE /...inventory/wastage/:id — soft-delete draft */
  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    await this.service.delete(wsId, firmId, id, user._id ?? user.sub);
    return { success: true, data: { deleted: true } };
  }
}
