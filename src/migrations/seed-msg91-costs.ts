import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { env } from '../config/env';
import { Msg91CostTable } from '../modules/sms/schemas/msg91-cost-table.schema';

/**
 * Wave 8 — seed wholesale MSG91 SMS costs (paise per segment).
 *
 * Idempotent: skips rows that match `(provider, country, encoding, segments,
 * costPaise, effectiveFrom)` exactly. Repricing flow is to write a NEW row
 * with the new `effectiveFrom` (and optionally close the old one with
 * `effectiveTo`) — never mutate historical rows in place; reconciliation
 * needs a stable cost-history.
 *
 * Defaults reflect MSG91 transactional DLT pricing as of 2025 (negotiated
 * volume tier ~₹0.15-0.18 per GSM-7 segment domestic; UCS-2 priced same per
 * segment). Adjust via env overrides:
 *   MSG91_COST_GSM7_SEG_PAISE   (default 1500 = ₹0.15/segment)
 *   MSG91_COST_UCS2_SEG_PAISE   (default 1500)
 */
@Injectable()
export class SeedMsg91CostsService {
  private readonly logger = new Logger(SeedMsg91CostsService.name);

  constructor(
    @InjectModel(Msg91CostTable.name)
    private readonly costModel: Model<Msg91CostTable>,
  ) {}

  async runSeed(): Promise<{ inserted: number; skipped: number }> {
    const gsm7Paise = env.msg91.costGsm7SegPaise;
    const ucs2Paise = env.msg91.costUcs2SegPaise;
    const waConvPaise = env.aisensy.costPerConversationPaise;

    const rows: Array<{
      provider: 'msg91' | 'aisensy';
      channel: 'sms' | 'whatsapp';
      encoding: 'GSM7' | 'UCS2' | 'N/A';
      segments: number;
      costPaise: number;
    }> = [
      // SMS — GSM-7 segments 1..3 (long-SMS billed per-segment)
      { provider: 'msg91', channel: 'sms', encoding: 'GSM7', segments: 1, costPaise: gsm7Paise },
      {
        provider: 'msg91',
        channel: 'sms',
        encoding: 'GSM7',
        segments: 2,
        costPaise: gsm7Paise * 2,
      },
      {
        provider: 'msg91',
        channel: 'sms',
        encoding: 'GSM7',
        segments: 3,
        costPaise: gsm7Paise * 3,
      },
      // SMS — UCS-2 (Hindi / emoji / any non-GSM char)
      { provider: 'msg91', channel: 'sms', encoding: 'UCS2', segments: 1, costPaise: ucs2Paise },
      {
        provider: 'msg91',
        channel: 'sms',
        encoding: 'UCS2',
        segments: 2,
        costPaise: ucs2Paise * 2,
      },
      {
        provider: 'msg91',
        channel: 'sms',
        encoding: 'UCS2',
        segments: 3,
        costPaise: ucs2Paise * 3,
      },
      // WhatsApp — per-conversation (24h window). Provider = aisensy.
      {
        provider: 'aisensy',
        channel: 'whatsapp',
        encoding: 'N/A',
        segments: 1,
        costPaise: waConvPaise,
      },
    ];

    let inserted = 0;
    let skipped = 0;
    const baseEffectiveFrom = new Date('2024-01-01T00:00:00Z');

    for (const row of rows) {
      const existing = await this.costModel
        .findOne({
          provider: row.provider,
          channel: row.channel,
          country: 'IN',
          encoding: row.encoding,
          segments: row.segments,
          effectiveTo: null,
        })
        .lean();

      if (existing && existing.costPaise === row.costPaise) {
        skipped++;
        continue;
      }

      // Close any prior open row with matching key before inserting a new one.
      if (existing && existing.costPaise !== row.costPaise) {
        await this.costModel.updateOne(
          { _id: existing._id },
          { $set: { effectiveTo: new Date() } },
        );
      }

      await this.costModel.create({
        provider: row.provider,
        channel: row.channel,
        country: 'IN',
        encoding: row.encoding,
        segments: row.segments,
        costPaise: row.costPaise,
        effectiveFrom: existing ? new Date() : baseEffectiveFrom,
        effectiveTo: null,
        note: existing ? 'Repriced (Wave 8.2 seeder)' : 'Initial seed (Wave 8.2)',
      });
      inserted++;
    }

    this.logger.log(`MSG91 cost-table seed: ${inserted} inserted, ${skipped} skipped.`);
    return { inserted, skipped };
  }
}
