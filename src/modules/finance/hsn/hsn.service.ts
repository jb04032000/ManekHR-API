import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HsnCode } from './hsn-code.schema';
import { HSN_SEEDS, matchHsn } from './hsn-seeds';
import { GstRateHistoryService } from '../gst/gst-rate-history/gst-rate-history.service';

type HsnLite = {
  code: string;
  type: string;
  description: string;
  synonyms: string[];
  gstRate: number;
  chapter?: string;
};

// HSN/SAC finder (D18). Seeds the global directory once (idempotent) and serves search
// from a small in-memory cache (D17: no DB hit per keystroke). The D15 admin tax-rule work
// later extends the directory + adds effective-dated rates; this is the single source.
@Injectable()
export class HsnService implements OnModuleInit {
  private cache: HsnLite[] = [];

  constructor(
    @InjectModel(HsnCode.name) private readonly model: Model<HsnCode>,
    private readonly gstRateHistory: GstRateHistoryService,
  ) {}

  // Boot only WARMS the in-memory finder cache (a read-only runtime concern, not
  // a DB write). The DB seed (seedIfMissing) moved to the ledgered migration
  // runner (ADR-0001), unit `0036_finance_seed_hsn_codes`. Fresh-DB note: on a
  // brand-new DB the cache warms empty until `npm run migrate` seeds the codes
  // and the app is restarted; in prod the codes are already present so it warms full.
  async onModuleInit(): Promise<void> {
    try {
      await this.refreshCache();
    } catch {
      // Non-fatal: finder returns empty until the next successful boot.
    }
  }

  // Insert missing codes only - never overwrite admin edits (D15) or re-seed.
  // Public so the ledgered migration runner (unit 0036) can run it via
  // `npm run migrate` instead of an onModuleInit hook. Do NOT re-add a boot
  // seed call in onModuleInit above on merge.
  async seedIfMissing(): Promise<void> {
    const ops = HSN_SEEDS.map((s) => ({
      updateOne: {
        filter: { code: s.code },
        update: {
          $setOnInsert: {
            code: s.code,
            type: s.type,
            description: s.description,
            synonyms: s.synonyms,
            gstRate: s.gstRate,
            chapter: s.chapter,
          },
        },
        upsert: true,
      },
    }));
    if (ops.length) await this.model.bulkWrite(ops);
  }

  private async refreshCache(): Promise<void> {
    this.cache = await this.model
      .find({}, { code: 1, type: 1, description: 1, synonyms: 1, gstRate: 1, chapter: 1, _id: 0 })
      .lean<HsnLite[]>();
  }

  // P0/D18: resolve the LIVE effective-dated rate (gst-rate-history) for each match instead of the
  // static seeded gstRate, so admin rate revisions reach the finder and items never autofill an
  // outdated rate. Falls back to the stored rate when a prefix has no history row. The directory
  // itself stays in-memory (no per-keystroke DB hit for the text match); only the few matched
  // rows resolve a rate.
  async search(query: string, limit = 10): Promise<HsnLite[]> {
    const matches = matchHsn(this.cache, query, limit);
    const asOf = new Date();
    return Promise.all(
      matches.map(async (m) => {
        const live = await this.gstRateHistory.getRateAsOf(m.code, asOf);
        return live ? { ...m, gstRate: live.igstRate } : m;
      }),
    );
  }
}
