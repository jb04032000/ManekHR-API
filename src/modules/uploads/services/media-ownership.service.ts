import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UploadEvent } from '../schemas/upload-event.schema';
import { isPrivateRef } from '../private-media.ref';

/**
 * Shared media-URL ownership guard. Single source of truth for "may this user
 * attach this file?" across every Connect write path (feed posts, marketplace
 * listings, company pages, storefronts, profile, jobs, RFQ quotes, inbox).
 *
 * For each submitted URL it verifies, in order:
 *  1. The string parses as a real URL.
 *  2. Its origin matches one of OUR storage public origins (derived from the
 *     same config the R2 storage adapter builds public URLs from -
 *     `storage.r2.publicUrl`; the local-dev `http://localhost:PORT` base is
 *     also accepted when the provider is not R2). This rejects offsite https,
 *     plain http, and `javascript:` / `data:` URIs in one check, because none
 *     of those share our origin.
 *  3. An `UploadEvent` ownership record exists with `fileUrl = url`,
 *     `uploaderUserId = userId`, `deletedAt = null` - i.e. this user actually
 *     uploaded it and has not deleted it.
 *
 * The ownership lookup is BATCHED: one `$in` query for all URLs, never N.
 *
 * Grandfathering (UPDATE paths): URLs already persisted on the entity being
 * edited predate ownership tracking, so they are exempt from check 3 (they were
 * accepted before - keep them). Pass them via `options.grandfatheredUrls`.
 * Checks 1 + 2 (format/host) still apply to every URL.
 *
 * Errors name the offending URL's INDEX, never the URL itself, to avoid log
 * injection from attacker-controlled strings.
 *
 * Lives in the uploads module (owner of `UploadEvent`) and is exported via the
 * self-contained `MediaOwnershipModule` so Connect modules can depend on it
 * without pulling in the heavier `UploadsService` (and its allowance cycle).
 */
@Injectable()
export class MediaOwnershipService {
  private cachedOrigins: string[] | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UploadEvent.name)
    private readonly uploadEventModel: Model<UploadEvent>,
  ) {}

  /**
   * Assert that every non-empty URL in `urls` is a valid file on our storage
   * AND (unless grandfathered) owned by `userId`. Throws `BadRequestException`
   * naming the offending index on the first violation. Empty / null / undefined
   * slots are treated as "no media" and skipped. Resolves silently when there
   * is nothing to check.
   *
   * @param urls   The client-submitted URLs (a flat list; callers flatten
   *               nested shapes like `media[].url` before passing).
   * @param userId The authenticated uploader (JWT subject).
   * @param options.grandfatheredUrls URLs already stored on the entity being
   *               updated - exempt from the ownership-record check only.
   */
  async assertOwnedMedia(
    urls: ReadonlyArray<string | null | undefined>,
    userId: string | Types.ObjectId,
    options?: { grandfatheredUrls?: ReadonlyArray<string | null | undefined> },
  ): Promise<void> {
    const allowedOrigins = this.getAllowedOrigins();
    const grandfathered = new Set(
      (options?.grandfatheredUrls ?? []).filter((u): u is string => !!u),
    );

    // Pass 1 - format + host for EVERY non-empty URL (grandfathered included);
    // collect the not-grandfathered ones that still need an ownership record.
    const toVerify: string[] = [];
    urls.forEach((raw, index) => {
      if (!raw) return; // empty slot = no media
      if (!this.isOnOurStorage(raw, allowedOrigins)) {
        throw new BadRequestException(
          `Media at position ${index} is not a valid file on our storage.`,
        );
      }
      if (!grandfathered.has(raw)) toVerify.push(raw);
    });

    if (toVerify.length === 0) return;

    // Pass 2 - ONE batched ownership lookup for all new URLs.
    const owned = await this.uploadEventModel
      .find({
        fileUrl: { $in: [...new Set(toVerify)] },
        uploaderUserId: this.toObjectId(userId),
        deletedAt: null,
      })
      .select('fileUrl')
      .lean()
      .exec();
    const ownedSet = new Set((owned as Array<{ fileUrl: string }>).map((r) => r.fileUrl));

    // Report the first not-grandfathered, not-owned URL by index.
    const offender = urls.findIndex((u) => !!u && !grandfathered.has(u) && !ownedSet.has(u));
    if (offender >= 0) {
      throw new BadRequestException(`Media at position ${offender} was not uploaded by you.`);
    }
  }

  /**
   * Validate a single optional URL (e.g. a banner / logo / cover image).
   * Thin wrapper over `assertOwnedMedia` for the common scalar case.
   */
  async assertOwnedSingle(
    url: string | null | undefined,
    userId: string | Types.ObjectId,
    options?: { grandfatheredUrls?: ReadonlyArray<string | null | undefined> },
  ): Promise<void> {
    await this.assertOwnedMedia([url], userId, options);
  }

  /**
   * Server-parsed audio duration (whole seconds) for an owned audio upload,
   * looked up by URL. Returns `null` when there is no owned, live record or the
   * row predates audio probing.
   *
   * Feed posts + inbox voice notes use this to OVERRIDE the client-claimed
   * `durationSec` so a forged value can never be persisted -- the upload path
   * (`uploads.service` `logUploadEvent`) wrote the real probed duration onto the
   * `UploadEvent` at upload time. Keep in step with the `audioDurationSec`
   * field written there.
   */
  async getServerAudioDurationByUrl(
    url: string | null | undefined,
    userId: string | Types.ObjectId,
  ): Promise<number | null> {
    if (!url) return null;
    const rec = await this.uploadEventModel
      .findOne({ fileUrl: url, uploaderUserId: this.toObjectId(userId), deletedAt: null })
      .select('audioDurationSec')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    const d = (rec as { audioDurationSec?: number | null } | null)?.audioDurationSec;
    // Persist whole seconds — the client-facing duration is an integer second
    // count, and rounding the float probe keeps the player + DTO contract clean.
    return typeof d === 'number' && Number.isFinite(d) ? Math.round(d) : null;
  }

  /**
   * Server-parsed VIDEO duration (whole seconds) for an owned video upload,
   * looked up by URL. Mirror of `getServerAudioDurationByUrl` for the feed video
   * path: `feed.service` copies this onto the post `media[]` item so the stored
   * duration is the one `media-probe` read at upload time, never a client claim.
   * Returns `null` when there is no owned, live record or the row predates video
   * probing. Keep in step with the `videoDurationSec` field written by
   * `uploads.service` `logUploadEvent`.
   */
  async getServerVideoDurationByUrl(
    url: string | null | undefined,
    userId: string | Types.ObjectId,
  ): Promise<number | null> {
    if (!url) return null;
    const rec = await this.uploadEventModel
      .findOne({ fileUrl: url, uploaderUserId: this.toObjectId(userId), deletedAt: null })
      .select('videoDurationSec')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    const d = (rec as { videoDurationSec?: number | null } | null)?.videoDurationSec;
    return typeof d === 'number' && Number.isFinite(d) ? Math.round(d) : null;
  }

  /** Parse + origin check. Non-http(s) schemes have no matching origin, so they fail here too. */
  private isOnOurStorage(url: string, allowedOrigins: string[]): boolean {
    // Private canonical refs (`r2-private://<key>`) ARE our storage - they are
    // what a private upload returns and what the client submits back on a
    // message / job-application write. Ownership is still proven by the
    // UploadEvent record lookup below (the ref is the UploadEvent.fileUrl).
    if (isPrivateRef(url)) return true;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return allowedOrigins.includes(parsed.origin);
  }

  /**
   * Our storage public origin(s), memoised (config is static at runtime).
   * Primary source is `storage.r2.publicUrl` - the exact base the R2 adapter
   * prefixes onto every uploaded key. The local-dev base is added only when the
   * active provider is not R2, so production stays https-only.
   */
  private getAllowedOrigins(): string[] {
    if (this.cachedOrigins) return this.cachedOrigins;
    const origins = new Set<string>();
    this.addOrigin(origins, this.configService.get<string>('storage.r2.publicUrl'));
    if (this.configService.get<string>('storage.provider') !== 'r2') {
      const port = this.configService.get<number>('PORT') ?? 3000;
      this.addOrigin(origins, `http://localhost:${port}`);
    }
    this.cachedOrigins = [...origins];
    return this.cachedOrigins;
  }

  private addOrigin(set: Set<string>, base: string | undefined | null): void {
    if (!base) return;
    try {
      set.add(new URL(base).origin);
    } catch {
      // Malformed config base - ignore (it simply contributes no allowed origin).
    }
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id));
  }
}
