import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { ShopFloorConfig } from './schemas/shop-floor-config.schema';
import { UpsertShopFloorConfigDto } from './dto/upsert-shop-floor-config.dto';

interface ShopFloorConfigContext {
  workspaceId: string;
  userId: string;
}

/** Hard cap on floors per location — mirrors the web Setup wizard limit. */
const MAX_FLOORS = 12;

/**
 * ShopFloorConfigService — per (workspace, location) floor layout + people
 * links for the web Shop Floor Setup wizard (app/dashboard/machines/shop-floor).
 *
 * Responsibilities:
 *   - PUT is a FULL-REPLACE upsert keyed on (workspaceId, locationId) — the
 *     unique compound index makes concurrent first-writes safe.
 *   - Floor rules: trimmed, non-empty, case-insensitively unique, ≤12
 *     (400 SHOP_FLOOR_INVALID); people[].floor must match a floors[].name.
 *   - Cross-workspace guards: location (404 LOCATION_NOT_FOUND) and every
 *     teamMemberId (404 TEAM_MEMBER_NOT_FOUND, mirrors WorkOrdersService).
 *   - Machine→floor assignment is NOT handled here — Machine.floorTag is
 *     PATCHed directly by the wizard via the machines module.
 *   - Mongoose 8.23 autocast workaround at every filter site
 *     (memory: project_attendance_module_session_2026-04-22.md).
 */
@Injectable()
export class ShopFloorConfigService {
  private readonly logger = new Logger(ShopFloorConfigService.name);

  constructor(
    @InjectModel(ShopFloorConfig.name)
    private readonly configModel: Model<ShopFloorConfig>,
    // String tokens — avoid SWC decorator-metadata trip on Mongoose autocast
    // resolver; resolve identically at build time (STATE.md F-16-02).
    @InjectModel('Location')
    private readonly locationModel: Model<any>,
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
  ) {}

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * List every shop-floor config in the workspace (one doc per configured
   * location). Lean reads with raw `_id`s, mirrors WorkOrdersService.list.
   */
  async list(ctx: ShopFloorConfigContext): Promise<ShopFloorConfig[]> {
    return this.configModel
      .find({ workspaceId: new Types.ObjectId(ctx.workspaceId) })
      .lean()
      .exec() as unknown as Promise<ShopFloorConfig[]>;
  }

  /**
   * Upsert the config for (workspaceId, dto.locationId) — full replace of
   * floors + people. Floors keep their submitted order; people are deduped
   * by teamMemberId (LAST occurrence wins). Returns the full upserted doc.
   */
  async upsert(
    ctx: ShopFloorConfigContext,
    dto: UpsertShopFloorConfigDto,
  ): Promise<ShopFloorConfig> {
    await this.assertLocationInWorkspace(ctx.workspaceId, dto.locationId);

    const floors = this.validateFloors(dto.floors);
    const floorNames = new Set(floors.map((f) => f.name));

    // Dedupe by teamMemberId — last occurrence wins (Map.set overwrites).
    const byMember = new Map<string, { teamMemberId: string; floor: string }>();
    for (const p of dto.people) {
      const floor = p.floor.trim();
      if (!floorNames.has(floor)) {
        throw new BadRequestException({
          code: 'SHOP_FLOOR_INVALID',
          message: `Unknown floor '${floor}' — must match one of this location's floors.`,
        });
      }
      byMember.set(p.teamMemberId, { teamMemberId: p.teamMemberId, floor });
    }
    const people = [...byMember.values()];

    await this.assertMembersInWorkspace(
      ctx.workspaceId,
      people.map((p) => p.teamMemberId),
    );

    const config = await this.configModel
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(ctx.workspaceId),
          locationId: new Types.ObjectId(dto.locationId),
        },
        {
          $set: {
            floors,
            people: people.map((p) => ({
              teamMemberId: new Types.ObjectId(p.teamMemberId),
              floor: p.floor,
            })),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();

    this.logger.log(
      `ShopFloorConfigService: upserted config for location ${dto.locationId} in workspace ${ctx.workspaceId}`,
    );
    return config as unknown as ShopFloorConfig;
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Floor names: trimmed, non-empty, ≤12 total, unique case-insensitively —
   * 400 SHOP_FLOOR_INVALID otherwise. Submitted order is preserved.
   */
  private validateFloors(floors: { name: string }[]): { name: string }[] {
    if (floors.length > MAX_FLOORS) {
      throw new BadRequestException({
        code: 'SHOP_FLOOR_INVALID',
        message: `A location can have at most ${MAX_FLOORS} floors.`,
      });
    }
    const seen = new Set<string>();
    const trimmed: { name: string }[] = [];
    for (const f of floors) {
      const name = f.name.trim();
      if (name.length === 0) {
        throw new BadRequestException({
          code: 'SHOP_FLOOR_INVALID',
          message: 'Floor names cannot be empty.',
        });
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException({
          code: 'SHOP_FLOOR_INVALID',
          message: `Duplicate floor name '${name}' (names are case-insensitive).`,
        });
      }
      seen.add(key);
      trimmed.push({ name });
    }
    return trimmed;
  }

  /**
   * locationId must be a non-deleted Location of this workspace —
   * 404 LOCATION_NOT_FOUND otherwise (invalid ObjectIds 404 too, no
   * CastError 500s; mirrors the locations module's not-found semantics).
   */
  private async assertLocationInWorkspace(workspaceId: string, locationId: string): Promise<void> {
    const location = Types.ObjectId.isValid(locationId)
      ? await this.locationModel
          .findOne({
            _id: new Types.ObjectId(locationId),
            workspaceId: new Types.ObjectId(workspaceId),
            isDeleted: false,
          })
          .select('_id')
          .lean()
          .exec()
      : null;
    if (!location) {
      throw new NotFoundException({
        code: 'LOCATION_NOT_FOUND',
        message: 'Location not found or not in this workspace.',
      });
    }
  }

  /**
   * Every teamMemberId must be a non-deleted member of this workspace —
   * 404 TEAM_MEMBER_NOT_FOUND otherwise (mirrors WorkOrdersService's
   * assertMemberInWorkspace, batched like assertMachinesInWorkspace).
   */
  private async assertMembersInWorkspace(
    workspaceId: string,
    teamMemberIds: string[],
  ): Promise<void> {
    if (teamMemberIds.length === 0) return;
    const unique = [...new Set(teamMemberIds)];
    const count = await this.teamMemberModel
      .countDocuments({
        _id: { $in: unique.map((id) => new Types.ObjectId(id)) },
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (count !== unique.length) {
      throw new NotFoundException({
        code: 'TEAM_MEMBER_NOT_FOUND',
        message: 'Team member not found or not in this workspace.',
      });
    }
  }
}
