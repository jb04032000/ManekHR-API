import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ConnectTag,
  type ConnectTagCategory,
} from '../modules/connect/tags/schemas/connect-tag.schema';
import {
  TEXTILE_SYNONYM_GROUPS,
  type SynonymGroup,
  type TextileTermCategory,
} from '../modules/connect/search/dictionaries/textile-terms';

/** A curated tag definition built from the textile synonym dictionary. */
export interface CuratedTagSeed {
  slug: string;
  labels: { en: string; guEn: string; hiEn: string };
  aliases: string[];
  category: ConnectTagCategory;
  isCurated: true;
}

/** Map the search dictionary's group category onto the tag taxonomy's. */
const CATEGORY_MAP: Record<TextileTermCategory, ConnectTagCategory> = {
  material: 'material',
  product: 'product',
  technique: 'technique',
  process: 'technique',
};

/** Lowercase, trim, collapse whitespace to a hyphen. */
function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Title-case a trade term for a readable English / romanized label. */
function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Build the curated tag taxonomy from the shared textile synonym groups (S1.1),
 * so the tag vocabulary and the search synonyms stay one source of truth. The
 * group's canonical term becomes the slug; the rest become aliases.
 */
export function buildCuratedTagSeed(
  groups: readonly SynonymGroup[] = TEXTILE_SYNONYM_GROUPS,
): CuratedTagSeed[] {
  return groups.map((group) => {
    const slug = slugify(group.canonical);
    const canonicalLower = group.canonical.toLowerCase();
    const label = titleCase(group.canonical);
    const aliases = [
      ...new Set(
        group.terms
          .map((term) => term.toLowerCase())
          .filter((term) => term !== slug && term !== canonicalLower),
      ),
    ];
    return {
      slug,
      labels: { en: label, guEn: label, hiEn: label },
      aliases,
      category: CATEGORY_MAP[group.category],
      isCurated: true,
    };
  });
}

/**
 * Seed the curated Connect tag taxonomy — S1.3.
 *
 * Idempotent + re-runnable. Looks up by `slug` and SKIPS when a row exists, so
 * admin edits + accrued `usageCount` on a seeded tag are preserved. Mirrors
 * `SeedConnectTiersAndPlansService`.
 */
@Injectable()
export class SeedConnectTagsService {
  private readonly logger = new Logger(SeedConnectTagsService.name);

  constructor(@InjectModel(ConnectTag.name) private readonly tagModel: Model<ConnectTag>) {}

  async runSeed(): Promise<{ inserted: number; skipped: number }> {
    const defs = buildCuratedTagSeed();
    let inserted = 0;
    let skipped = 0;
    for (const def of defs) {
      const existing = await this.tagModel
        .findOne({ slug: def.slug })
        .select('_id')
        .lean<{ _id: unknown } | null>()
        .exec();
      if (existing) {
        skipped += 1;
        continue;
      }
      await this.tagModel.create(def);
      inserted += 1;
    }
    this.logger.log(`Connect tags seed: ${inserted} inserted, ${skipped} skipped.`);
    return { inserted, skipped };
  }
}
