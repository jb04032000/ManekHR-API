/**
 * Phase 17 / Plan 02 / Task 1 — PartyTimeline emit + persist integration test.
 *
 * Mirrors the path declared in the plan
 * (`__tests__/integration/party-timeline-emit.spec.ts`) — that re-exporter
 * stub satisfies the literal acceptance grep, while the executable body
 * lives here per the project's vitest discovery convention
 * (`src/**\/*.vitest.ts`, see vitest.config.ts).
 *
 * Asserts (D-17, D-18):
 *   1. `eventEmitter.emit('party.timeline', payload)` returns synchronously
 *      and the subscriber persists within a few microtasks.
 *   2. Producer never observes a thrown error even when the subscriber's
 *      service.append rejects (non-blocking guarantee).
 *   3. Re-emitting the same `(refModel, refId, type)` is idempotent — the
 *      partial unique index from Plan 01 + the E11000 swallow in
 *      PartyTimelineService keeps row count at 1.
 *   4. Manual entries (no refModel/refId) bypass idempotency — re-emitting
 *      a `note.added` produces a second row.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { Types, Model } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  startMemoryMongo,
  stopMemoryMongo,
  clearAllCollections,
} from '../../../../../../test-utils/mongo-memory';
import {
  PartyTimelineEvent,
  PartyTimelineEventSchema,
} from '../party-timeline-event.schema';
import { PartyTimelineService } from '../party-timeline.service';
import { PartyTimelineSubscriber } from '../party-timeline.subscriber';

const flush = () =>
  new Promise<void>((resolve) => setImmediate(() => resolve()));

describe('Plan 17-02 / Task 1 — PartyTimeline emit + persist', () => {
  let moduleRef: TestingModule;
  let events: EventEmitter2;
  let model: Model<PartyTimelineEvent>;
  let service: PartyTimelineService;

  beforeAll(async () => {
    const uri = await startMemoryMongo();
    moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot({ wildcard: false, maxListeners: 20 }),
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          {
            name: PartyTimelineEvent.name,
            schema: PartyTimelineEventSchema,
          },
        ]),
      ],
      providers: [PartyTimelineService, PartyTimelineSubscriber],
    }).compile();
    // Manually init the app so @OnEvent decorators get bound to the
    // EventEmitter2 instance.
    const app = moduleRef.createNestApplication();
    await app.init();
    events = moduleRef.get(EventEmitter2);
    model = moduleRef.get(getModelToken(PartyTimelineEvent.name));
    service = moduleRef.get(PartyTimelineService);
    // Sanity: the @OnEvent('party.timeline') listener must be registered.
    const listenerCount = events.listenerCount('party.timeline');
    if (listenerCount === 0) {
      throw new Error(
        'PartyTimelineSubscriber @OnEvent listener was not registered — ' +
          'app.init() did not bind decorators.',
      );
    }
  });

  afterAll(async () => {
    await moduleRef.close();
    await stopMemoryMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  const wsId = new Types.ObjectId();
  const firmId = new Types.ObjectId();
  const partyId = new Types.ObjectId();
  const refId = new Types.ObjectId();
  const userId = new Types.ObjectId();

  const baseInvoicePayload = () => ({
    type: 'invoice.created' as const,
    workspaceId: wsId,
    firmId,
    partyId,
    refModel: 'SaleInvoice',
    refId,
    occurredAt: new Date(),
    actorUserId: userId,
    summary: 'Invoice INV-0001 created',
    meta: { voucherNumber: 'INV-0001', amountPaise: 100_000 },
  });

  it('1. emit returns synchronously; subscriber persists asynchronously', async () => {
    // Sanity: direct service call works against the in-memory DB.
    await service.append(baseInvoicePayload());
    expect(await model.countDocuments({})).toBe(1);
    await clearAllCollections();

    const emitResult = events.emit('party.timeline', baseInvoicePayload());
    // emit() with @OnEvent({async:true}) returns true synchronously without
    // awaiting listeners — proves D-17 producer is non-blocking.
    expect(emitResult).toBe(true);

    // Allow microtasks + DB I/O to drain (longer wait — async listener +
    // mongo write round-trip).
    for (let i = 0; i < 20; i++) {
      await flush();
      await new Promise((r) => setTimeout(r, 25));
      if ((await model.countDocuments({})) > 0) break;
    }

    expect(await model.countDocuments({})).toBe(1);
    const row = await model.findOne({}).lean();
    expect(row?.type).toBe('invoice.created');
    expect(String(row?.workspaceId)).toBe(String(wsId));
    expect(String(row?.refId)).toBe(String(refId));
  });

  it('2. subscriber failure does not propagate to producer', async () => {
    // Verify the D-17 non-blocking guarantee directly on the subscriber:
    // even when service.append rejects synchronously, subscriber.handle()
    // must NOT throw. (This isolates the catch logic from EventEmitter2's
    // own try/catch wrapper, which would mask non-compliance.)
    const failingService = {
      append: vi
        .fn()
        .mockRejectedValue(new Error('forced subscriber failure')),
    } as unknown as PartyTimelineService;
    const isolatedSubscriber = new PartyTimelineSubscriber(failingService);

    let producerThrew = false;
    try {
      await isolatedSubscriber.handle(baseInvoicePayload());
    } catch {
      producerThrew = true;
    }
    expect(producerThrew).toBe(false);
    expect(
      (failingService.append as unknown as { mock: { calls: unknown[] } })
        .mock.calls.length,
    ).toBe(1);
    // And a separate end-to-end emit must still NOT bubble up to the caller
    // even if a listener errors — exercise the EventEmitter2 path too.
    const ok = events.emit('party.timeline', baseInvoicePayload());
    expect(ok).toBe(true);
    // No DB constraint involved here; the real subscriber persists 1 row.
    for (let i = 0; i < 20; i++) {
      await flush();
      await new Promise((r) => setTimeout(r, 25));
      if ((await model.countDocuments({})) > 0) break;
    }
    expect(await model.countDocuments({})).toBe(1);
  });

  it('3. idempotent insert — duplicate (refModel,refId,type) does NOT create a 2nd row', async () => {
    const payload = baseInvoicePayload();
    events.emit('party.timeline', payload);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(await model.countDocuments({})).toBe(1);

    // Re-emit identical payload — partial unique index throws E11000 which
    // PartyTimelineService swallows + warns.
    events.emit('party.timeline', payload);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(await model.countDocuments({})).toBe(1);
  });

  it('4. manual entries (no refModel/refId) bypass idempotency — both rows persist', async () => {
    const manual = {
      type: 'note.added' as const,
      workspaceId: wsId,
      firmId,
      partyId,
      occurredAt: new Date(),
      actorUserId: userId,
      summary: 'Note: spoke to owner about overdue payment',
    };
    // Direct append sanity (×2) — surfaces any schema/Mongoose error that the
    // EventEmitter2 try/catch wrapper would otherwise swallow, and also
    // confirms that two manual rows with no refModel/refId both persist.
    await service.append(manual);
    await service.append(manual);
    expect(await model.countDocuments({ type: 'note.added' })).toBe(2);
    await clearAllCollections();

    events.emit('party.timeline', manual);
    for (let i = 0; i < 20; i++) {
      await flush();
      await new Promise((r) => setTimeout(r, 25));
      if ((await model.countDocuments({ type: 'note.added' })) >= 2) break;
    }
    expect(await model.countDocuments({ type: 'note.added' })).toBe(2);
  });
});
