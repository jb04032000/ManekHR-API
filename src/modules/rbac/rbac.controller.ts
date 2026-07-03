import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { CreateRoleDto, UpdatePermissionsDto } from './dto/rbac.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';

@Controller('workspaces/:workspaceId/roles')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}
  @Get('templates')
  @RequirePermissions(AppModule.ROLES, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.ROLES })
  getTemplates() {
    return this.rbacService.getTemplates();
  }

  @Get()
  @RequirePermissions(AppModule.ROLES, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.ROLES })
  findAll(@Param('workspaceId') workspaceId: string) {
    return this.rbacService.findAll(workspaceId);
  }

  @Post()
  @RequirePermissions(AppModule.ROLES, ModuleAction.CREATE)
  @RequireSubscription({ module: AppModule.ROLES, subFeature: 'create_role' })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req: { user: { sub: string } },
    @Body() createRoleDto: CreateRoleDto,
  ) {
    return this.rbacService.create(workspaceId, req.user.sub, createRoleDto);
  }

  @Get(':roleId')
  @RequirePermissions(AppModule.ROLES, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.ROLES })
  findOne(@Param('workspaceId') workspaceId: string, @Param('roleId') roleId: string) {
    return this.rbacService.findById(workspaceId, roleId);
  }

  @Patch(':roleId')
  @RequirePermissions(AppModule.ROLES, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.ROLES, subFeature: 'edit_role' })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('roleId') roleId: string,
    @Req() req: { user: { sub: string } },
    @Body() updatePermissionsDto: UpdatePermissionsDto,
  ) {
    return this.rbacService.update(workspaceId, roleId, req.user.sub, updatePermissionsDto);
  }

  @Delete(':roleId')
  @RequirePermissions(AppModule.ROLES, ModuleAction.DELETE)
  @RequireSubscription({ module: AppModule.ROLES, subFeature: 'delete_role' })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('roleId') roleId: string,
    @Req() req: { user: { sub: string } },
  ) {
    return this.rbacService.remove(workspaceId, roleId, req.user.sub);
  }
}
