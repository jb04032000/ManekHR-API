import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../common/guards/roles.guard';
import {
  ResourceScopeGuard,
  assertLocationInScope,
  getScopedLocationIds,
} from '../../common/guards/resource-scope.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { LocationsService } from './locations.service';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';

@Controller('workspaces/:workspaceId/locations')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get()
  @RequirePermissions(AppModule.LOCATIONS, ModuleAction.VIEW)
  async findAll(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    const rows = await this.locationsService.findAll(
      workspaceId,
      includeDeleted === 'true',
    );
    const scopedLocationIds = getScopedLocationIds(req);
    if (!scopedLocationIds || scopedLocationIds.length === 0) return rows;
    const allowed = new Set(scopedLocationIds.map((id) => id.toString()));
    return rows.filter((r: any) => allowed.has(r._id.toString()));
  }

  @Get('peek-next-code')
  @RequirePermissions(AppModule.LOCATIONS, ModuleAction.VIEW)
  peekNextCode(@Param('workspaceId') workspaceId: string) {
    return this.locationsService.peekNextCode(workspaceId).then((code) => ({
      success: true,
      data: { nextCode: code },
    }));
  }

  @Get(':locationId')
  @RequirePermissions(AppModule.LOCATIONS, ModuleAction.VIEW)
  findById(
    @Param('workspaceId') workspaceId: string,
    @Param('locationId') locationId: string,
    @Req() req,
  ) {
    assertLocationInScope(req, locationId);
    return this.locationsService.findById(workspaceId, locationId);
  }

  @Post()
  @RequirePermissions(AppModule.LOCATIONS, ModuleAction.CREATE)
  @RequireSubscription({
    module: AppModule.LOCATIONS,
    subFeature: 'location_manage',
  })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Body() dto: CreateLocationDto,
  ) {
    // Creating new Locations is an admin/owner action â€” scoped users
    // typically don't create locations. Enforce this by rejecting when
    // the caller has any location scope (cannot extend their own scope).
    const scoped = getScopedLocationIds(req);
    if (scoped && scoped.length > 0) {
      // Non-owner with location scope cannot create new locations.
      throw new ForbiddenException(
        'Creating locations is outside your assigned resource scope.',
      );
    }
    return this.locationsService.create(workspaceId, req.user?.sub, dto);
  }

  @Patch(':locationId')
  @RequirePermissions(AppModule.LOCATIONS, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.LOCATIONS,
    subFeature: 'location_manage',
  })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('locationId') locationId: string,
    @Req() req,
    @Body() dto: UpdateLocationDto,
  ) {
    assertLocationInScope(req, locationId);
    return this.locationsService.update(workspaceId, locationId, dto);
  }

  @Delete(':locationId')
  @RequirePermissions(AppModule.LOCATIONS, ModuleAction.REMOVE)
  @RequireSubscription({
    module: AppModule.LOCATIONS,
    subFeature: 'location_manage',
  })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('locationId') locationId: string,
    @Req() req,
  ) {
    assertLocationInScope(req, locationId);
    return this.locationsService.remove(workspaceId, locationId);
  }
}
