/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the cron: it transitively imports the
// UploadEvent schema + UploadsService, whose @Prop-decorated fields would
// otherwise trip vitest's reflect-metadata pipeline (see CLAUDE.md test notes).
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { StorageOrphanReconcileCron, classifyDrift } from '../storage-orphan-reconcile.cron';

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

describe('classifyDrift', () => {
  it('live record + present object -> ok', () => {
    expect(classifyDrift(false, true)).toBe('ok');
  });
  it('live record + missing object -> missing (dead reference)', () => {
    expect(classifyDrift(false, false)).toBe('missing');
  });
  it('deleted record + lingering object -> lingering (untracked storage)', () => {
    expect(classifyDrift(true, true)).toBe('lingering');
  });
  it('deleted record + gone object -> ok', () => {
    expect(classifyDrift(true, false)).toBe('ok');
  });
  it('indeterminate existence -> skip (never reported as drift)', () => {
    expect(classifyDrift(false, null)).toBe('skip');
    expect(classifyDrift(true, null)).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// tick() — report-only drift pass over a mocked UploadEvent corpus
// ---------------------------------------------------------------------------

function chain(result: unknown) {
  const c: any = {
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    select: vi.fn(() => c),
    lean: vi.fn(() => c),
    exec: vi.fn().mockResolvedValue(result),
  };
  return c;
}

describe('StorageOrphanReconcileCron.tick (report-only)', () => {
  it('counts missing (live+gone) and lingering (deleted+present), skips indeterminate, never deletes', async () => {
    const live = [
      { fileUrl: 'connect-feed/live-present.jpg', deletedAt: null },
      { fileUrl: 'connect-feed/live-missing.jpg', deletedAt: null },
      { fileUrl: 'connect-feed/live-unknown.jpg', deletedAt: null },
    ];
    const deleted = [
      { fileUrl: 'connect-feed/del-gone.jpg', deletedAt: new Date() },
      { fileUrl: 'connect-feed/del-lingering.jpg', deletedAt: new Date() },
    ];

    const uploadEventModel = {
      // The two buckets are distinguished by the filter on deletedAt.
      find: vi.fn((filter: any) => chain(filter.deletedAt === null ? live : deleted)),
    };

    const existence: Record<string, boolean | null> = {
      'connect-feed/live-present.jpg': true,
      'connect-feed/live-missing.jpg': false,
      'connect-feed/live-unknown.jpg': null,
      'connect-feed/del-gone.jpg': false,
      'connect-feed/del-lingering.jpg': true,
    };
    const uploads = {
      objectExists: vi.fn((url: string) => Promise.resolve(existence[url] ?? null)),
    };
    const mockPosthog = { capture: vi.fn() };

    const cron = new StorageOrphanReconcileCron(
      uploadEventModel as any,
      uploads as any,
      { runExclusive: vi.fn() } as any,
      mockPosthog as any,
    );

    const summary = await cron.tick();

    expect(summary.liveChecked).toBe(3);
    expect(summary.deletedChecked).toBe(2);
    expect(summary.missing).toBe(1); // live-missing
    expect(summary.lingering).toBe(1); // del-lingering
    expect(summary.indeterminate).toBe(1); // live-unknown
    expect(summary.missingHints).toContain('live-missing.jpg');
    expect(summary.lingeringHints).toContain('del-lingering.jpg');

    // Report-only: a metric is emitted, no delete path is ever invoked.
    const evt = mockPosthog.capture.mock.calls.find(
      (c: any) => c[0].event === 'uploads.orphan_reconcile_ran',
    );
    expect(evt).toBeTruthy();
    expect(evt[0].properties.missing).toBe(1);
  });

  it('treats a probe error as indeterminate (never reports it as drift)', async () => {
    const live = [{ fileUrl: 'connect-feed/x.jpg', deletedAt: null }];
    const uploadEventModel = {
      find: vi.fn((filter: any) => chain(filter.deletedAt === null ? live : [])),
    };
    const uploads = {
      objectExists: vi.fn(() => Promise.reject(new Error('R2 down'))),
    };

    const cron = new StorageOrphanReconcileCron(
      uploadEventModel as any,
      uploads as any,
      { runExclusive: vi.fn() } as any,
      undefined,
    );

    const summary = await cron.tick();
    expect(summary.missing).toBe(0);
    expect(summary.indeterminate).toBe(1);
  });
});
