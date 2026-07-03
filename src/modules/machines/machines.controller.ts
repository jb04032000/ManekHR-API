import {
  Body,
  Controller,
  Delete,
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
  getScopedMachineIds,
  getScopedLocationIds,
  assertMachineInScope,
  assertLocationInScope,
} from '../../common/guards/resource-scope.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { MachinesService } from './machines.service';
import { CreateMachineDto, UpdateMachineDto } from './dto/machine.dto';
import {
  CreateMachineAssignmentDto,
  UpdateMachineAssignmentDto,
} from './dto/machine-assignment.dto';

@Controller('workspaces/:workspaceId/machines')
@UseGuards(JwtAuthGuard, RolesGuard, ResourceScopeGuard, SubscriptionGuard)
export class MachinesController {
  constructor(private readonly machinesService: MachinesService) {}

  // Static routes FIRST to avoid collision with /:machineId dynamic segment.
  @Get('status-counts')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  statusCounts(@Param('workspaceId') workspaceId: string) {
    return this.machinesService.statusCounts(workspaceId);
  }

  @Get('peek-next-code')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  peekNextCode(@Param('workspaceId') workspaceId: string) {
    return this.machinesService.peekNextCode(workspaceId).then((code) => ({
      success: true,
      data: { nextCode: code },
    }));
  }

  /**
   * Active machine assignments for a given team member. Powers the
   * "Assigned machines" chip row on the Team Work tab.
   */
  @Get('by-member/:memberId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  listAssignmentsForMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.machinesService.listAssignmentsForMember(
      workspaceId,
      memberId,
    );
  }

  @Get()
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  findAll(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const scopedMachineIds = getScopedMachineIds(req);
    const scopedLocationIds = getScopedLocationIds(req);
    // If user is scoped to specific locations and no explicit locationId
    // filter is requested, apply the scope's location filter via the
    // machineIds narrowing below (scopedMachineIds already encodes it).
    if (locationId && scopedLocationIds && scopedLocationIds.length > 0) {
      assertLocationInScope(req, locationId);
    }
    return this.machinesService.findAll(workspaceId, {
      locationId,
      status,
      search,
      scopedMachineIds,
    });
  }

  @Post()
  @RequirePermissions(AppModule.MACHINES, ModuleAction.CREATE)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req,
    @Body() dto: CreateMachineDto,
  ) {
    // Scoped users can only create machines in their scoped locations.
    assertLocationInScope(req, dto.locationId);
    return this.machinesService.create(workspaceId, req.user?.sub, dto);
  }

  @Get(':machineId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  findById(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req,
  ) {
    assertMachineInScope(req, machineId);
    return this.machinesService.findById(workspaceId, machineId);
  }

  @Patch(':machineId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.EDIT)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req,
    @Body() dto: UpdateMachineDto,
  ) {
    assertMachineInScope(req, machineId);
    if (dto.locationId) {
      assertLocationInScope(req, dto.locationId);
    }
    return this.machinesService.update(workspaceId, machineId, dto);
  }

  @Delete(':machineId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.REMOVE)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_basic',
  })
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req,
  ) {
    assertMachineInScope(req, machineId);
    return this.machinesService.remove(workspaceId, machineId);
  }

  // ============================================================
  // Assignments
  // ============================================================

  @Get(':machineId/assignments')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.VIEW)
  listAssignments(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req,
    @Query('activeOnly') activeOnly?: string,
  ) {
    assertMachineInScope(req, machineId);
    return this.machinesService.listAssignments(workspaceId, machineId, {
      activeOnly: activeOnly === 'true',
    });
  }

  @Post(':machineId/assignments')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.ASSIGN)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_assignments',
  })
  createAssignment(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Req() req,
    @Body() dto: CreateMachineAssignmentDto,
  ) {
    assertMachineInScope(req, machineId);
    return this.machinesService.createAssignment(
      workspaceId,
      machineId,
      req.user?.sub,
      dto,
    );
  }

  @Patch(':machineId/assignments/:assignmentId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.ASSIGN)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_assignments',
  })
  updateAssignment(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('assignmentId') assignmentId: string,
    @Req() req,
    @Body() dto: UpdateMachineAssignmentDto,
  ) {
    assertMachineInScope(req, machineId);
    return this.machinesService.updateAssignment(
      workspaceId,
      machineId,
      assignmentId,
      dto,
    );
  }

  @Delete(':machineId/assignments/:assignmentId')
  @RequirePermissions(AppModule.MACHINES, ModuleAction.ASSIGN)
  @RequireSubscription({
    module: AppModule.MACHINES,
    subFeature: 'machines_assignments',
  })
  removeAssignment(
    @Param('workspaceId') workspaceId: string,
    @Param('machineId') machineId: string,
    @Param('assignmentId') assignmentId: string,
    @Req() req,
  ) {
    assertMachineInScope(req, machineId);
    return this.machinesService.removeAssignment(
      workspaceId,
      machineId,
      assignmentId,
    );
  }
}
