/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose, { Types, Model } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  type TestMongo,
} from '../../../../test-utils/mongo-memory';
import {
  ConnectProfile,
  ConnectProfileSchema,
  CONNECT_PROFILE_VISIBILITIES,
  CONNECT_CONTACT_PREFERENCES,
  CONNECT_TRAINING_CONFIRM_STATUSES,
} from '../schemas/connect-profile.schema';

/**
 * Schema-validation coverage for `ConnectProfile`.
 *
 * Runs against a real in-memory MongoDB (mongodb-memory-server) so index
 * builds + validators are exercised exactly as in production. Verifies:
 *   - the 1:1 `userId` unique index rejects a second profile for the same user;
 *   - the documented indexes are actually built;
 *   - defaults materialise (`visibility`, `openTo`, `rateCard`, `strength`,
 *     `skills`, arrays);
 *   - the `visibility` enum rejects unknown values;
 *   - embedded sub-documents (portfolio / experience / recommendation) persist;
 *   - sub-documents carry no own `_id` (`_id: false`).
 */
describe('ConnectProfile schema', () => {
  let mongo: TestMongo;
  let model: Model<ConnectProfile>;

  beforeAll(async () => {
    mongo = await createTestMongoose();
    // Define-or-reuse so a re-run in the same process does not throw
    // OverwriteModelError.
    model = (() => {
      try {
        return mongoose.model<ConnectProfile>(ConnectProfile.name);
      } catch {
        return mongoose.model<ConnectProfile>(ConnectProfile.name, ConnectProfileSchema);
      }
    })();
    await model.syncIndexes();
    // 60s — mongodb-memory-server may download the MongoDB binary on the
    // very first run on a fresh machine / CI cache.
  }, 60_000);

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);
    // clearCollections drops documents but keeps indexes — re-sync defensively.
    await model.syncIndexes();
  });

  it('persists a minimal profile and materialises every default', async () => {
    const userId = new Types.ObjectId();
    const doc = await model.create({ userId });

    expect(doc.userId.toString()).toBe(userId.toString());
    // Scalar defaults.
    expect(doc.headline).toBe('');
    expect(doc.bio).toBe('');
    expect(doc.banner).toBe('');
    expect(doc.strength).toBe(0);
    expect(doc.visibility).toBe('public');
    expect(doc.contactPreference).toBe('whatsapp');
    // Array defaults.
    expect(doc.skills).toEqual([]);
    expect(doc.portfolio).toEqual([]);
    expect(doc.experience).toEqual([]);
    expect(doc.recommendations).toEqual([]);
    // Sub-document defaults.
    expect(doc.openTo.work).toBe(false);
    expect(doc.openTo.hiring).toBe(false);
    expect(doc.openTo.deals).toBe(false);
    expect(doc.openTo.customOrders).toBe(false);
    expect(doc.rateCard).toBeDefined();
    expect(doc.rateCard.dailyWage).toBeUndefined();
    // timestamps.
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('enforces the 1:1 userId unique index — a second profile for the same user is rejected', async () => {
    const userId = new Types.ObjectId();
    await model.create({ userId });

    await expect(model.create({ userId })).rejects.toThrow();
  });

  it('allows separate profiles for different users', async () => {
    await model.create({ userId: new Types.ObjectId() });
    const second = await model.create({ userId: new Types.ObjectId() });
    expect(second._id).toBeDefined();
    expect(await model.countDocuments()).toBe(2);
  });

  it('builds the documented indexes (userId unique, visibility+updatedAt)', async () => {
    const indexes = await model.collection.indexes();
    const byKey = (key: Record<string, number>) =>
      indexes.find((ix: any) => JSON.stringify(ix.key) === JSON.stringify(key));

    const userIdIx = byKey({ userId: 1 });
    expect(userIdIx).toBeDefined();
    expect(userIdIx?.unique).toBe(true);

    expect(byKey({ visibility: 1, updatedAt: -1 })).toBeDefined();
  });

  it('rejects an unknown visibility value', async () => {
    await expect(
      model.create({
        userId: new Types.ObjectId(),
        visibility: 'everyone' as any,
      }),
    ).rejects.toThrow();
  });

  it('accepts every documented visibility value', async () => {
    for (const visibility of CONNECT_PROFILE_VISIBILITIES) {
      const doc = await model.create({
        userId: new Types.ObjectId(),
        visibility,
      });
      expect(doc.visibility).toBe(visibility);
    }
  });

  it('accepts every documented contactPreference and rejects unknown values', async () => {
    for (const contactPreference of CONNECT_CONTACT_PREFERENCES) {
      const doc = await model.create({
        userId: new Types.ObjectId(),
        contactPreference,
      });
      expect(doc.contactPreference).toBe(contactPreference);
    }
    await expect(
      model.create({
        userId: new Types.ObjectId(),
        contactPreference: 'pigeon' as any,
      }),
    ).rejects.toThrow();
  });

  it('persists embedded portfolio / experience / recommendation sub-documents', async () => {
    const userId = new Types.ObjectId();
    const fromUserId = new Types.ObjectId();
    const doc = await model.create({
      userId,
      headline: 'Zari karigar · 12 yrs',
      skills: ['zari', 'sequins', 'aari'],
      portfolio: [
        {
          image: 'https://cdn.example/p1.jpg',
          caption: 'Bridal lehenga border',
          machineType: 'Multi-head',
          workType: 'zari',
        },
      ],
      experience: [
        {
          workshop: 'Surat Embroidery Works',
          role: 'Senior karigar',
          from: new Date('2018-01-01'),
          to: null,
          description: 'Lead on bridal orders.',
        },
      ],
      recommendations: [{ fromUserId, text: 'Excellent finishing.' }],
      rateCard: { dailyWage: 90000, monthly: 2500000 },
      openTo: { work: true, hiring: false, deals: true, customOrders: true },
    });

    const reloaded = await model.findById(doc._id).lean<any>().exec();
    expect(reloaded.skills).toEqual(['zari', 'sequins', 'aari']);
    expect(reloaded.portfolio).toHaveLength(1);
    expect(reloaded.portfolio[0].machineType).toBe('Multi-head');
    expect(reloaded.experience[0].workshop).toBe('Surat Embroidery Works');
    expect(reloaded.experience[0].to).toBeNull();
    expect(reloaded.recommendations[0].fromUserId.toString()).toBe(fromUserId.toString());
    expect(reloaded.recommendations[0].createdAt).toBeInstanceOf(Date);
    expect(reloaded.rateCard.dailyWage).toBe(90000);
    expect(reloaded.rateCard.monthly).toBe(2500000);
    expect(reloaded.openTo.work).toBe(true);
    expect(reloaded.openTo.hiring).toBe(false);
  });

  it('does not give embedded sub-documents their own _id', async () => {
    const doc = await model.create({
      userId: new Types.ObjectId(),
      portfolio: [{ image: 'https://cdn.example/p.jpg' }],
      experience: [{ workshop: 'Workshop A' }],
      recommendations: [{ fromUserId: new Types.ObjectId(), text: 'Great.' }],
    });
    const reloaded = await model.findById(doc._id).lean<any>().exec();
    expect(reloaded.portfolio[0]._id).toBeUndefined();
    expect(reloaded.experience[0]._id).toBeUndefined();
    expect(reloaded.recommendations[0]._id).toBeUndefined();
  });

  it('requires userId', async () => {
    await expect(model.create({})).rejects.toThrow();
  });

  it('requires the image field on a portfolio item', async () => {
    await expect(
      model.create({
        userId: new Types.ObjectId(),
        portfolio: [{ caption: 'no image' } as any],
      }),
    ).rejects.toThrow();
  });

  it('rejects a strength outside 0–100', async () => {
    await expect(model.create({ userId: new Types.ObjectId(), strength: 150 })).rejects.toThrow();
  });

  it('experience accepts an optional companyPageId', () => {
    const model = mongoose.model('ConnectProfileExpCoTest', ConnectProfileSchema);
    const pid = new Types.ObjectId();
    const doc = new model({
      userId: new Types.ObjectId(),
      experience: [{ workshop: 'Patel Embroidery', companyPageId: pid }],
    });
    expect(String(doc.experience[0].companyPageId)).toBe(String(pid));
    const plain = new model({
      userId: new Types.ObjectId(),
      experience: [{ workshop: 'Local unit' }],
    });
    expect(plain.experience[0].companyPageId == null).toBe(true);
  });

  it('defaults services to [] and accepts a service item (title + optional note)', async () => {
    // Mirrors the portfolio default + persistence checks. Services is the new
    // additive "Services I provide" list - each item is a short title plus an
    // optional one-line note.
    const userId = new Types.ObjectId();
    const doc = await model.create({ userId });
    expect(doc.services).toEqual([]);

    const withServices = await model.create({
      userId: new Types.ObjectId(),
      services: [{ title: 'Digitizing', note: 'DST files' }],
    });
    const reloaded = await model.findById(withServices._id).lean<any>().exec();
    expect(reloaded.services).toHaveLength(1);
    expect(reloaded.services[0].title).toBe('Digitizing');
    expect(reloaded.services[0].note).toBe('DST files');
    // Embedded sub-document carries no own _id (_id: false).
    expect(reloaded.services[0]._id).toBeUndefined();
  });

  it('training: confirmStatus accepts every documented value and defaults to self (Institutes Phase 2)', async () => {
    // The four-value confirm enum: self|pending are student-reachable, while
    // confirmed|declined come only from the institute-side write path. The schema
    // must persist all four (the student-side guard lives in the DTO + service,
    // not the schema validator). Default is self for a legacy / brand-new item.
    const userId = new Types.ObjectId();
    const doc = await model.create({
      userId,
      // No confirmStatus -> schema default `self`; shareWithInstitute -> false.
      training: [{ id: new Types.ObjectId().toHexString(), instituteName: 'Surat Stitch Academy' }],
    });
    const reloaded = await model.findById(doc._id).lean<any>().exec();
    expect(reloaded.training[0].confirmStatus).toBe('self');
    expect(reloaded.training[0].shareWithInstitute).toBe(false);
    // confirmedAt / confirmedByUserId default to null (never student-set).
    expect(reloaded.training[0].confirmedAt).toBeNull();
    expect(reloaded.training[0].confirmedByUserId).toBeNull();

    for (const confirmStatus of CONNECT_TRAINING_CONFIRM_STATUSES) {
      const d = await model.create({
        userId: new Types.ObjectId(),
        training: [
          { id: new Types.ObjectId().toHexString(), instituteName: 'Academy', confirmStatus },
        ],
      });
      const r = await model.findById(d._id).lean<any>().exec();
      expect(r.training[0].confirmStatus).toBe(confirmStatus);
    }
  });

  it('training: rejects an unknown confirmStatus value', async () => {
    await expect(
      model.create({
        userId: new Types.ObjectId(),
        training: [
          {
            id: new Types.ObjectId().toHexString(),
            instituteName: 'Academy',
            confirmStatus: 'bogus' as any,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('training: persists and reloads a stable id + the confirm metadata fields', async () => {
    const trainingId = new Types.ObjectId().toHexString();
    const confirmedBy = new Types.ObjectId();
    const confirmedAt = new Date('2026-06-01T00:00:00.000Z');
    const doc = await model.create({
      userId: new Types.ObjectId(),
      training: [
        {
          id: trainingId,
          instituteName: 'Surat Stitch Academy',
          course: 'Computerised Embroidery',
          confirmStatus: 'confirmed',
          confirmedAt,
          confirmedByUserId: confirmedBy,
          shareWithInstitute: true,
        },
      ],
    });
    const reloaded = await model.findById(doc._id).lean<any>().exec();
    expect(reloaded.training[0].id).toBe(trainingId);
    expect(reloaded.training[0].confirmStatus).toBe('confirmed');
    expect(new Date(reloaded.training[0].confirmedAt).toISOString()).toBe(
      confirmedAt.toISOString(),
    );
    expect(reloaded.training[0].confirmedByUserId.toString()).toBe(confirmedBy.toString());
    expect(reloaded.training[0].shareWithInstitute).toBe(true);
    // The embedded credential still carries no own _id (_id: false) — `id` is the
    // server-assigned string handle, distinct from a Mongo subdoc _id.
    expect(reloaded.training[0]._id).toBeUndefined();
  });

  it('training: requires the id field on a credential', async () => {
    await expect(
      model.create({
        userId: new Types.ObjectId(),
        training: [{ instituteName: 'No id academy' } as any],
      }),
    ).rejects.toThrow();
  });

  it('builds the institute alumni/placement index (training.companyPageId + confirmStatus)', async () => {
    const indexes = await model.collection.indexes();
    const byKey = (key: Record<string, number>) =>
      indexes.find((ix: any) => JSON.stringify(ix.key) === JSON.stringify(key));
    expect(byKey({ 'training.companyPageId': 1, 'training.confirmStatus': 1 })).toBeDefined();
  });

  it('defaults openToDetails to an empty object and accepts a detail entry', () => {
    const model = mongoose.model('ConnectProfileA1Test', ConnectProfileSchema);
    const doc = new model({ userId: new Types.ObjectId() });
    // Mongoose materialises the `() => ({})` default as an (empty) sub-document
    // wrapper; its plain projection has no own keys (each intent is optional).
    expect(doc.openToDetails).toBeDefined();
    expect(JSON.parse(JSON.stringify(doc.openToDetails))).toEqual({});
    doc.set('openToDetails', { hiring: { detail: 'Aari karigars', audience: 'network' } });
    expect(doc.openToDetails.hiring?.detail).toBe('Aari karigars');
    expect(doc.openToDetails.hiring?.audience).toBe('network');
  });
});
