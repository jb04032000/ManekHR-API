import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  REASON_CATEGORIES,
  ReasonCategory,
  ReasonCode,
  SYSTEM_REASON_CODES,
  WorkspaceDowntimeReasonConfig,
} from './schemas/downtime-reason-config.schema';
import { ReasonCatalogueUpdateDto } from './dto/reason-catalogue-update.dto';

/**
 * DowntimeReasonsService — workspace reason catalogue (D-02).
 *
 * Responsibilities:
 *   - Lazy-seed the 7 system reason codes on first read per workspace.
 *   - Resolve a reasonCodeId → snapshot fields for entry creation.
 *   - Owner-only catalogue replace with system-code immutability guards.
 *
 * All ObjectId comparisons in query filters wrap with `new Types.ObjectId()`
 * to dodge the Mongoose 8.23 autocast bug (D-15;
 * memory: project_attendance_module_session_2026-04-22.md).
 */
@Injectable()
export class DowntimeReasonsService {
  constructor(
    @InjectModel(WorkspaceDowntimeReasonConfig.name)
    private readonly configModel: Model<WorkspaceDowntimeReasonConfig>,
  ) {}

  /**
   * Returns the workspace's catalogue, lazy-creating it with the 7 system
   * codes on first read. Idempotent — safe to call from both GET and POST flows.
   */
  async get(workspaceId: string): Promise<WorkspaceDowntimeReasonConfig> {
    const wsId = new Types.ObjectId(workspaceId);
    let config = await this.configModel.findOne({ workspaceId: wsId }).exec();
    if (!config) {
      config = await this.configModel.create({
        workspaceId: wsId,
        codes: SYSTEM_REASON_CODES,
      });
    }
    return config;
  }

  /**
   * Resolve a reasonCodeId to its snapshot fields for DowntimeEntry creation.
   * Throws:
   *   404 DOWNTIME_REASON_NOT_FOUND when the id is not in the catalogue.
   *   400 DOWNTIME_REASON_DISABLED when the code exists but is disabled.
   */
  async resolveForEntry(
    workspaceId: string,
    reasonCodeId: string,
  ): Promise<{ key: string; label: string; category: ReasonCategory }> {
    const config = await this.get(workspaceId);
    const code = config.codes.find(
      (c) => c._id?.toString() === reasonCodeId,
    );
    if (!code) {
      throw new NotFoundException({
        code: 'DOWNTIME_REASON_NOT_FOUND',
        message: 'Reason code not found in workspace catalogue.',
      });
    }
    if (code.isDisabled) {
      throw new BadRequestException({
        code: 'DOWNTIME_REASON_DISABLED',
        message:
          'This reason code is disabled and cannot be used for new entries.',
      });
    }
    return { key: code.key, label: code.label, category: code.category };
  }

  /**
   * Owner-only catalogue replace (D-02). Single PATCH with full codes[] payload.
   *
   * Validation rules (RESEARCH §4.1):
   *   System codes: only label / isDisabled / sortOrder editable;
   *                 key + category locked; cannot be removed.
   *   Custom codes: full edit allowed except key (immutable after create).
   *   New codes:    key auto-generated from label (kebab); category required.
   *
   * Defence-in-depth: after building `next`, verifies all 7 system codes are
   * still present (rejects if any system key is missing from payload).
   */
  async replace(
    workspaceId: string,
    payload: ReasonCatalogueUpdateDto,
  ): Promise<WorkspaceDowntimeReasonConfig> {
    const config = await this.get(workspaceId);
    const existing = new Map(
      config.codes.map((c) => [c._id!.toString(), c]),
    );
    const seenKeys = new Set<string>();

    const next: ReasonCode[] = [];
    for (const incoming of payload.codes) {
      if (incoming._id) {
        const prior = existing.get(incoming._id);
        if (!prior) {
          throw new NotFoundException({
            code: 'DOWNTIME_REASON_NOT_FOUND',
            message: `Reason code '${incoming._id}' not found in catalogue.`,
          });
        }

        if (prior.isSystem) {
          if (incoming.key && incoming.key !== prior.key) {
            throw new BadRequestException({
              code: 'DOWNTIME_REASON_KEY_IMMUTABLE',
              message: 'System reason key cannot be changed.',
            });
          }
          if (incoming.category && incoming.category !== prior.category) {
            throw new BadRequestException({
              code: 'DOWNTIME_REASON_CATEGORY_LOCKED',
              message: 'System reason category cannot be changed.',
            });
          }
          next.push({
            ...(prior as any),
            label: incoming.label?.trim() || prior.label,
            isDisabled: incoming.isDisabled ?? prior.isDisabled,
            sortOrder: incoming.sortOrder ?? prior.sortOrder,
          } as ReasonCode);
        } else {
          if (incoming.key && incoming.key !== prior.key) {
            throw new BadRequestException({
              code: 'DOWNTIME_REASON_KEY_IMMUTABLE',
              message: 'Custom reason key cannot be changed after creation.',
            });
          }
          next.push({
            ...(prior as any),
            label: incoming.label?.trim() || prior.label,
            category: incoming.category ?? prior.category,
            isDisabled: incoming.isDisabled ?? prior.isDisabled,
            sortOrder: incoming.sortOrder ?? prior.sortOrder,
          } as ReasonCode);
        }
        seenKeys.add(prior.key);
      } else {
        // New custom code path.
        if (!incoming.label?.trim()) {
          throw new BadRequestException({
            code: 'DOWNTIME_REASON_LABEL_REQUIRED',
            message: 'Label is required when adding a new reason code.',
          });
        }
        if (
          !incoming.category ||
          !REASON_CATEGORIES.includes(incoming.category)
        ) {
          throw new BadRequestException({
            code: 'DOWNTIME_REASON_CATEGORY_REQUIRED',
            message:
              'Category is required when adding a new reason code (mechanical|operational).',
          });
        }
        const key = this.generateKey(incoming.label, seenKeys);
        seenKeys.add(key);
        next.push({
          key,
          label: incoming.label.trim(),
          category: incoming.category,
          isSystem: false,
          isDisabled: incoming.isDisabled ?? false,
          sortOrder: incoming.sortOrder ?? next.length * 10,
        } as ReasonCode);
      }
    }

    // Defence-in-depth: ensure all 7 system codes survived the replace.
    for (const sys of SYSTEM_REASON_CODES) {
      if (!next.some((c) => c.key === sys.key)) {
        throw new BadRequestException({
          code: 'DOWNTIME_REASON_SYSTEM_REQUIRED',
          message: `System reason code '${sys.key}' cannot be removed.`,
        });
      }
    }

    config.codes = next;
    return config.save();
  }

  /**
   * Generate a unique kebab-case key from a label, scoped to existing keys.
   * Falls back to 'reason' if the slug strips to empty; on collision tries
   * `${base}-2`, `${base}-3`, … up to 999, then throws.
   */
  private generateKey(label: string, existingKeys: Set<string>): string {
    const base =
      label
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50) || 'reason';
    if (!existingKeys.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!existingKeys.has(candidate)) return candidate;
    }
    throw new BadRequestException({
      code: 'DOWNTIME_REASON_KEY_GEN_FAILED',
      message: 'Unable to generate a unique key for the new reason code.',
    });
  }
}
