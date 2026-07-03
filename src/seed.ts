import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Plan } from './modules/subscriptions/schemas/plan.schema';
import { AppSettings } from './modules/subscriptions/schemas/app-settings.schema';
import { Language } from './modules/localization/schemas/language.schema';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
// NOTE: PlanTier / AppModule / buildModuleAccess imports were removed when the
// legacy ERP plan-seeding block was neutralized (Phase-1 pricing rework,
// 2026-06-23). The canonical ERP plans are now seeded by the migration
// `seed-default-tiers-and-plans.ts` (run via `npm run migrate`).

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const planModel = app.get<Model<Plan>>(getModelToken(Plan.name));
  const appSettingsModel = app.get<Model<AppSettings>>(getModelToken(AppSettings.name));
  const languageModel = app.get<Model<Language>>(getModelToken(Language.name));

  console.log('Seeding database...\n');

  // ── Legacy ERP plan seeding NEUTRALIZED (Phase-1 pricing rework, 2026-06-23) ──
  // This block used to hand-seed 4 obsolete ERP plans (Free Forever / Starter
  // @499 / Pro Starter / Enterprise Unlimited) whenever the plans collection was
  // empty. The canonical ERP plan set is now seeded EXCLUSIVELY by
  // `src/migrations/seed-default-tiers-and-plans.ts` (run via `npm run migrate`):
  // Free / Starter / Growth / Business + a non-public Custom (Enterprise retired).
  // Seeding the legacy set here would re-introduce drift the
  // `retire-legacy-erp-plans` migration then has to clean up, so this path is a
  // deliberate no-op. Do NOT re-add a legacy ERP plan array here — the migration
  // seed is the single source of truth for ERP plans.
  //
  // (planModel is still imported/resolved above so this file keeps compiling and
  //  any future non-plan use of it stays available; the count log below is kept
  //  purely informational.)
  const existingPlans = await planModel.countDocuments();
  console.log(
    `ERP plan seeding skipped — canonical plans come from "npm run migrate" ` +
      `(seed-default-tiers-and-plans). Existing plan docs: ${existingPlans}.\n`,
  );

  // Seed AppSettings (singleton) — only create if not already present
  const existingSettings = await appSettingsModel.findOne().exec();
  if (!existingSettings) {
    await appSettingsModel.create({ freeTierEnabled: true });
    console.log('AppSettings created (freeTierEnabled: true).\n');
  } else {
    console.log('AppSettings already exist. Skipping.\n');
  }

  const languages = [
    {
      code: 'en',
      name: 'English',
      nativeName: 'English',
      example: 'Hello, Welcome!',
      isDefault: true,
      isActive: true,
      bundleVersion: 1,
    },
    {
      code: 'es',
      name: 'Spanish',
      nativeName: 'Español',
      example: '¡Hola, Bienvenido!',
      isDefault: false,
      isActive: true,
      bundleVersion: 1,
    },
    {
      code: 'gu-en',
      name: 'Gujarati-English',
      nativeName: 'Gujarati-English',
      example: 'Namaste',
      isDefault: false,
      isActive: true,
      bundleVersion: 1,
    },
  ];

  for (const langData of languages) {
    const existing = await languageModel.findOne({ code: langData.code }).exec();

    if (existing) {
      await languageModel.updateOne(
        { code: langData.code },
        {
          $set: {
            name: langData.name,
            nativeName: langData.nativeName,
            example: langData.example,
            isActive: langData.isActive,
          },
        },
      );
      console.log(`✓ Updated: ${langData.code} - ${langData.name}`);
    } else {
      await languageModel.create(langData);
      console.log(`✓ Added: ${langData.code} - ${langData.name}`);
    }
  }

  console.log('\n→ Run "npm run seed:translations" to seed translation strings');

  const allLangs = await languageModel.find().select('code name example isDefault isActive').exec();
  console.log('\n--- Current Languages ---');
  allLangs.forEach((l) => {
    const status = l.isDefault ? '(default)' : l.isActive ? '' : '(inactive)';
    console.log(`  ${l.code.padEnd(6)} | ${l.name.padEnd(18)} | "${l.example || '-'}" ${status}`);
  });

  console.log('\nSeeding complete.');
  await app.close();
}

bootstrap().catch((err) => {
  console.error('Seeding failed', err);
  process.exit(1);
});
