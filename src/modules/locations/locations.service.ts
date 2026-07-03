import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Location } from './schemas/location.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';

@Injectable()
export class LocationsService {
  constructor(
    @InjectModel(Location.name) private readonly locationModel: Model<Location>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly counterService: WorkspaceCounterService,
  ) {}

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }

  private toApi(loc: Location) {
    const obj = loc.toObject();
    return { ...obj, id: obj._id.toString() };
  }

  async findAll(workspaceId: string, includeDeleted = false) {
    const wsId = this.toObjectId(workspaceId);
    // Lazy bootstrap: ensure a default "Main" location exists for this
    // workspace so first-time users (single-site shops) don't see an
    // empty list and get blocked on machine creation.
    await this.ensureDefaultLocation(workspaceId);
    const filter: Record<string, unknown> = { workspaceId: wsId };
    if (!includeDeleted) filter.isDeleted = false;
    const rows = await this.locationModel
      .find(filter)
      .sort({ name: 1 })
      .exec();
    return rows.map((r) => this.toApi(r));
  }

  /**
   * Idempotent: if the workspace has zero non-deleted Locations, create
   * one named "Main" seeded from Workspace.location (legal address) and
   * Workspace.name. Safe to call from any read/write path. No-ops when
   * at least one location exists.
   */
  async ensureDefaultLocation(workspaceId: string): Promise<void> {
    const wsId = this.toObjectId(workspaceId);
    const count = await this.locationModel
      .countDocuments({ workspaceId: wsId, isDeleted: false })
      .exec();
    if (count > 0) return;

    const ws = await this.workspaceModel.findById(wsId).exec();
    if (!ws) return;

    try {
      await this.locationModel.create({
        workspaceId: wsId,
        name: 'Main',
        addressLine1: ws.location?.trim() || undefined,
        country: 'India',
        timezone: ws.timezone,
        isActive: true,
        notes: 'Default location auto-created on first machines setup.',
      });
    } catch (err: any) {
      // Race: another request created it first. Ignore dup-key error.
      if (err?.code !== 11000) throw err;
    }
  }

  async findById(workspaceId: string, locationId: string) {
    const loc = await this.locationModel
      .findOne({
        _id: this.toObjectId(locationId),
        workspaceId: this.toObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (!loc) throw new NotFoundException('Location not found');
    return this.toApi(loc);
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateLocationDto,
  ) {
    const wsId = this.toObjectId(workspaceId);

    // Uniqueness on name (case-insensitive) among non-deleted.
    const existing = await this.locationModel
      .findOne({
        workspaceId: wsId,
        isDeleted: false,
        name: { $regex: `^${this.escapeRegex(dto.name.trim())}$`, $options: 'i' },
      })
      .exec();
    if (existing) {
      throw new ConflictException(
        `A location named "${dto.name.trim()}" already exists in this workspace.`,
      );
    }

    const locationCode = dto.locationCode?.trim();
    if (locationCode) {
      const codeClash = await this.locationModel
        .findOne({
          workspaceId: wsId,
          isDeleted: false,
          locationCode,
        })
        .exec();
      if (codeClash) {
        throw new ConflictException(
          `Location code "${locationCode}" is already in use.`,
        );
      }
    }

    const created = await this.locationModel.create({
      workspaceId: wsId,
      name: dto.name.trim(),
      locationCode: locationCode || undefined,
      addressLine1: dto.addressLine1,
      addressLine2: dto.addressLine2,
      city: dto.city,
      state: dto.state,
      country: dto.country ?? 'India',
      pincode: dto.pincode,
      timezone: dto.timezone,
      notes: dto.notes,
      isActive: dto.isActive ?? true,
      createdBy: userId ? this.toObjectId(userId) : undefined,
    });

    return this.toApi(created);
  }

  async update(
    workspaceId: string,
    locationId: string,
    dto: UpdateLocationDto,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const id = this.toObjectId(locationId);

    const current = await this.locationModel
      .findOne({ _id: id, workspaceId: wsId, isDeleted: false })
      .exec();
    if (!current) throw new NotFoundException('Location not found');

    if (dto.name && dto.name.trim() !== current.name) {
      const clash = await this.locationModel
        .findOne({
          _id: { $ne: id },
          workspaceId: wsId,
          isDeleted: false,
          name: {
            $regex: `^${this.escapeRegex(dto.name.trim())}$`,
            $options: 'i',
          },
        })
        .exec();
      if (clash) {
        throw new ConflictException(
          `Another location already uses the name "${dto.name.trim()}".`,
        );
      }
    }

    const updated = await this.locationModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            ...(dto.name && { name: dto.name.trim() }),
            ...(dto.addressLine1 !== undefined && {
              addressLine1: dto.addressLine1,
            }),
            ...(dto.addressLine2 !== undefined && {
              addressLine2: dto.addressLine2,
            }),
            ...(dto.city !== undefined && { city: dto.city }),
            ...(dto.state !== undefined && { state: dto.state }),
            ...(dto.country !== undefined && { country: dto.country }),
            ...(dto.pincode !== undefined && { pincode: dto.pincode }),
            ...(dto.timezone !== undefined && { timezone: dto.timezone }),
            ...(dto.notes !== undefined && { notes: dto.notes }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
        },
        { new: true },
      )
      .exec();

    return this.toApi(updated!);
  }

  async remove(workspaceId: string, locationId: string) {
    const wsId = this.toObjectId(workspaceId);
    const id = this.toObjectId(locationId);
    const result = await this.locationModel
      .findOneAndUpdate(
        { _id: id, workspaceId: wsId, isDeleted: false },
        { $set: { isDeleted: true, deletedAt: new Date(), isActive: false } },
        { new: true },
      )
      .exec();
    if (!result) throw new NotFoundException('Location not found');
    return { success: true };
  }

  async peekNextCode(workspaceId: string): Promise<string> {
    const n = await this.counterService.peekNextLocationCode(workspaceId);
    return `LOC-${String(n).padStart(3, '0')}`;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
