/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unused-vars, @typescript-eslint/no-floating-promises, no-console */
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { Language } from './modules/localization/schemas/language.schema';
import { Translation } from './modules/localization/schemas/translation.schema';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

const MOBILE_APP_DIR = env.seed.mobileAppDir || path.resolve(__dirname, '../../zari360-app');
const WEB_APP_DIR = env.seed.webAppDir || path.resolve(__dirname, '../../zari360-web');

const PLURAL_SUFFIXES = ['_one', '_other', '_zero', '_two', '_few', '_many'];

const SEMANTIC_COMMON_KEYS = new Set([
  'loading',
  'error',
  'success',
  'cancel',
  'confirm',
  'save',
  'delete',
  'edit',
  'add',
  'search',
  'filter',
  'refresh',
  'retry',
  'back',
  'next',
  'previous',
  'done',
  'close',
  'yes',
  'no',
  'ok',
  'required',
  'optional',
  'view',
  'noData',
]);

interface ValidationError {
  type: 'missing' | 'plural-missing' | 'common-semantic' | 'unknown-scope';
  key: string;
  file: string;
  line: number;
  message: string;
}

interface ParsedKey {
  namespace: string;
  key: string;
  fullKey: string;
  file: string;
  line: number;
  platform: 'mobile' | 'web';
  isDynamic?: boolean;
  hasExplicitDeclaration?: boolean;
}

const MOBILE_BASE =
  env.seed.mobileTranslationsDir ||
  path.resolve(__dirname, '../../zari360-app/localization/static');
const WEB_BASE =
  env.seed.webTranslationsDir || path.resolve(__dirname, '../../zari360-web/app/messages');
const LANGUAGES = ['en', 'gu', 'gu-en', 'hi-en'];

interface FlatTranslation {
  namespace: string;
  key: string;
  value: string;
}

interface MergedTranslation extends FlatTranslation {
  platforms: ('mobile' | 'web')[];
}

function resolveFile(base: string, lang: string, app: string): string {
  return path.join(base, `${lang}.json`);
}

function validateFileExists(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

function flattenJson(obj: Record<string, unknown>, prefix = ''): FlatTranslation[] {
  const results: FlatTranslation[] = [];

  for (const [topKey, topValue] of Object.entries(obj)) {
    if (prefix === '') {
      if (typeof topValue === 'object' && topValue !== null && !Array.isArray(topValue)) {
        results.push(...flattenJson(topValue as Record<string, unknown>, topKey));
      } else {
        results.push({
          namespace: topKey,
          key: topKey,
          value: String(topValue ?? ''),
        });
      }
    }
  }

  return results;
}

function flattenJsonInner(
  obj: Record<string, unknown>,
  namespace: string,
  keyPrefix: string,
  results: FlatTranslation[],
): void {
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = keyPrefix ? `${keyPrefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      flattenJsonInner(v as Record<string, unknown>, namespace, fullKey, results);
    } else {
      results.push({
        namespace,
        key: fullKey,
        value: String(v ?? ''),
      });
    }
  }
}

function flattenTranslations(data: Record<string, unknown>): FlatTranslation[] {
  const results: FlatTranslation[] = [];
  for (const [topKey, topValue] of Object.entries(data)) {
    if (typeof topValue === 'object' && topValue !== null && !Array.isArray(topValue)) {
      flattenJsonInner(topValue as Record<string, unknown>, topKey, '', results);
    } else {
      results.push({
        namespace: topKey,
        key: topKey,
        value: String(topValue ?? ''),
      });
    }
  }
  return results;
}

function mergeTranslations(mobile: FlatTranslation[], web: FlatTranslation[]): MergedTranslation[] {
  const merged = new Map<string, MergedTranslation>();
  const conflicts: Array<{
    key: string;
    mobileValue: string;
    webValue: string;
  }> = [];

  for (const m of mobile) {
    const key = `${m.namespace}::${m.key}`;
    merged.set(key, { ...m, platforms: ['mobile'] });
  }

  for (const w of web) {
    const key = `${w.namespace}::${w.key}`;
    const existing = merged.get(key);
    if (existing) {
      if (existing.value !== w.value) {
        conflicts.push({
          key,
          mobileValue: existing.value,
          webValue: w.value,
        });
      }
      if (!existing.platforms.includes('web')) {
        existing.platforms.push('web');
      }
      existing.value = w.value;
    } else {
      merged.set(key, { ...w, platforms: ['web'] });
    }
  }

  return Array.from(merged.values());
}

function loadTranslationKeys(basePath: string): Set<string> {
  const enPath = path.join(basePath, 'en.json');
  if (!fs.existsSync(enPath)) {
    return new Set();
  }

  const json = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
  const keys = new Set<string>();

  function extractKeys(obj: Record<string, unknown>, prefix = ''): void {
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        extractKeys(v as Record<string, unknown>, fullKey);
      } else {
        keys.add(fullKey);
      }
    }
  }

  extractKeys(json);
  return keys;
}

function stripPluralSuffix(key: string): string {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) {
      return key.slice(0, -suffix.length);
    }
  }
  return key;
}

function extractDynamicKeysFromFile(content: string): string[] {
  const keys: string[] = [];
  const regex = /\/\/\s*i18n-keys:\s*([\w.,\s]+)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const keyList = match[1].split(',').map((k) => k.trim());
    keys.push(...keyList);
  }

  return keys;
}

function isFeaturePath(filePath: string): boolean {
  const featurePatterns = [
    /\/features\//,
    /\/screens\//,
    /\/pages\//,
    /\/dashboard\//,
    /\/components\/[^/]+\//,
  ];

  return featurePatterns.some((pattern) => pattern.test(filePath));
}

function extractMobileKeys(dirPath: string): ParsedKey[] {
  const keys: ParsedKey[] = [];
  const mobilePattern = /t\(['"`]([\w.]+)['"`]\)/g;

  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name !== 'node_modules' &&
          !entry.name.startsWith('.') &&
          !entry.name.startsWith('__')
        ) {
          scanDir(fullPath);
        }
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const dynamicKeys = extractDynamicKeysFromFile(content);

        let match;
        const searchContent = content;
        while ((match = mobilePattern.exec(searchContent)) !== null) {
          const fullKey = match[1];
          const lineNumber = searchContent.substring(0, match.index).split('\n').length;

          const isDynamic = dynamicKeys.length > 0 && dynamicKeys.includes(fullKey);

          keys.push({
            namespace: fullKey.split('.')[0],
            key: fullKey,
            fullKey,
            file: path.relative(MOBILE_APP_DIR, fullPath),
            line: lineNumber,
            platform: 'mobile',
            isDynamic,
            hasExplicitDeclaration: isDynamic,
          });
        }
      }
    }
  }

  const srcDir = path.join(dirPath, 'src');
  if (fs.existsSync(srcDir)) {
    scanDir(srcDir);
  } else {
    scanDir(dirPath);
  }

  return keys;
}

function extractWebKeys(dirPath: string): ParsedKey[] {
  const keys: ParsedKey[] = [];
  const namespaceDeclPattern = /useTranslations\(['"`]([\w]+)['"`]\)/g;
  const namespaceConstPattern = /export\s+const\s+TRANSLATION_NAMESPACE\s*=\s*['"`]([\w]+)['"`]/g;
  const keyPattern = /t\(['"`]([\w.]+)['"`]\)/g;

  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name !== 'node_modules' &&
          !entry.name.startsWith('.') &&
          !entry.name.startsWith('__') &&
          entry.name !== 'i18n' &&
          entry.name !== 'messages'
        ) {
          scanDir(fullPath);
        }
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        if (
          entry.name.includes('.test.') ||
          entry.name.includes('.spec.') ||
          entry.name === 'i18n.ts' ||
          entry.name === 'messages' ||
          entry.name.endsWith('.json')
        ) {
          continue;
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const dynamicKeys = extractDynamicKeysFromFile(content);

        const namespaceConstMatches = [...content.matchAll(namespaceConstPattern)];
        const exportedNamespace = namespaceConstMatches[0]?.[1];

        const namespaceDeclMatches: string[] = [];
        let nsMatch;
        const nsSearchContent = content;
        while ((nsMatch = namespaceDeclPattern.exec(nsSearchContent)) !== null) {
          namespaceDeclMatches.push(nsMatch[1]);
        }

        const hasUseTranslations = namespaceDeclMatches.length > 0;
        const currentNamespace = exportedNamespace || namespaceDeclMatches[0];
        const hasConst = !!exportedNamespace;

        const keyMatches: Array<{
          key: string;
          line: number;
          isDynamic: boolean;
        }> = [];
        let keyMatch;
        const keySearchContent = content;
        while ((keyMatch = keyPattern.exec(keySearchContent)) !== null) {
          const fullKey = keyMatch[1];
          const lineNumber = keySearchContent.substring(0, keyMatch.index).split('\n').length;

          const isDynamic = dynamicKeys.length > 0 && dynamicKeys.includes(fullKey);

          keyMatches.push({ key: fullKey, line: lineNumber, isDynamic });
        }

        if (hasUseTranslations || hasConst) {
          for (const km of keyMatches) {
            const fullKey = currentNamespace ? `${currentNamespace}.${km.key}` : km.key;

            keys.push({
              namespace: currentNamespace || 'unknown',
              key: km.key,
              fullKey,
              file: path.relative(WEB_APP_DIR, fullPath),
              line: km.line,
              platform: 'web',
              isDynamic: km.isDynamic,
              hasExplicitDeclaration: km.isDynamic,
            });
          }
        } else {
          for (const km of keyMatches) {
            const fullKey = km.key;
            const namespace = fullKey.split('.')[0];

            keys.push({
              namespace,
              key: km.key,
              fullKey,
              file: path.relative(WEB_APP_DIR, fullPath),
              line: km.line,
              platform: 'web',
              isDynamic: km.isDynamic,
              hasExplicitDeclaration: km.isDynamic,
            });
          }
        }
      }
    }
  }

  const appDir = path.join(dirPath, 'app');
  if (fs.existsSync(appDir)) {
    scanDir(appDir);
  } else {
    scanDir(dirPath);
  }

  return keys;
}

function validateKeys(): {
  errors: ValidationError[];
  warnings: ValidationError[];
} {
  const mobileKeys = loadTranslationKeys(MOBILE_BASE);
  const webKeys = loadTranslationKeys(WEB_BASE);
  const allKeys = new Set([...mobileKeys, ...webKeys]);

  const mobileParsedKeys = extractMobileKeys(MOBILE_APP_DIR);
  const webParsedKeys = extractWebKeys(WEB_APP_DIR);
  const allParsedKeys = [...mobileParsedKeys, ...webParsedKeys];

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  for (const parsed of allParsedKeys) {
    if (parsed.isDynamic && parsed.hasExplicitDeclaration) {
      continue;
    }

    const strippedKey = stripPluralSuffix(parsed.fullKey);

    if (!allKeys.has(strippedKey) && !allKeys.has(parsed.fullKey)) {
      errors.push({
        type: 'missing',
        key: parsed.fullKey,
        file: parsed.file,
        line: parsed.line,
        message: `Missing translation key: '${parsed.fullKey}'`,
      });
    }

    if (isFeaturePath(parsed.file)) {
      if (parsed.fullKey.startsWith('common.') && !SEMANTIC_COMMON_KEYS.has(parsed.key)) {
        warnings.push({
          type: 'common-semantic',
          key: parsed.fullKey,
          file: parsed.file,
          line: parsed.line,
          message: `Semantic common key '${parsed.fullKey}' used in feature file`,
        });
      }
    }

    if (parsed.platform === 'web' && parsed.namespace === 'unknown') {
      warnings.push({
        type: 'unknown-scope',
        key: parsed.fullKey,
        file: parsed.file,
        line: parsed.line,
        message: `Cannot resolve namespace for key '${parsed.fullKey}'`,
      });
    }
  }

  const keysArray = Array.from(allKeys);
  const pluralKeys = keysArray.filter((key) =>
    PLURAL_SUFFIXES.some((suffix) => key.endsWith(suffix)),
  );

  const baseKeys = new Set<string>();
  for (const key of pluralKeys) {
    const base = stripPluralSuffix(key);
    baseKeys.add(base);
  }

  for (const base of baseKeys) {
    const hasOne = allKeys.has(`${base}_one`);
    const hasOther = allKeys.has(`${base}_other`);

    if ((hasOne && !hasOther) || (!hasOne && hasOther)) {
      const missing = hasOne ? '_other' : '_one';
      errors.push({
        type: 'plural-missing',
        key: `${base}${missing}`,
        file: 'en.json',
        line: 0,
        message: `Plural key '${base}_one' found but '${base}_other' is missing (or vice versa)`,
      });
    }
  }

  return { errors, warnings };
}

function runPreSeedValidation(): void {
  console.log('Running pre-seed i18n validation...\n');

  const { errors, warnings } = validateKeys();

  if (errors.length > 0) {
    console.log(`❌ Found ${errors.length} error(s):\n`);
    for (const err of errors) {
      console.log(`  ${err.file}:${err.line}`);
      console.log(`    Key: ${err.key}`);
      console.log(`    ${err.message}\n`);
    }
    console.log('\n❌ Pre-seed validation FAILED - Cannot seed with missing keys');
    console.log('Please add the missing keys to the static JSON files before seeding.');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`⚠ Found ${warnings.length} warning(s):\n`);
    const byType = new Map<string, ValidationError[]>();
    for (const w of warnings) {
      const list = byType.get(w.type) || [];
      list.push(w);
      byType.set(w.type, list);
    }

    for (const [type, list] of byType) {
      console.log(`  [${type}]`);
      for (const w of list.slice(0, 5)) {
        console.log(`    ${w.file}:${w.line} - ${w.key}`);
      }
      if (list.length > 5) {
        console.log(`    ... and ${list.length - 5} more`);
      }
      console.log('');
    }
  }

  console.log('✓ Pre-seed validation PASSED\n');
}

async function seedTranslations(force: boolean, dryRun: boolean) {
  console.log('=== Translation Seeder ===\n');

  runPreSeedValidation();

  if (dryRun) {
    console.log('DRY RUN MODE - No database changes will be made\n');
  }

  console.log('Validating source files...');
  const sourceFiles: Array<{ lang: string; app: string; path: string }> = [];
  for (const lang of LANGUAGES) {
    const mobilePath = resolveFile(MOBILE_BASE, lang, 'mobile');
    const webPath = resolveFile(WEB_BASE, lang, 'web');
    validateFileExists(mobilePath);
    validateFileExists(webPath);
    sourceFiles.push({ lang, app: 'mobile', path: mobilePath });
    sourceFiles.push({ lang, app: 'web', path: webPath });
  }
  console.log(`  ✓ All ${sourceFiles.length} source files validated\n`);

  console.log('Loading and parsing JSON files...');
  const mobileData: Record<string, FlatTranslation[]> = {};
  const webData: Record<string, FlatTranslation[]> = {};
  for (const lang of LANGUAGES) {
    const mobilePath = resolveFile(MOBILE_BASE, lang, 'mobile');
    const webPath = resolveFile(WEB_BASE, lang, 'web');
    const mobileJson = readJsonFile(mobilePath);
    const webJson = readJsonFile(webPath);
    mobileData[lang] = flattenTranslations(mobileJson);
    webData[lang] = flattenTranslations(webJson);
    console.log(
      `  ${lang}: mobile ${mobileData[lang].length} keys, web ${webData[lang].length} keys`,
    );
  }
  console.log('');

  const app = await NestFactory.createApplicationContext(AppModule);
  const translationModel = app.get<Model<Translation>>(getModelToken(Translation.name));
  const languageModel = app.get<Model<Language>>(getModelToken(Language.name));

  const stats: Record<string, { new: number; skipped: number; conflict: number; updated: number }> =
    {};
  const allConflicts: Array<{
    key: string;
    mobileValue: string;
    webValue: string;
  }> = [];

  for (const lang of LANGUAGES) {
    stats[lang] = { new: 0, skipped: 0, conflict: 0, updated: 0 };
    const merged = mergeTranslations(mobileData[lang], webData[lang]);

    const conflicts = merged.filter(
      (m) =>
        mobileData[lang].some(
          (x) => x.namespace === m.namespace && x.key === m.key && x.value !== m.value,
        ) &&
        webData[lang].some(
          (x) => x.namespace === m.namespace && x.key === m.key && x.value !== m.value,
        ),
    );
    if (conflicts.length > 0) {
      stats[lang].conflict = conflicts.length;
      for (const c of conflicts) {
        const mobileVal = mobileData[lang].find(
          (x) => x.namespace === c.namespace && x.key === c.key,
        )?.value;
        const webVal = webData[lang].find(
          (x) => x.namespace === c.namespace && x.key === c.key,
        )?.value;
        if (mobileVal !== webVal) {
          allConflicts.push({
            key: `${c.namespace}::${c.key}`,
            mobileValue: mobileVal || '',
            webValue: webVal || '',
          });
        }
      }
    }

    let inserted = 0;
    let skipped = 0;
    let updated = 0;

    for (const t of merged) {
      const filter = { languageCode: lang, namespace: t.namespace, key: t.key };
      const existing = await translationModel.findOne(filter).exec();

      if (existing) {
        skipped++;
        if (force && !dryRun) {
          await translationModel.updateOne(filter, {
            $set: { value: t.value, platforms: t.platforms, updatedBy: null },
          });
          updated++;
        } else if (force && dryRun) {
          updated++;
        }
      } else {
        inserted++;
        if (!dryRun) {
          await translationModel.create({
            languageCode: lang,
            namespace: t.namespace,
            key: t.key,
            value: t.value,
            updatedBy: null,
            platforms: t.platforms,
          });
        }
      }
    }

    stats[lang].new = inserted;
    stats[lang].skipped = skipped;
    stats[lang].updated = updated;

    if (!dryRun) {
      await languageModel.updateOne(
        { code: lang },
        {
          $set: { isActive: true, direction: 'ltr' },
          $inc: { bundleVersion: 1 },
        },
        { upsert: true },
      );
    }
  }

  console.log('=== Seeding Results ===');
  for (const lang of LANGUAGES) {
    const parts: string[] = [];
    parts.push(`${stats[lang].new} new`);
    parts.push(`${stats[lang].skipped} existing`);
    if (force) {
      parts.push(`${stats[lang].updated} updated`);
    }
    if (stats[lang].conflict > 0) {
      parts.push(`${stats[lang].conflict} conflicts`);
    }
    if (dryRun) {
      console.log(`  ${lang}: ${parts.join(', ')} [DRY RUN]`);
    } else {
      console.log(`  ${lang}: ${parts.join(', ')}`);
    }
  }
  console.log('');

  if (allConflicts.length > 0) {
    console.log('=== Value Conflicts (using web value as canonical) ===');
    for (const c of allConflicts) {
      console.log(`  ${c.key}:`);
      console.log(`    mobile: "${c.mobileValue}"`);
      console.log(`    web:    "${c.webValue}"`);
    }
    console.log('');
  }

  console.log('Checking for orphaned keys in DB...');
  const mergedKeys = new Set<string>();
  for (const lang of LANGUAGES) {
    const merged = mergeTranslations(mobileData[lang], webData[lang]);
    for (const t of merged) {
      mergedKeys.add(`${lang}::${t.namespace}::${t.key}`);
    }
  }

  const dbTranslations = await translationModel
    .find({}, { languageCode: 1, namespace: 1, key: 1 })
    .exec();
  const orphans: Array<{ langCode: string; namespace: string; key: string }> = [];
  for (const t of dbTranslations) {
    const key = `${t.languageCode}::${t.namespace}::${t.key}`;
    if (!mergedKeys.has(key)) {
      orphans.push({
        langCode: t.languageCode,
        namespace: t.namespace,
        key: t.key,
      });
    }
  }

  if (orphans.length > 0) {
    console.log(`  ⚠ Found ${orphans.length} orphaned keys (in DB but not in static JSON):`);
    for (const o of orphans.slice(0, 20)) {
      console.log(`    ${o.langCode}::${o.namespace}::${o.key}`);
    }
    if (orphans.length > 20) {
      console.log(`    ... and ${orphans.length - 20} more`);
    }
  } else {
    console.log('  ✓ No orphaned keys found');
  }
  console.log('');

  console.log('=== Summary ===');
  const totalKeys = Object.values(stats).reduce((sum, s) => sum + s.new + s.skipped, 0);
  console.log(`  Total keys in DB: ${totalKeys}`);
  console.log(`  Languages seeded: ${LANGUAGES.join(', ')}`);
  console.log(`  Conflicts resolved: ${allConflicts.length}`);
  console.log(`  Orphans: ${orphans.length}`);
  console.log('');

  await app.close();
  console.log('Seeding complete.');
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  if (dryRun) {
    console.log('DRY RUN MODE ENABLED - No database changes will be made\n');
  }

  if (force && !dryRun) {
    console.log('WARNING: --force will overwrite ALL translations including admin edits.');
    console.log('Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log('Continuing with seed...\n');
  }

  try {
    await seedTranslations(force, dryRun);

    if (dryRun) {
      console.log('\n=== Dry Run Complete ===');
      console.log('No database changes were made.');
      console.log('Run without --dry-run to apply these changes.');
    } else {
      console.log('\nSeeding complete.');
    }
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
