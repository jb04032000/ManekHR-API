import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AttendancePoliciesService } from './attendance-policies.service';
import {
  CreateAttendancePolicyDto,
  UpdateAttendancePolicyDto,
  DryRunDto,
} from './dto/attendance-policy.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

@ApiTags('Attendance Policies')
@Controller('workspaces/:wsId')
@UseGuards(ThrottlerGuard)
export class AttendancePoliciesController {
  constructor(private readonly service: AttendancePoliciesService) {}

  @Get('attendance-policies')
  @ApiOperation({ summary: 'List all attendance policies for the workspace' })
  @ApiResponse({ status: 200, description: 'Array of attendance policies' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.policy.manage')
  findAll(@Param('wsId') wsId: string) {
    return this.service.findAll(wsId);
  }

  @Get('attendance-policies/:id')
  @ApiOperation({ summary: 'Get a single attendance policy by ID' })
  @ApiResponse({ status: 200, description: 'Attendance policy document' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @Throttle({ 'attendance-analytics': { limit: 30, ttl: 60_000 } })
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.policy.manage')
  findOne(@Param('wsId') wsId: string, @Param('id') id: string) {
    return this.service.findOne(wsId, id);
  }

  /** POST /workspaces/:wsId/attendance-policies — create (MANAGE_POLICIES) */
  @Post('attendance-policies')
  @ApiOperation({ summary: 'Create a new attendance policy' })
  @ApiResponse({ status: 201, description: 'Policy created' })
  @Throttle({ 'attendance-policy-write': { limit: 10, ttl: 60_000 } })
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.policy.manage')
  create(@Param('wsId') wsId: string, @Body() dto: CreateAttendancePolicyDto, @Req() req: Request) {
    return this.service.create(wsId, dto, req.user?.sub);
  }

  /** PATCH /workspaces/:wsId/attendance-policies/:id — update (MANAGE_POLICIES) */
  @Patch('attendance-policies/:id')
  @ApiOperation({ summary: 'Update an existing attendance policy' })
  @ApiResponse({ status: 200, description: 'Updated policy document' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @Throttle({ 'attendance-policy-write': { limit: 10, ttl: 60_000 } })
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.policy.manage')
  update(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAttendancePolicyDto,
    @Req() req: Request,
  ) {
    return this.service.update(wsId, id, dto, req.user?.sub);
  }

  /** DELETE /workspaces/:wsId/attendance-policies/:id — delete (MANAGE_POLICIES) */
  @Delete('attendance-policies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an attendance policy (cannot delete the default)' })
  @ApiResponse({ status: 204, description: 'Policy deleted' })
  @ApiResponse({ status: 400, description: 'Cannot delete the default policy' })
  @Throttle({ 'attendance-policy-write': { limit: 10, ttl: 60_000 } })
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.policy.manage')
  remove(@Param('wsId') wsId: string, @Param('id') id: string, @Req() req: Request) {
    return this.service.remove(wsId, id, req.user?.sub);
  }

  /**
   * POST /workspaces/:wsId/attendance-policies/:id/dry-run
   * Returns projection diff preview without writing to DB. (MANAGE_POLICIES)
   */
  @Post('attendance-policies/:id/dry-run')
  @ApiOperation({ summary: 'Preview impact of applying a policy over a date range (read-only)' })
  @ApiResponse({ status: 200, description: 'Diff of changed attendance projections' })
  @Throttle({ 'attendance-policy-dryrun': { limit: 10, ttl: 60_000 } })
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.policy.manage')
  dryRun(@Param('wsId') wsId: string, @Param('id') id: string, @Body() dto: DryRunDto) {
    return this.service.dryRun(wsId, id, dto);
  }
}
