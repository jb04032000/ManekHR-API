/**
 * Migration: Drop legacy `hi` (Devanagari) + `es` (Spanish leftover) locales
 * from the DB-backed Localization module.
 *
 * Polish Initiative Phase 1A. Idempotent — safe to run multiple times.
 * Print pipeline (file-based en/gu/hi) is intentionally untouched per
 * Polish Rule #2 / docs/architecture/i18n-locales.md.
 *
 * Usage:
 *   pnpm ts-node -r tsconfig-paths/register scripts/migrations/drop-legacy-locales.ts
 *
 * Optional flags:
 *   --dry-run   Report counts only; no deletions.
 */
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../../src/app.module';
import { Language } from '../../src/modules/localization/schemas/language.schema';
import { Translation } from '../../src/modules/localization/schemas/translation.schema';

const LEGACY_CODES = ['hi', 'es'] as const;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const languageModel = app.get<Model<Language>>(getModelToken(Language.name));
  const translationModel = app.get<Model<Translation>>(getModelToken(Translation.name));

  console.log(`=== drop-legacy-locales (${dryRun ? 'DRY RUN' : 'LIVE'}) ===\n`);
  console.log(`Targets: ${LEGACY_CODES.join(', ')}\n`);

  const summary: Array<{
    code: string;
    languageDocs: number;
    translationDocs: number;
  }> = [];

  for (const code of LEGACY_CODES) {
    const langCount = await languageModel.countDocuments({ code }).exec();
    const trCount = await translationModel.countDocuments({ languageCode: code }).exec();

    summary.push({
      code,
      languageDocs: langCount,
      translationDocs: trCount,
    });

    if (langCount === 0 && trCount === 0) {
      console.log(`  ${code}: nothing to drop`);
      continue;
    }

    console.log(`  ${code}: ${langCount} Language doc(s), ${trCount} Translation row(s)`);

    if (!dryRun) {
      const guard = await languageModel.findOne({ code, isDefault: true });
      if (guard) {
        console.warn(`  ⚠ ${code} is marked default — skipping (will not delete default language)`);
        continue;
      }
      await translationModel.deleteMany({ languageCode: code }).exec();
      await languageModel.deleteOne({ code }).exec();
      console.log(`    ✓ deleted`);
    }
  }

  console.log('\n=== Summary ===');
  for (const s of summary) {
    console.log(`  ${s.code}: lang=${s.languageDocs} translations=${s.translationDocs}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] No changes applied. Re-run without --dry-run.');
  } else {
    console.log('\n✓ Migration complete.');
  }

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
