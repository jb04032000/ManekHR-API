import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { AttendanceDevice } from './schemas/attendance-device.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { AttendanceIngestService } from '../attendance-ingest/attendance-ingest.service';
import { AttendanceProjectionService } from '../attendance/attendance-projection.service';
import {
  CreateDeviceDto,
  UpdateDeviceDto,
  RotateIngestTokenDto,
  AssignDeviceUserDto,
} from './dto/attendance-devices.dto';
import { isWorkspaceOwner } from '../../common/utils/workspace-ownership.util';

@Injectable()
export class AttendanceDevicesService {
  private readonly logger = new Logger(AttendanceDevicesService.name);

  constructor(
    @InjectModel(AttendanceDevice.name)
    private readonly deviceModel: Model<AttendanceDevice>,
    @InjectModel('AttendanceEvent')
    private readonly eventModel: Model<{
      wsId: Types.ObjectId;
      teamMemberId: Types.ObjectId;
      timestamp: Date;
    }>,
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
    @InjectModel('Workspace')
    private readonly workspaceModel: Model<Workspace>,
    private readonly ingestService: AttendanceIngestService,
    private readonly projectionService: AttendanceProjectionService,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /** List devices for workspace (filtered by status, default limit 50). */
  async listDevices(wsId: string, status?: string): Promise<AttendanceDevice[]> {
    const filter: Record<string, any> = { wsId: new Types.ObjectId(wsId) };
    if (status) filter.status = status;
    return this.deviceModel.find(filter).limit(50).sort({ createdAt: -1 }).exec();
  }

  /** Get single device — throws NotFoundException if not found or wrong workspace. */
  async getDevice(wsId: string, deviceId: string): Promise<AttendanceDevice> {
    const device = await this.deviceModel
      .findOne({ _id: new Types.ObjectId(deviceId), wsId: new Types.ObjectId(wsId) })
      .exec();
    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }
    return device;
  }

  /** Create device manually (admin adds before device is configured). */
  async createDevice(wsId: string, dto: CreateDeviceDto): Promise<AttendanceDevice> {
    const doc = await this.deviceModel.create({
      wsId: new Types.ObjectId(wsId),
      serial: dto.serial,
      alias: dto.alias ?? null,
      vendor: dto.vendor ?? 'unknown',
      status: 'pending_approval',
    });
    return doc;
  }

  /** Update device alias/vendor/firmwareVersion. */
  async updateDevice(
    wsId: string,
    deviceId: string,
    dto: UpdateDeviceDto,
  ): Promise<AttendanceDevice> {
    const device = await this.getDevice(wsId, deviceId);
    if (dto.alias !== undefined) device.alias = dto.alias ?? null;
    if (dto.vendor !== undefined) device.vendor = dto.vendor;
    if (dto.firmwareVersion !== undefined) device.firmwareVersion = dto.firmwareVersion ?? null;
    return device.save();
  }

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  /** approve: pending_approval → active */
  async approveDevice(wsId: string, deviceId: string): Promise<AttendanceDevice> {
    const device = await this.getDevice(wsId, deviceId);
    if (device.status !== 'pending_approval') {
      throw new BadRequestException(
        `Cannot approve device with status '${device.status}'. Device must be in pending_approval status.`,
      );
    }
    device.status = 'active';
    return device.save();
  }

  /** pause: active → paused */
  async pauseDevice(wsId: string, deviceId: string): Promise<AttendanceDevice> {
    const device = await this.getDevice(wsId, deviceId);
    if (device.status !== 'active') {
      throw new BadRequestException(
        `Cannot pause device with status '${device.status}'. Device must be active.`,
      );
    }
    device.status = 'paused';
    return device.save();
  }

  /** unpause: paused → active */
  async unpauseDevice(wsId: string, deviceId: string): Promise<AttendanceDevice> {
    const device = await this.getDevice(wsId, deviceId);
    if (device.status !== 'paused') {
      throw new BadRequestException(
        `Cannot unpause device with status '${device.status}'. Device must be paused.`,
      );
    }
    device.status = 'active';
    return device.save();
  }

  /** revoke: active|paused → revoked (irreversible — T-B-03-03) */
  async revokeDevice(wsId: string, deviceId: string): Promise<AttendanceDevice> {
    const device = await this.getDevice(wsId, deviceId);
    if (device.status === 'revoked') {
      throw new BadRequestException('Device already revoked');
    }
    device.status = 'revoked';
    return device.save();
  }

  // -------------------------------------------------------------------------
  // Ingest token management
  // -------------------------------------------------------------------------

  /**
   * Rotate workspace ingest token.
   * Requires workspace owner (T-B-03-01 — manageAttendanceDevices is NOT sufficient).
   * Generates 64-char base64url token, stores on workspace, evicts old token from cache.
   */
  async rotateIngestToken(
    wsId: string,
    requestUserId: string,
    dto: RotateIngestTokenDto,
  ): Promise<{ token: string }> {
    if (!dto.confirm) {
      throw new BadRequestException('confirm must be true to rotate the ingest token');
    }

    const workspace = await this.workspaceModel
      .findById(wsId)
      .select('_id ownerId attendanceIngestToken')
      .exec();

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    // Owner-only check (T-B-03-01)
    if (!isWorkspaceOwner(workspace, requestUserId)) {
      throw new ForbiddenException('Only the workspace owner can rotate the ingest token');
    }

    const oldToken: string | null = workspace.attendanceIngestToken ?? null;

    // Generate new 64-char base64url token (48 random bytes → 64 chars)
    const newToken = crypto.randomBytes(48).toString('base64url');

    workspace.attendanceIngestToken = newToken;
    workspace.attendanceIngestTokenRotatedAt = new Date();
    await workspace.save();

    // Evict old token from ingest service cache so next device push with old token gets 403
    if (oldToken) {
      this.ingestService.evictFromCache(oldToken);
    }

    this.logger.log(
      `[AttendanceDevices] Ingest token rotated for ws=${wsId} by user=${requestUserId}`,
    );

    return { token: newToken };
  }

  /**
   * Ensure workspace has an ingest token (generate if missing).
   * Called on first visit to devices page — non-destructive.
   */
  async ensureIngestToken(wsId: string): Promise<{ token: string }> {
    const workspace = await this.workspaceModel
      .findById(wsId)
      .select('_id attendanceIngestToken')
      .exec();

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.attendanceIngestToken) {
      return { token: workspace.attendanceIngestToken };
    }

    // Generate initial token
    const token = crypto.randomBytes(48).toString('base64url');
    workspace.attendanceIngestToken = token;
    workspace.attendanceIngestTokenRotatedAt = new Date();
    await workspace.save();

    this.logger.log(`[AttendanceDevices] Initial ingest token generated for ws=${wsId}`);

    return { token };
  }

  // -------------------------------------------------------------------------
  // Unassigned punch query
  // -------------------------------------------------------------------------

  /**
   * Return distinct unmapped (serial, deviceUserId) pairs with event counts.
   * Query is workspace-scoped (T-B-03-04).
   */
  async getUnassignedPunches(wsId: string): Promise<
    Array<{
      deviceSerial: string;
      deviceUserId: string;
      eventCount: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }>
  > {
    const result = await this.eventModel
      .aggregate([
        {
          $match: {
            wsId: new Types.ObjectId(wsId),
            teamMemberId: null,
            deviceSerial: { $ne: null },
          },
        },
        {
          $group: {
            _id: {
              deviceSerial: '$deviceSerial',
              deviceUserId: '$deviceUserId',
            },
            eventCount: { $sum: 1 },
            firstSeenAt: { $min: '$timestamp' },
            lastSeenAt: { $max: '$timestamp' },
          },
        },
        {
          $project: {
            _id: 0,
            deviceSerial: '$_id.deviceSerial',
            deviceUserId: '$_id.deviceUserId',
            eventCount: 1,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        },
        { $sort: { lastSeenAt: -1 } },
      ])
      .exec();

    return result as Array<{
      deviceSerial: string;
      deviceUserId: string;
      eventCount: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }>;
  }

  // -------------------------------------------------------------------------
  // Device user assignment + all-time backfill (D-05)
  // -------------------------------------------------------------------------

  /**
   * Assign (deviceSerial, deviceUserId) → teamMemberId.
   * - Adds biometricBinding to TeamMember via $addToSet (idempotent).
   * - Runs updateMany on AttendanceEvent (all-time backfill, workspace-scoped — T-B-03-02).
   * - Fires projection recomputes asynchronously via setImmediate (T-B-03-05).
   */
  async assignDeviceUser(wsId: string, dto: AssignDeviceUserDto): Promise<{ updated: number }> {
    const wsObjectId = new Types.ObjectId(wsId);
    const memberObjectId = new Types.ObjectId(dto.teamMemberId);

    // 1. Add biometricBinding to TeamMember (idempotent via $addToSet).
    // Check matchedCount to detect cross-workspace assignment attempts (WR-01).
    const bindResult = await this.teamMemberModel.updateOne(
      { _id: memberObjectId, workspaceId: wsObjectId },
      {
        $addToSet: {
          biometricBindings: {
            deviceSerial: dto.deviceSerial,
            deviceUserId: dto.deviceUserId,
            addedAt: new Date(),
          },
        },
      },
    );
    if (bindResult.matchedCount === 0) {
      throw new NotFoundException(`Team member ${dto.teamMemberId} not found in workspace ${wsId}`);
    }

    // 2. Backfill all-time unassigned events for this (wsId, serial, deviceUserId)
    const updateResult = await this.eventModel.updateMany(
      {
        wsId: wsObjectId,
        deviceSerial: dto.deviceSerial,
        deviceUserId: dto.deviceUserId,
        teamMemberId: null,
      },
      { $set: { teamMemberId: memberObjectId } },
    );

    const updatedCount = updateResult.modifiedCount ?? 0;

    // 3. Fire projection recomputes asynchronously (setImmediate — Pitfall 5 / T-B-03-05)
    if (updatedCount > 0) {
      setImmediate(() => {
        void this._recomputeBackfillProjections(wsId, dto.teamMemberId);
      });
    }

    this.logger.log(
      `[AttendanceDevices] Assigned device SN=${dto.deviceSerial} user=${dto.deviceUserId} ` +
        `→ member=${dto.teamMemberId} ws=${wsId}, updated=${updatedCount} events`,
    );

    return { updated: updatedCount };
  }

  /** Async recompute for all distinct dates with events for the newly assigned member. */
  private async _recomputeBackfillProjections(wsId: string, teamMemberId: string): Promise<void> {
    const wsObjectId = new Types.ObjectId(wsId);
    const memberObjectId = new Types.ObjectId(teamMemberId);

    // Find distinct dates for this member (now that events are attributed)
    const pairs = await this.eventModel
      .aggregate<{ _id: Date }>([
        {
          $match: {
            wsId: wsObjectId,
            teamMemberId: memberObjectId,
          },
        },
        {
          $group: {
            _id: {
              $dateTrunc: { date: '$timestamp', unit: 'day', timezone: 'UTC' },
            },
          },
        },
      ])
      .exec();

    for (const pair of pairs) {
      try {
        await this.projectionService.recompute(wsId, teamMemberId, pair._id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
        this.logger.warn(
          `[AttendanceDevices] Recompute failed member=${teamMemberId} date=${pair._id.toISOString()}: ${msg}`,
        );
      }
    }
  }
}
