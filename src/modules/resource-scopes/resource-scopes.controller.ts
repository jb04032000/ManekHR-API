import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { ResourceScopesService } from './resource-scopes.service';
import { UpsertResourceScopeDto, UpdateResourceScopeDto } from './dto/resource-scope.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller('workspaces/:workspaceId/resource-scopes')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class ResourceScopesController {
  constructor(private readonly scopesService: ResourceScopesService) {}

  /**
   * Returns the caller's own scope. Every authenticated workspace user
   * can read this without any RBAC permission â€” it drives client UI
   * filter defaults.
   */
  @Get('me')
  me(@Param('workspaceId') workspaceId: string, @Req() req) {
    return this.scopesService.loadForUser(workspaceId, req.user?.sub).then((loaded) => ({
      success: true,
      data: {
        hasScope: loaded.hasScope,
        isActive: loaded.isActive,
        machineIds: loaded.machineIds.map((id) => id.toString()),
        locationIds: loaded.locationIds.map((id) => id.toString()),
      },
    }));
  }

  @Get()
  @RequirePermissions(AppModule.RESOURCE_SCOPES, ModuleAction.VIEW)
  findAll(@Param('workspaceId') workspaceId: string) {
    return this.scopesService.findAll(workspaceId);
  }

  @Get(':scopeId')
  @RequirePermissions(AppModule.RESOURCE_SCOPES, ModuleAction.VIEW)
  findById(@Param('workspaceId') workspaceId: string, @Param('scopeId') scopeId: string) {
    return this.scopesService.findById(workspaceId, scopeId);
  }

  @Post()
  @RequirePermissions(AppModule.RESOURCE_SCOPES, ModuleAction.CREATE)
  @RequireSubscription({
    module: AppModule.RESOURCE_SCOPES,
    subFeature: 'resource_scope_manage',
  })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Body() dto: UpsertResourceScopeDto,
  ) {
    return this.scopesService.create(workspaceId, req.user?.sub, dto);
  }

  @Patch(':scopeId')
  @RequirePermissions(AppModule.RESOURCE_SCOPES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.RESOURCE_SCOPES,
    subFeature: 'resource_scope_manage',
  })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('scopeId') scopeId: string,
    @Body() dto: UpdateResourceScopeDto,
  ) {
    return this.scopesService.update(workspaceId, scopeId, dto);
  }

  @Delete(':scopeId')
  @RequirePermissions(AppModule.RESOURCE_SCOPES, ModuleAction.REMOVE)
  @RequireSubscription({
    module: AppModule.RESOURCE_SCOPES,
    subFeature: 'resource_scope_manage',
  })
  remove(@Param('workspaceId') workspaceId: string, @Param('scopeId') scopeId: string) {
    return this.scopesService.remove(workspaceId, scopeId);
  }
}
