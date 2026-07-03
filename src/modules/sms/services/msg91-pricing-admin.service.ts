import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Msg91CostTable } from '../schemas/msg91-cost-table.schema';

/**
 * Wave 8.2 — admin CRUD over the versioned MSG91/AiSensy cost table.
 *
 * Add-row semantics: when a new row is inserted, any existing OPEN row
 * matching the same `(provider, channel, country, encoding, segments)`
 * tuple is closed via `effectiveTo = now`. The new row's `effectiveFrom`
 * defaults to now. Reconciliation history stays intact.
 *
 * No update-in-place. Always insert + auto-close.
 */
@Injectable()
export class Msg91PricingAdminService {
  private readonly logger = new Logger(Msg91PricingAdminService.name);

  constructor(
    @InjectModel(Msg91CostTable.name)
    private readonly costModel: Model<Msg91CostTable>,
  ) {}

  /**
   * List all rows. By default returns the active (effectiveTo=null) snapshot
   * grouped by key. `includeHistory=true` returns every row newest-first.
   */
  async list(args: {
    includeHistory?: boolean;
  }): Promise<Msg91CostTable[]> {
    const filter: Record<string, unknown> = args.includeHistory
      ? {}
      : { effectiveTo: null };
    return this.costModel.find(filter).sort({ effectiveFrom: -1 }).lean();
  }

  /**
   * Insert a new active row. Auto-closes any prior open row with the same
   * key. Caller is admin-guarded.
   */
  async addRow(args: {
    provider: 'msg91' | 'aisensy';
    channel: 'sms' | 'whatsapp';
    encoding: 'GSM7' | 'UCS2' | 'N/A';
    segments: number;
    costPaise: number;
    country?: string;
    note?: string;
    effectiveFrom?: Date;
  }): Promise<Msg91CostTable> {
    if (!Number.isInteger(args.costPaise) || args.costPaise < 0) {
      throw new BadRequestException('costPaise must be a non-negative integer');
    }
    if (!Number.isInteger(args.segments) || args.segments < 1) {
      throw new BadRequestException('segments must be a positive integer');
    }
    if (args.channel === 'whatsapp' && args.encoding !== 'N/A') {
      throw new BadRequestException(
        'WhatsApp rows must use encoding=N/A (per-conversation pricing)',
      );
    }
    if (
      args.channel === 'sms' &&
      !['GSM7', 'UCS2'].includes(args.encoding)
    ) {
      throw new BadRequestException(
        'SMS rows must use encoding=GSM7 or UCS2',
      );
    }

    const country = args.country ?? 'IN';
    const cutoff = args.effectiveFrom ?? new Date();

    // Close any existing open row.
    await this.costModel.updateMany(
      {
        provider: args.provider,
        channel: args.channel,
        country,
        encoding: args.encoding,
        segments: args.segments,
        effectiveTo: null,
      },
      { $set: { effectiveTo: cutoff } },
    );

    const created = await this.costModel.create({
      provider: args.provider,
      channel: args.channel,
      country,
      encoding: args.encoding,
      segments: args.segments,
      costPaise: args.costPaise,
      effectiveFrom: cutoff,
      effectiveTo: null,
      note: args.note,
    });
    this.logger.log(
      `cost-table add: provider=${args.provider} channel=${args.channel} ${args.encoding}/${args.segments} = ₹${(args.costPaise / 100).toFixed(2)}`,
    );
    return created;
  }

  /**
   * Close an open row (e.g. discontinuing an encoding/segment combo). The
   * row is NOT deleted — `effectiveTo` is stamped so history survives.
   */
  async closeRow(id: string, when?: Date): Promise<Msg91CostTable> {
    const closeAt = when ?? new Date();
    const row = await this.costModel
      .findByIdAndUpdate(
        id,
        { $set: { effectiveTo: closeAt } },
        { new: true },
      )
      .lean();
    if (!row) throw new NotFoundException('cost-table row not found');
    return row;
  }
}
