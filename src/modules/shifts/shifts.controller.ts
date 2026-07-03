import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ShiftsService } from './shifts.service';
import { CreateShiftDto, UpdateShiftDto } from './dto/shift.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';

@Controller('workspaces/:workspaceId/shifts')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  // Shifts rollout S1: the shift catalog is workspace-global reference data
  // every member needs (own shift times in Team + Attendance contexts;
  // managers picking a shift to assign). The view leaf is seeded into every
  // preset (Member, Worker, Manager, HR), so the open-to-all-members intent
  // is preserved through the preset, not by bypassing RBAC.
  @Get()
  @Throttle({ 'shifts-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('shifts.catalog.view')
  @RequireSubscription({ module: AppModule.SHIFTS })
  findAll(@Param('workspaceId') workspaceId: string) {
    return this.shiftsService.findAll(workspaceId);
  }

  @Post()
  @Throttle({ 'shifts-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('shifts.catalog.create')
  @RequireSubscription({ module: AppModule.SHIFTS, subFeature: 'create_shift' })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req: { user: { sub: string } },
    @Body() createDto: CreateShiftDto,
  ) {
    return this.shiftsService.create(workspaceId, req.user.sub, createDto);
  }

  @Patch(':shiftId')
  @Throttle({ 'shifts-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('shifts.catalog.edit')
  @RequireSubscription({ module: AppModule.SHIFTS, subFeature: 'edit_shift' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
    @Req() req: { user: { sub: string } },
    @Body() updateDto: UpdateShiftDto,
  ) {
    return this.shiftsService.update(workspaceId, shiftId, req.user.sub, updateDto);
  }

  @Delete(':shiftId')
  @Throttle({ 'shifts-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('shifts.catalog.delete')
  @RequireSubscription({ module: AppModule.SHIFTS, subFeature: 'delete_shift' })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.shiftsService.remove(workspaceId, shiftId, req.user.sub);
  }
}
