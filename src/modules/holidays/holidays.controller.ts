import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { HolidaysService } from './holidays.service';
import { CreateHolidayDto, UpdateHolidayDto, BulkCreateHolidaysDto } from './dto/holiday.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';

@Controller('workspaces/:workspaceId/holidays')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, ThrottlerGuard)
export class HolidaysController {
  constructor(private readonly holidaysService: HolidaysService) {}

  @Get()
  @Throttle({ 'holidays-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.view')
  findAll(@Param('workspaceId') workspaceId: string) {
    return this.holidaysService.findAll(workspaceId);
  }

  @Get('year/:year')
  @Throttle({ 'holidays-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.view')
  findByYear(@Param('workspaceId') workspaceId: string, @Param('year') year: string) {
    return this.holidaysService.findByYear(workspaceId, parseInt(year, 10));
  }

  @Get('check/:date')
  @Throttle({ 'holidays-read': { limit: 60, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.view')
  checkHoliday(@Param('workspaceId') workspaceId: string, @Param('date') date: string) {
    return this.holidaysService.findByDate(workspaceId, date);
  }

  @Post()
  @Throttle({ 'holidays-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.create')
  @RequireSubscription({
    module: AppModule.HOLIDAYS,
    subFeature: 'create_holiday',
  })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req: { user: { sub: string } },
    @Body() createDto: CreateHolidayDto,
  ) {
    return this.holidaysService.create(workspaceId, req.user.sub, createDto);
  }

  // (A) Bulk create — declare a whole calendar in one call. Identical guard
  // surface to single-create (RBAC holidays.calendar.create + create_holiday
  // entitlement + holidays-write throttle), so no new permission is introduced.
  @Post('bulk')
  @Throttle({ 'holidays-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.create')
  @RequireSubscription({
    module: AppModule.HOLIDAYS,
    subFeature: 'create_holiday',
  })
  bulkCreate(
    @Param('workspaceId') workspaceId: string,
    @Req() req: { user: { sub: string } },
    @Body() bulkDto: BulkCreateHolidaysDto,
  ) {
    return this.holidaysService.bulkCreate(workspaceId, req.user.sub, bulkDto.holidays);
  }

  @Patch(':holidayId')
  @Throttle({ 'holidays-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.edit')
  @RequireSubscription({
    module: AppModule.HOLIDAYS,
    subFeature: 'edit_holiday',
  })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('holidayId') holidayId: string,
    @Req() req: { user: { sub: string } },
    @Body() updateDto: UpdateHolidayDto,
  ) {
    return this.holidaysService.update(workspaceId, holidayId, req.user.sub, updateDto);
  }

  @Delete(':holidayId')
  @Throttle({ 'holidays-write': { limit: 20, ttl: 60_000 } })
  @RequirePermission('holidays.calendar.delete')
  @RequireSubscription({
    module: AppModule.HOLIDAYS,
    subFeature: 'delete_holiday',
  })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('holidayId') holidayId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.holidaysService.remove(workspaceId, holidayId, req.user.sub);
  }
}
