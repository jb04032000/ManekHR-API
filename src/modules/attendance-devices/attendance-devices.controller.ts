import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Request,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AttendanceDevicesService } from './attendance-devices.service';
import {
  CreateDeviceDto,
  UpdateDeviceDto,
  RotateIngestTokenDto,
  AssignDeviceUserDto,
} from './dto/attendance-devices.dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

/**
 * Workspace-scoped device management controller.
 * All routes use the existing JWT + Workspace guards (via global APP_GUARD).
 * No @Public() decorator — authentication is required.
 * Mutating routes additionally require ATTENDANCE:MANAGE_DEVICES permission (WR-04).
 */
@Controller('workspaces/:wsId')
export class AttendanceDevicesController {
  constructor(private readonly devicesService: AttendanceDevicesService) {}

  // -------------------------------------------------------------------------
  // Device CRUD — /workspaces/:wsId/attendance-devices
  // -------------------------------------------------------------------------

  @Get('attendance-devices')
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async listDevices(@Param('wsId') wsId: string, @Query('status') status?: string) {
    return this.devicesService.listDevices(wsId, status);
  }

  @Post('attendance-devices')
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async createDevice(@Param('wsId') wsId: string, @Body() dto: CreateDeviceDto) {
    return this.devicesService.createDevice(wsId, dto);
  }

  @Get('attendance-devices/:id')
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async getDevice(@Param('wsId') wsId: string, @Param('id') id: string) {
    return this.devicesService.getDevice(wsId, id);
  }

  @Patch('attendance-devices/:id')
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async updateDevice(
    @Param('wsId') wsId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
  ) {
    return this.devicesService.updateDevice(wsId, id, dto);
  }

  // -------------------------------------------------------------------------
  // Device status transitions — /workspaces/:wsId/attendance-devices/:id/*
  // -------------------------------------------------------------------------

  @Patch('attendance-devices/:id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async approveDevice(@Param('wsId') wsId: string, @Param('id') id: string) {
    return this.devicesService.approveDevice(wsId, id);
  }

  @Patch('attendance-devices/:id/pause')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async pauseDevice(@Param('wsId') wsId: string, @Param('id') id: string) {
    return this.devicesService.pauseDevice(wsId, id);
  }

  @Patch('attendance-devices/:id/unpause')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async unpauseDevice(@Param('wsId') wsId: string, @Param('id') id: string) {
    return this.devicesService.unpauseDevice(wsId, id);
  }

  @Patch('attendance-devices/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async revokeDevice(@Param('wsId') wsId: string, @Param('id') id: string) {
    return this.devicesService.revokeDevice(wsId, id);
  }

  // -------------------------------------------------------------------------
  // Ingest token + unassigned punches — /workspaces/:wsId/attendance/*
  // -------------------------------------------------------------------------

  /**
   * GET /workspaces/:wsId/attendance/ingest-token — retrieve or generate token.
   * RolesGuard also enforces that the caller is a member of wsId (WR-05).
   */
  @Get('attendance/ingest-token')
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async ensureIngestToken(@Param('wsId') wsId: string) {
    return this.devicesService.ensureIngestToken(wsId);
  }

  /**
   * POST /workspaces/:wsId/attendance/rotate-ingest-token
   * Requires confirm:true and workspace owner (T-B-03-01).
   */
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  @Post('attendance/rotate-ingest-token')
  @HttpCode(HttpStatus.OK)
  async rotateIngestToken(
    @Param('wsId') wsId: string,
    @Body() dto: RotateIngestTokenDto,
    @Request() req: any,
  ) {
    const requestUserId = String(req.user?._id ?? req.user?.id ?? '');
    return this.devicesService.rotateIngestToken(wsId, requestUserId, dto);
  }

  /** GET /workspaces/:wsId/attendance/unassigned-punches — distinct unmapped pairs */
  @Get('attendance/unassigned-punches')
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async getUnassignedPunches(@Param('wsId') wsId: string) {
    return this.devicesService.getUnassignedPunches(wsId);
  }

  /**
   * POST /workspaces/:wsId/attendance/assign-device-user
   * Backfills all-time unassigned events + adds biometricBinding (D-05).
   */
  @Post('attendance/assign-device-user')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequirePermission('attendance.device.manage')
  async assignDeviceUser(@Param('wsId') wsId: string, @Body() dto: AssignDeviceUserDto) {
    return this.devicesService.assignDeviceUser(wsId, dto);
  }
}
