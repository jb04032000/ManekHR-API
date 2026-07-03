import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Language } from './schemas/language.schema';
import { Translation } from './schemas/translation.schema';
import { CreateLanguageDto, UpdateLanguageDto } from './dto/localization.dto';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class LocalizationService {
  private bundleCache = new Map<string, { bundle: Record<string, any>; cachedAt: number }>();

  constructor(
    @InjectModel(Language.name) private languageModel: Model<Language>,
    @InjectModel(Translation.name)
    private translationModel: Model<Translation>,
  ) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Flatten a nested translations JSON into { namespace, key, value } records.
   * Top-level keys become the namespace; deeper keys are joined with dots.
   */
  flattenJson(
    obj: Record<string, any>,
    prefix = '',
  ): Array<{ namespace: string; key: string; value: string }> {
    const results: Array<{
      namespace: string;
      key: string;
      value: string;
    }> = [];

    for (const [topKey, topValue] of Object.entries(obj)) {
      if (prefix === '') {
        if (typeof topValue === 'object' && topValue !== null) {
          this._flattenInner(topValue, topKey, '', results);
        } else {
          results.push({
            namespace: topKey,
            key: topKey,
            value: String(topValue),
          });
        }
      }
    }

    return results;
  }

  private _flattenInner(
    obj: Record<string, any>,
    namespace: string,
    keyPrefix: string,
    results: Array<{ namespace: string; key: string; value: string }>,
  ): void {
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = keyPrefix ? `${keyPrefix}.${k}` : k;
      if (typeof v === 'object' && v !== null) {
        this._flattenInner(v, namespace, fullKey, results);
      } else {
        results.push({
          namespace,
          key: fullKey,
          value: String(v),
        });
      }
    }
  }

  /**
   * Rebuild nested JSON bundle from flat Translation documents.
   */
  buildBundle(translations: Translation[]): Record<string, any> {
    const bundle: Record<string, any> = {};

    for (const t of translations) {
      if (!bundle[t.namespace]) {
        bundle[t.namespace] = {};
      }

      const keyParts = t.key.split('.');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      let cursor: Record<string, any> = bundle[t.namespace];

      for (let i = 0; i < keyParts.length - 1; i++) {
        if (!cursor[keyParts[i]] || typeof cursor[keyParts[i]] !== 'object') {
          cursor[keyParts[i]] = {};
        }
        cursor = cursor[keyParts[i]] as Record<string, any>;
      }

      cursor[keyParts[keyParts.length - 1]] = t.value;
    }

    return bundle;
  }

  private bustCache(langCode: string): void {
    for (const key of this.bundleCache.keys()) {
      if (key === langCode || key.startsWith(`${langCode}:`)) {
        this.bundleCache.delete(key);
      }
    }
  }

  private async incrementBundleVersion(langCode: string): Promise<void> {
    await this.languageModel.updateOne({ code: langCode }, { $inc: { bundleVersion: 1 } }).exec();
  }

  // -------------------------------------------------------------------------
  // Language seed
  // -------------------------------------------------------------------------

  async ensureLanguagesExist(): Promise<void> {
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
        code: 'gu',
        name: 'Gujarati',
        nativeName: 'ગુજરાતી',
        example: 'નમસ્તે',
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
      {
        code: 'hi-en',
        name: 'Hinglish',
        nativeName: 'Hinglish',
        example: 'Namaste, Welcome!',
        isDefault: false,
        isActive: true,
        bundleVersion: 1,
      },
    ];

    for (const lang of languages) {
      await this.languageModel.updateOne(
        { code: lang.code },
        { $setOnInsert: lang },
        { upsert: true },
      );
    }
  }

  async getDistinctNamespaces(): Promise<string[]> {
    const namespaces = await this.translationModel.distinct('namespace').exec();
    return namespaces.sort();
  }

  // -------------------------------------------------------------------------
  // Language methods
  // -------------------------------------------------------------------------

  async getLanguages(): Promise<Language[]> {
    return this.languageModel.find({ isActive: true }).exec();
  }

  async getAllLanguages(): Promise<Language[]> {
    return this.languageModel.find().exec();
  }

  async createLanguage(dto: CreateLanguageDto, _userId: string): Promise<Language> {
    if (dto.isDefault) {
      await this.languageModel
        .updateMany({ isDefault: true }, { $set: { isDefault: false } })
        .exec();
    }

    const language = new this.languageModel({ ...dto, bundleVersion: 1 });
    return language.save();
  }

  async updateLanguage(code: string, dto: UpdateLanguageDto, _userId: string): Promise<Language> {
    if (dto.isDefault) {
      await this.languageModel
        .updateMany({ isDefault: true }, { $set: { isDefault: false } })
        .exec();
    }

    const language = await this.languageModel
      .findOneAndUpdate({ code }, { $set: dto }, { new: true })
      .exec();

    if (!language) throw new NotFoundException(`Language '${code}' not found`);

    return language;
  }

  async softDeleteLanguage(code: string): Promise<Language> {
    const language = await this.languageModel.findOne({ code }).exec();
    if (!language) throw new NotFoundException(`Language '${code}' not found`);
    if (language.isDefault) {
      throw new ForbiddenException('Cannot delete the default language');
    }

    language.isActive = false;
    return language.save();
  }

  async hardDeleteLanguage(code: string): Promise<{ deleted: boolean }> {
    const language = await this.languageModel.findOne({ code }).exec();
    if (!language) throw new NotFoundException(`Language '${code}' not found`);
    if (language.isDefault) {
      throw new ForbiddenException('Cannot delete the default language');
    }

    await this.translationModel.deleteMany({ languageCode: code }).exec();
    await this.languageModel.deleteOne({ code }).exec();
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // Version check
  // -------------------------------------------------------------------------

  async getVersion(langCode: string): Promise<{ version: number; updatedAt: Date }> {
    const language = await this.languageModel.findOne({ code: langCode }).exec();
    if (!language) throw new NotFoundException(`Language '${langCode}' not found`);
    return {
      version: language.bundleVersion,
      updatedAt: language.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Bundle / translation methods
  // -------------------------------------------------------------------------

  async getBundle(langCode: string, platform?: string): Promise<Record<string, any>> {
    const cacheKey = platform ? `${langCode}:${platform}` : langCode;
    const cached = this.bundleCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.bundle;
    }

    const language = await this.languageModel.findOne({ code: langCode }).exec();

    if (!language) {
      const defaultLang = await this.languageModel.findOne({ isDefault: true }).exec();
      const fallbackCode = defaultLang?.code ?? 'en';
      return this.getBundle(fallbackCode, platform);
    }

    const filter: Record<string, any> = { languageCode: langCode };
    if (platform) filter.platforms = platform;

    const translations = await this.translationModel.find(filter).exec();

    const bundle = this.buildBundle(translations);
    this.bundleCache.set(cacheKey, { bundle, cachedAt: Date.now() });

    return bundle;
  }

  async exportBundle(langCode: string): Promise<Record<string, any>> {
    const translations = await this.translationModel.find({ languageCode: langCode }).exec();

    return this.buildBundle(translations);
  }

  async upsertTranslation(
    langCode: string,
    namespace: string,
    key: string,
    value: string,
    userId: string,
    platforms?: string[],
    metadata?: {
      description?: string;
      screen?: string;
      feature?: string;
      componentRef?: string;
      tags?: string[];
    },
  ): Promise<Translation> {
    const updateSet: Record<string, any> = { value, updatedBy: userId };
    if (platforms) updateSet.platforms = platforms;
    if (metadata?.description !== undefined) updateSet.description = metadata.description;
    if (metadata?.screen !== undefined) updateSet.screen = metadata.screen;
    if (metadata?.feature !== undefined) updateSet.feature = metadata.feature;
    if (metadata?.componentRef !== undefined) updateSet.componentRef = metadata.componentRef;
    if (metadata?.tags !== undefined) updateSet.tags = metadata.tags;

    const translation = await this.translationModel
      .findOneAndUpdate(
        { languageCode: langCode, namespace, key },
        { $set: updateSet },
        { upsert: true, new: true },
      )
      .exec();

    this.bustCache(langCode);
    await this.incrementBundleVersion(langCode);

    return translation;
  }

  async deleteTranslation(
    langCode: string,
    namespace: string,
    key: string,
  ): Promise<{ deleted: boolean }> {
    const result = await this.translationModel
      .deleteOne({ languageCode: langCode, namespace, key })
      .exec();

    if (result.deletedCount === 0) {
      throw new NotFoundException(`Translation '${namespace}.${key}' not found for '${langCode}'`);
    }

    this.bustCache(langCode);
    await this.incrementBundleVersion(langCode);

    return { deleted: true };
  }

  async bulkImport(
    langCode: string,
    translations: Record<string, any>,
    userId: string,
    platform?: string,
  ): Promise<{ upserted: number }> {
    const flat = this.flattenJson(translations);

    if (flat.length === 0) return { upserted: 0 };

    const ops = flat.map(({ namespace, key, value }) => {
      const setOnInsert: Record<string, any> = {
        languageCode: langCode,
        namespace,
        key,
      };
      if (platform) {
        setOnInsert.platforms = [platform];
      } else {
        setOnInsert.platforms = ['mobile', 'web'];
      }

      return {
        updateOne: {
          filter: { languageCode: langCode, namespace, key },
          update: {
            $set: { value, updatedBy: userId },
            $setOnInsert: setOnInsert,
          },
          upsert: true,
        },
      };
    });

    const result = await this.translationModel.bulkWrite(ops, {
      ordered: false,
    });

    this.bustCache(langCode);
    await this.incrementBundleVersion(langCode);

    return {
      upserted: (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0),
    };
  }

  async copyFromDefault(
    targetLangCode: string,
    userId: string,
    platform?: string,
  ): Promise<{ copied: number }> {
    const defaultLang = await this.languageModel.findOne({ isDefault: true }).exec();

    if (!defaultLang) throw new NotFoundException('No default language configured');

    const targetLang = await this.languageModel.findOne({ code: targetLangCode }).exec();

    if (!targetLang) throw new NotFoundException(`Language '${targetLangCode}' not found`);

    const filter: Record<string, any> = { languageCode: defaultLang.code };
    if (platform) filter.platforms = platform;

    const defaultTranslations = await this.translationModel.find(filter).exec();

    const targetFilter: Record<string, any> = { languageCode: targetLangCode };
    if (platform) targetFilter.platforms = platform;

    const existingTarget = await this.translationModel
      .find(targetFilter, { key: 1, namespace: 1 })
      .exec();

    const existingKeys = new Set(existingTarget.map((t) => `${t.namespace}:${t.key}`));

    const defaultKeys = defaultTranslations
      .filter((t) => !existingKeys.has(`${t.namespace}:${t.key}`))
      .map((t) => ({
        namespace: t.namespace,
        key: t.key,
        value: t.value,
      }));

    if (defaultKeys.length === 0) return { copied: 0 };

    const ops = defaultKeys.map(({ namespace, key, value }) => {
      const setOnInsert: Record<string, any> = {
        languageCode: targetLangCode,
        namespace,
        key,
      };
      if (platform) {
        setOnInsert.platforms = [platform];
      } else {
        setOnInsert.platforms = ['mobile', 'web'];
      }

      return {
        updateOne: {
          filter: { languageCode: targetLangCode, namespace, key },
          update: {
            $set: { value, updatedBy: userId },
            $setOnInsert: setOnInsert,
          },
          upsert: true,
        },
      };
    });

    await this.translationModel.bulkWrite(ops, { ordered: false });

    this.bustCache(targetLangCode);
    await this.incrementBundleVersion(targetLangCode);

    return { copied: defaultKeys.length };
  }

  async getTranslationDiff(
    langCode: string,
    platform?: string,
  ): Promise<Array<{ namespace: string; key: string }>> {
    const defaultLang = await this.languageModel.findOne({ isDefault: true }).exec();

    const defaultCode = defaultLang?.code ?? 'en';

    if (langCode === defaultCode) return [];

    const defaultFilter: Record<string, any> = {
      languageCode: defaultCode,
    };
    const targetFilter: Record<string, any> = {
      languageCode: langCode,
    };
    if (platform) {
      defaultFilter.platforms = platform;
      targetFilter.platforms = platform;
    }

    const [defaultDocs, targetDocs] = await Promise.all([
      this.translationModel.find(defaultFilter, { namespace: 1, key: 1 }).exec(),
      this.translationModel.find(targetFilter, { namespace: 1, key: 1 }).exec(),
    ]);

    const targetSet = new Set(targetDocs.map((t) => `${t.namespace}::${t.key}`));

    const missing = defaultDocs
      .filter((d) => !targetSet.has(`${d.namespace}::${d.key}`))
      .map((d) => ({ namespace: d.namespace, key: d.key }));

    return missing;
  }

  async getTranslations(
    langCode: string,
    namespace?: string,
    platform?: string,
    screen?: string,
    feature?: string,
  ): Promise<Translation[]> {
    const filter: Record<string, any> = { languageCode: langCode };
    if (namespace) filter.namespace = namespace;
    if (platform) filter.platforms = platform;
    if (screen) filter.screen = screen;
    if (feature) filter.feature = feature;

    return this.translationModel.find(filter).sort({ namespace: 1, key: 1 }).exec();
  }

  async getTranslationsIndex(opts?: {
    langCode?: string;
    module?: string;
    screen?: string;
    feature?: string;
  }): Promise<{
    tuples: Array<{
      namespace: string;
      screen: string | null;
      feature: string | null;
      count: number;
    }>;
    totalKeys: number;
    withMetadataPercent: number;
  }> {
    const match: Record<string, any> = {};
    if (opts?.langCode) match.languageCode = opts.langCode;
    if (opts?.module) match.namespace = opts.module;
    if (opts?.screen) match.screen = opts.screen;
    if (opts?.feature) match.feature = opts.feature;

    const tuplesAgg = await this.translationModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              namespace: '$namespace',
              screen: '$screen',
              feature: '$feature',
            },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            namespace: '$_id.namespace',
            screen: '$_id.screen',
            feature: '$_id.feature',
            count: 1,
          },
        },
        { $sort: { namespace: 1, screen: 1, feature: 1 } },
      ])
      .exec();

    const totalKeys = await this.translationModel.countDocuments(match).exec();
    const withMetadata = await this.translationModel
      .countDocuments({ ...match, screen: { $ne: null } })
      .exec();

    const withMetadataPercent =
      totalKeys === 0 ? 0 : Math.round((withMetadata / totalKeys) * 1000) / 10;

    return {
      tuples: tuplesAgg as Array<{
        namespace: string;
        screen: string | null;
        feature: string | null;
        count: number;
      }>,
      totalKeys,
      withMetadataPercent,
    };
  }
}
