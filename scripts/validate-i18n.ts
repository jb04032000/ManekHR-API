import * as fs from 'fs';
import * as path from 'path';

const MOBILE_BASE =
  process.env.MOBILE_TRANSLATIONS_DIR ||
  path.resolve(__dirname, '../../zari360-app/localization/static');
const WEB_BASE =
  process.env.WEB_TRANSLATIONS_DIR || path.resolve(__dirname, '../../zari360-web/app/messages');

const MOBILE_APP_DIR = process.env.MOBILE_APP_DIR || path.resolve(__dirname, '../../zari360-app');
const WEB_APP_DIR = process.env.WEB_APP_DIR || path.resolve(__dirname, '../../zari360-web');

const SUPPORTED_LOCALES = ['en', 'gu', 'gu-en', 'hi-en'] as const;
const DEFAULT_LOCALE = 'en';

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

function parseArgs(): { platform: 'mobile' | 'web' | 'all' } {
  const args = process.argv.slice(2);
  const platformIndex = args.indexOf('--platform');
  let platform: 'mobile' | 'web' | 'all' = 'all';

  if (platformIndex !== -1 && args[platformIndex + 1]) {
    const val = args[platformIndex + 1];
    if (val === 'mobile' || val === 'web' || val === 'all') {
      platform = val;
    }
  }

  return { platform };
}

function loadTranslationKeys(basePath: string, _platform: 'mobile' | 'web'): Set<string> {
  const enPath = path.join(basePath, 'en.json');
  if (!fs.existsSync(enPath)) {
    console.error(`Missing en.json at ${enPath}`);
    return new Set();
  }

  const json = JSON.parse(fs.readFileSync(enPath, 'utf-8')) as Record<string, unknown>;
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

function getAllTranslationKeys(): {
  mobile: Set<string>;
  web: Set<string>;
  all: Set<string>;
} {
  const mobileKeys = loadTranslationKeys(MOBILE_BASE, 'mobile');
  const webKeys = loadTranslationKeys(WEB_BASE, 'web');
  const allKeys = new Set([...mobileKeys, ...webKeys]);

  return { mobile: mobileKeys, web: webKeys, all: allKeys };
}

function stripPluralSuffix(key: string): string {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) {
      return key.slice(0, -suffix.length);
    }
  }
  return key;
}

function extractDynamicKeysFromFile(_filePath: string, content: string): string[] {
  const keys: string[] = [];
  const regex = /\/\/\s*i18n-keys:\s*([\w.,\s]+)/g;
  let match: RegExpExecArray | null;

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getFileLanguage(filePath: string): 'mobile' | 'web' | 'unknown' {
  if (filePath.includes('zari360-app') || filePath.includes('zari360-app/src')) {
    return 'mobile';
  }
  if (
    filePath.includes('zari360-web') ||
    filePath.includes('zari360-web/src') ||
    filePath.includes('zari360-web/app')
  ) {
    return 'web';
  }
  return 'unknown';
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

        const dynamicKeys = extractDynamicKeysFromFile(fullPath, content);

        let match: RegExpExecArray | null;
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

  function scanDir(dir: string, context: { namespace?: string; hasConst?: boolean } = {}): void {
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
          scanDir(fullPath, context);
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
        const dynamicKeys = extractDynamicKeysFromFile(fullPath, content);

        const namespaceConstMatches = Array.from(content.matchAll(namespaceConstPattern));
        const exportedNamespace = namespaceConstMatches[0]?.[1];

        const namespaceDeclMatches: string[] = [];
        let nsMatch: RegExpExecArray | null;
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
        let keyMatch: RegExpExecArray | null;
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

function loadKeysForLocale(basePath: string, locale: string): Set<string> | null {
  const localePath = path.join(basePath, `${locale}.json`);
  if (!fs.existsSync(localePath)) return null;

  const json = JSON.parse(fs.readFileSync(localePath, 'utf-8')) as Record<string, unknown>;
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

function validateLocaleCompleteness(basePath: string, platformLabel: string): ValidationError[] {
  const errors: ValidationError[] = [];

  const defaultKeys = loadKeysForLocale(basePath, DEFAULT_LOCALE);
  if (!defaultKeys) {
    return errors;
  }

  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const localeKeys = loadKeysForLocale(basePath, locale);
    if (!localeKeys) {
      errors.push({
        type: 'missing',
        key: `${locale}.json`,
        file: path.join(basePath, `${locale}.json`),
        line: 0,
        message: `Missing locale catalog (${platformLabel}): ${locale}.json`,
      });
      continue;
    }
    for (const k of defaultKeys) {
      if (!localeKeys.has(k)) {
        errors.push({
          type: 'missing',
          key: k,
          file: path.join(basePath, `${locale}.json`),
          line: 0,
          message: `[${platformLabel}] ${locale} missing key '${k}'`,
        });
      }
    }
  }

  return errors;
}

function validatePluralKeys(allKeys: Set<string>): ValidationError[] {
  const errors: ValidationError[] = [];
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

  return errors;
}

function validate(platform: 'mobile' | 'web' | 'all'): {
  errors: ValidationError[];
  warnings: ValidationError[];
} {
  const { mobile: mobileKeys, web: webKeys, all: allKeys } = getAllTranslationKeys();

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const mobileParsedKeys: ParsedKey[] = [];
  const webParsedKeys: ParsedKey[] = [];

  if (platform === 'mobile' || platform === 'all') {
    mobileParsedKeys.push(...extractMobileKeys(MOBILE_APP_DIR));
  }

  if (platform === 'web' || platform === 'all') {
    webParsedKeys.push(...extractWebKeys(WEB_APP_DIR));
  }

  const allParsedKeys = [...mobileParsedKeys, ...webParsedKeys];

  const keysToCheck = platform === 'mobile' ? mobileKeys : platform === 'web' ? webKeys : allKeys;

  for (const parsed of allParsedKeys) {
    if (parsed.isDynamic && parsed.hasExplicitDeclaration) {
      continue;
    }

    const strippedKey = stripPluralSuffix(parsed.fullKey);

    if (!keysToCheck.has(strippedKey) && !keysToCheck.has(parsed.fullKey)) {
      if (parsed.platform === 'mobile' || platform === 'all') {
        errors.push({
          type: 'missing',
          key: parsed.fullKey,
          file: parsed.file,
          line: parsed.line,
          message: `Missing translation key: '${parsed.fullKey}'`,
        });
      }
    }

    if (isFeaturePath(parsed.file)) {
      if (parsed.fullKey.startsWith('common.') && !SEMANTIC_COMMON_KEYS.has(parsed.key)) {
        warnings.push({
          type: 'common-semantic',
          key: parsed.fullKey,
          file: parsed.file,
          line: parsed.line,
          message: `Semantic common key '${parsed.fullKey}' used in feature file. Consider using a feature-specific key.`,
        });
      }
    }

    if (parsed.platform === 'web' && parsed.namespace === 'unknown') {
      warnings.push({
        type: 'unknown-scope',
        key: parsed.fullKey,
        file: parsed.file,
        line: parsed.line,
        message: `Cannot resolve namespace for key '${parsed.fullKey}'. Use export const TRANSLATION_NAMESPACE = 'namespace' in the file or use a fully qualified key.`,
      });
    }
  }

  const pluralErrors = validatePluralKeys(allKeys);
  for (const err of pluralErrors) {
    if (platform === 'all') {
      errors.push(err);
    }
  }

  if (platform === 'web' || platform === 'all') {
    errors.push(...validateLocaleCompleteness(WEB_BASE, 'web'));
  }

  return { errors, warnings };
}

function printResults(
  platform: 'mobile' | 'web' | 'all',
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  const platformLabel =
    platform === 'all' ? 'all platforms' : platform === 'mobile' ? 'mobile' : 'web';

  console.log(`=== i18n Validation Report (${platformLabel}) ===\n`);

  if (errors.length === 0 && warnings.length === 0) {
    console.log('✓ No issues found');
    return;
  }

  if (errors.length > 0) {
    console.log(`❌ Found ${errors.length} error(s):\n`);
    for (const err of errors) {
      console.log(`  ${err.file}:${err.line}`);
      console.log(`    Key: ${err.key}`);
      console.log(`    ${err.message}\n`);
    }
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
      for (const w of list.slice(0, 10)) {
        console.log(`    ${w.file}:${w.line} - ${w.key}`);
      }
      if (list.length > 10) {
        console.log(`    ... and ${list.length - 10} more`);
      }
      console.log('');
    }
  }
}

function main(): void {
  const { platform } = parseArgs();

  if (platform === 'mobile' || platform === 'all') {
    console.warn(
      '⚠ Mobile platform validation is OUT OF SCOPE for the Polish Initiative — paths may not exist. Continuing anyway.\n',
    );
  }

  console.log(`Validating i18n for platform: ${platform}\n`);

  const { errors, warnings } = validate(platform);

  printResults(platform, errors, warnings);

  if (errors.length > 0) {
    console.log('\n❌ Validation FAILED - Missing keys found');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log('\n⚠ Validation PASSED with warnings');
    process.exit(0);
  }

  console.log('\n✓ Validation PASSED');
  process.exit(0);
}

main();
