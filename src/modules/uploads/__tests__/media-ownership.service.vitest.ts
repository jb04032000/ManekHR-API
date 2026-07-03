/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

// Stub @nestjs/mongoose decorators BEFORE importing the schema/service so the
// transitive schema decorations don't trip vitest's reflect-metadata pipeline.
// Mirrors the uploads / team / auth unit suites in this codebase.
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

import { Types } from 'mongoose';
import { MediaOwnershipService } from '../services/media-ownership.service';

const HOST = 'https://cdn.zari360.test';

describe('MediaOwnershipService', () => {
  let configService: any;
  let uploadEventModel: any;
  let svc: MediaOwnershipService;

  const userId = new Types.ObjectId().toHexString();

  /** A `find().select().lean().exec()` chain resolving to `rows`, with a spy on `find`. */
  const mockFind = (rows: Array<{ fileUrl: string }>) => {
    const exec = vi.fn().mockResolvedValue(rows);
    const lean = vi.fn().mockReturnValue({ exec });
    const select = vi.fn().mockReturnValue({ lean });
    uploadEventModel.find = vi.fn().mockReturnValue({ select });
    return uploadEventModel.find;
  };

  beforeEach(() => {
    configService = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'storage.provider') return 'r2';
        if (key === 'storage.r2.publicUrl') return HOST;
        return undefined;
      }),
    };
    uploadEventModel = { find: vi.fn() };
    svc = new MediaOwnershipService(configService, uploadEventModel);
  });

  // ── CREATE: every url requires an owned record ────────────────────────────

  it('accepts a url the user uploaded themselves', async () => {
    mockFind([{ fileUrl: `${HOST}/connect-posts/own.jpg` }]);

    await expect(
      svc.assertOwnedMedia([`${HOST}/connect-posts/own.jpg`], userId),
    ).resolves.toBeUndefined();
  });

  it("rejects another user's file (on our host but no owned record)", async () => {
    mockFind([]); // no record for THIS user

    await expect(
      svc.assertOwnedMedia([`${HOST}/connect-posts/theirs.jpg`], userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an offsite https url before any db lookup', async () => {
    const find = mockFind([]);

    await expect(
      svc.assertOwnedMedia(['https://evil.example.com/x.jpg'], userId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a plain http url on our host (not https)', async () => {
    const find = mockFind([]);

    await expect(
      svc.assertOwnedMedia(['http://cdn.zari360.test/connect-posts/x.jpg'], userId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a javascript: pseudo-url', async () => {
    const find = mockFind([]);

    await expect(svc.assertOwnedMedia(['javascript:alert(1)'], userId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a data: uri', async () => {
    await expect(
      svc.assertOwnedMedia(['data:image/png;base64,AAAA'], userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('names the offending index, never the raw url (log-injection safety)', async () => {
    mockFind([{ fileUrl: `${HOST}/a.jpg` }]); // index 0 owned, index 1 offsite
    try {
      await svc.assertOwnedMedia([`${HOST}/a.jpg`, 'https://evil.test/b.jpg'], userId);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('position 1');
      expect(err.message).not.toContain('evil.test');
    }
  });

  // ── UPDATE: grandfathering ────────────────────────────────────────────────

  it('update keeping legacy urls + adding one new owned url -> ok', async () => {
    const legacy = `${HOST}/legacy/old1.jpg`; // no ownership record (predates tracking)
    const added = `${HOST}/connect-posts/new.jpg`; // freshly uploaded, owned
    mockFind([{ fileUrl: added }]); // only the new one returns a record

    await expect(
      svc.assertOwnedMedia([legacy, added], userId, { grandfatheredUrls: [legacy] }),
    ).resolves.toBeUndefined();
  });

  it('update adding a new url with no owned record -> rejected', async () => {
    const legacy = `${HOST}/legacy/old1.jpg`;
    const added = `${HOST}/connect-posts/unowned.jpg`;
    mockFind([]); // new one has no record

    await expect(
      svc.assertOwnedMedia([legacy, added], userId, { grandfatheredUrls: [legacy] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still host-validates grandfathered urls (offsite legacy is rejected)', async () => {
    const offsiteLegacy = 'https://evil.test/old.jpg';
    mockFind([]);

    await expect(
      svc.assertOwnedMedia([offsiteLegacy], userId, { grandfatheredUrls: [offsiteLegacy] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only the grandfathered url is exempt - a NEW url still needs ownership even when others are grandfathered', async () => {
    const legacy = `${HOST}/legacy/old.jpg`;
    const added = `${HOST}/connect-posts/new.jpg`;
    mockFind([]); // added has no record
    await expect(
      svc.assertOwnedMedia([legacy, added], userId, { grandfatheredUrls: [legacy] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Batching ──────────────────────────────────────────────────────────────

  it('batches: 8 urls -> exactly ONE ownership lookup query', async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `${HOST}/connect-posts/f${i}.jpg`);
    const find = mockFind(urls.map((fileUrl) => ({ fileUrl })));

    await svc.assertOwnedMedia(urls, userId);

    expect(find).toHaveBeenCalledTimes(1);
    const query = find.mock.calls[0][0];
    expect(query.fileUrl.$in).toHaveLength(8);
    expect(query.deletedAt).toBeNull();
    expect(String(query.uploaderUserId)).toBe(userId);
  });

  // ── Empty / no-op ───────────────────────────────────────────────────────────

  it('is a no-op (no query) when there are no media urls', async () => {
    const find = mockFind([]);
    await expect(svc.assertOwnedMedia([], userId)).resolves.toBeUndefined();
    await expect(svc.assertOwnedMedia([undefined, null, ''], userId)).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('is a no-op when every url is grandfathered (no ownership lookup)', async () => {
    const legacy = `${HOST}/legacy/old.jpg`;
    const find = mockFind([]);

    await svc.assertOwnedMedia([legacy], userId, { grandfatheredUrls: [legacy] });

    expect(find).not.toHaveBeenCalled();
  });

  // ── Private canonical refs (chat + job-application files) ────────────────────

  it('accepts a private ref the user owns (ownership record on the ref)', async () => {
    const ref = 'r2-private://connect-inbox-media/own.webm';
    mockFind([{ fileUrl: ref }]);
    await expect(svc.assertOwnedMedia([ref], userId)).resolves.toBeUndefined();
  });

  it("rejects another user's private ref (valid scheme, no owned record)", async () => {
    const ref = 'r2-private://connect-inbox-media/theirs.webm';
    mockFind([]); // no record for THIS user
    await expect(svc.assertOwnedMedia([ref], userId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('host-validates a private ref by SCHEME, never by origin (a fake ref still needs a record)', async () => {
    // The ref passes the format/host gate (scheme is ours) but ownership is the
    // real authority - without a record it is rejected, never silently trusted.
    const find = mockFind([]);
    await expect(
      svc.assertOwnedMedia(['r2-private://connect-job-resume/x.pdf'], userId),
    ).rejects.toBeInstanceOf(BadRequestException);
    // it DID reach the ownership lookup (unlike an offsite https url)
    expect(find).toHaveBeenCalledTimes(1);
  });

  // ── Scalar wrapper ──────────────────────────────────────────────────────────

  it('assertOwnedSingle accepts an owned banner and rejects an offsite one', async () => {
    mockFind([{ fileUrl: `${HOST}/connect-banners/b.jpg` }]);
    await expect(
      svc.assertOwnedSingle(`${HOST}/connect-banners/b.jpg`, userId),
    ).resolves.toBeUndefined();

    mockFind([]);
    await expect(svc.assertOwnedSingle('https://evil.test/b.jpg', userId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('assertOwnedSingle is a no-op for an undefined value', async () => {
    const find = mockFind([]);
    await expect(svc.assertOwnedSingle(undefined, userId)).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  // ── Server-parsed audio duration (override of client claim) ──────────────────

  /** A `findOne().select().sort().lean().exec()` chain resolving to `row`. */
  const mockFindOne = (row: any) => {
    const exec = vi.fn().mockResolvedValue(row);
    const lean = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ sort });
    uploadEventModel.findOne = vi.fn().mockReturnValue({ select });
    return uploadEventModel.findOne;
  };

  it('returns the SERVER-parsed duration (not the client claim) for an owned clip', async () => {
    // The upload record carries the probed duration (170s); a client claiming
    // 600s is irrelevant - the resolver returns the stored 170.
    const url = `${HOST}/connect-audio/clip.webm`;
    mockFindOne({ audioDurationSec: 170 });
    await expect(svc.getServerAudioDurationByUrl(url, userId)).resolves.toBe(170);
  });

  it('rounds a fractional probed duration to whole seconds', async () => {
    mockFindOne({ audioDurationSec: 170.6 });
    await expect(
      svc.getServerAudioDurationByUrl(`${HOST}/connect-audio/clip.webm`, userId),
    ).resolves.toBe(171);
  });

  it('returns null for a grandfathered clip with no probed duration on file', async () => {
    mockFindOne({ audioDurationSec: null });
    await expect(
      svc.getServerAudioDurationByUrl(`${HOST}/connect-audio/legacy.webm`, userId),
    ).resolves.toBeNull();
  });

  it('returns null (no query) for an empty url', async () => {
    const findOne = mockFindOne(null);
    await expect(svc.getServerAudioDurationByUrl(undefined, userId)).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});
