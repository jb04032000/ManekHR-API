/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalizationService } from '../localization.service';

describe('LocalizationService', () => {
  let languageModel: any;
  let translationModel: any;
  let svc: LocalizationService;

  beforeEach(() => {
    languageModel = {
      updateOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(null) }),
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
      updateMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
      deleteOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
    };
    translationModel = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ exec: () => Promise.resolve([]) }),
        exec: () => Promise.resolve([]),
      }),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ value: 'x' }),
      }),
      deleteOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve({ deletedCount: 1 }) }),
      deleteMany: vi.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
      bulkWrite: vi.fn().mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 }),
      aggregate: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
      countDocuments: vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) }),
      distinct: vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) }),
    };
    svc = new LocalizationService(languageModel, translationModel);
  });

  describe('flattenJson <-> buildBundle round trip', () => {
    it('preserves keys and values', () => {
      const input = {
        common: { save: 'Save', delete: 'Delete' },
        auth: { login: { title: 'Welcome' } },
      };
      const flat = svc.flattenJson(input);
      // build a minimal Translation-like array
      const translations = flat.map((f) => ({
        namespace: f.namespace,
        key: f.key,
        value: f.value,
      })) as any[];
      const rebuilt = svc.buildBundle(translations);
      expect(rebuilt.common.save).toBe('Save');
      expect(rebuilt.common.delete).toBe('Delete');
      expect(rebuilt.auth.login.title).toBe('Welcome');
    });
  });

  describe('upsertTranslation', () => {
    it('writes new metadata fields when provided', async () => {
      await svc.upsertTranslation('en', 'team', 'list.title', 'Members', 'user1', ['web'], {
        description: 'Page header',
        screen: 'team.list',
        feature: 'header',
        componentRef: 'TeamListHeader',
        tags: ['phase-1a'],
      });
      const call = translationModel.findOneAndUpdate.mock.calls[0];
      const setOp = call[1].$set;
      expect(setOp.value).toBe('Members');
      expect(setOp.platforms).toEqual(['web']);
      expect(setOp.description).toBe('Page header');
      expect(setOp.screen).toBe('team.list');
      expect(setOp.feature).toBe('header');
      expect(setOp.componentRef).toBe('TeamListHeader');
      expect(setOp.tags).toEqual(['phase-1a']);
    });

    it('omits unset metadata fields (legacy callers stay compatible)', async () => {
      await svc.upsertTranslation('en', 'team', 'list.title', 'Members', 'user1');
      const setOp = translationModel.findOneAndUpdate.mock.calls[0][1].$set;
      expect(setOp).not.toHaveProperty('description');
      expect(setOp).not.toHaveProperty('screen');
      expect(setOp).not.toHaveProperty('feature');
      expect(setOp).not.toHaveProperty('tags');
    });
  });

  describe('getTranslations', () => {
    it('applies new screen and feature filters when provided', async () => {
      await svc.getTranslations('en', 'team', 'web', 'team.list', 'bulk');
      const filter = translationModel.find.mock.calls[0][0];
      expect(filter.languageCode).toBe('en');
      expect(filter.namespace).toBe('team');
      expect(filter.platforms).toBe('web');
      expect(filter.screen).toBe('team.list');
      expect(filter.feature).toBe('bulk');
    });

    it('omits screen/feature filters when undefined (back-compat)', async () => {
      await svc.getTranslations('en', 'team');
      const filter = translationModel.find.mock.calls[0][0];
      expect(filter).not.toHaveProperty('screen');
      expect(filter).not.toHaveProperty('feature');
    });
  });

  describe('getTranslationsIndex', () => {
    it('returns tuples + counts + withMetadataPercent', async () => {
      translationModel.aggregate = vi.fn().mockReturnValue({
        exec: () =>
          Promise.resolve([
            {
              namespace: 'team',
              screen: 'team.list',
              feature: 'header',
              count: 5,
            },
            {
              namespace: 'attendance',
              screen: null,
              feature: null,
              count: 12,
            },
          ]),
      });
      translationModel.countDocuments = vi
        .fn()
        .mockReturnValueOnce({ exec: () => Promise.resolve(17) })
        .mockReturnValueOnce({ exec: () => Promise.resolve(5) });

      const result = await svc.getTranslationsIndex();
      expect(result.tuples).toHaveLength(2);
      expect(result.totalKeys).toBe(17);
      expect(result.withMetadataPercent).toBeCloseTo((5 / 17) * 100, 1);
    });

    it('reports 0 percent when no rows', async () => {
      translationModel.aggregate = vi.fn().mockReturnValue({ exec: () => Promise.resolve([]) });
      translationModel.countDocuments = vi.fn().mockReturnValue({ exec: () => Promise.resolve(0) });

      const result = await svc.getTranslationsIndex({ langCode: 'gu' });
      expect(result.totalKeys).toBe(0);
      expect(result.withMetadataPercent).toBe(0);
    });
  });

  describe('ensureLanguagesExist', () => {
    it('seeds en/gu/gu-en/hi-en — no es, no hi', async () => {
      await svc.ensureLanguagesExist();
      const seededCodes = languageModel.updateOne.mock.calls.map((c: any[]) => c[0].code);
      expect(seededCodes).toEqual(['en', 'gu', 'gu-en', 'hi-en']);
      expect(seededCodes).not.toContain('es');
      expect(seededCodes).not.toContain('hi');
    });

    it('marks `en` as default and others as non-default', async () => {
      await svc.ensureLanguagesExist();
      const enCall = languageModel.updateOne.mock.calls.find((c: any[]) => c[0].code === 'en');
      const guEnCall = languageModel.updateOne.mock.calls.find((c: any[]) => c[0].code === 'gu-en');
      expect(enCall[1].$setOnInsert.isDefault).toBe(true);
      expect(guEnCall[1].$setOnInsert.isDefault).toBe(false);
    });
  });
});
