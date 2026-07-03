import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IStorageService } from './storage.interface';
import { LocalStorageService } from './local-storage.service';
import { R2StorageService } from './r2-storage.service';
import { isPrivateRef, toPrivateRef } from '../private-media.ref';
import { LOCAL_PRIVATE_DEV_ROUTE } from '../local-private-url';

/**
 * Read-path decorator for PRIVATE media. Turns a stored canonical
 * `r2-private://<key>` ref into a fresh 1-hour signed URL, ONLY at read time.
 *
 * Lives in the lightweight `MediaOwnershipModule` (which every Connect read path
 * already imports) so inbox / jobs can decorate their responses without pulling
 * in the heavier `UploadsService`. Public URLs pass through untouched, so callers
 * can hand it any media value (mixed public + private) and get back something
 * always safe to render.
 *
 * Signing is local crypto (R2 presign) / an HMAC mint (dev) - NO network or DB -
 * so `signMany` batches per response cheaply (the contract: never sign inside a
 * per-item DB loop). Cross-module: consumed by `inbox.service` (message media +
 * voice) and `jobs.service` (resume + apply voice).
 */
@Injectable()
export class PrivateMediaService {
  private readonly logger = new Logger(PrivateMediaService.name);
  private readonly storage: IStorageService;
  /** Host of an R2 presigned URL (`<accountId>.r2.cloudflarestorage.com`). */
  private readonly r2Host: string;
  private readonly privateBucket: string;

  constructor(
    configService: ConfigService,
    localStorageService: LocalStorageService,
    r2StorageService: R2StorageService,
  ) {
    const provider = configService.get<string>('storage.provider');
    this.storage = provider === 'r2' ? r2StorageService : localStorageService;
    const accountId = configService.get<string>('storage.r2.accountId') ?? '';
    this.r2Host = accountId ? `${accountId}.r2.cloudflarestorage.com` : '';
    this.privateBucket = configService.get<string>('storage.r2.privateBucket') ?? '';
  }

  /**
   * Normalise a WRITE-path media value back to its canonical private ref.
   *
   * Why: read paths hand clients a short-lived SIGNED URL. When the client later
   * resubmits that value (e.g. a karigar editing their application without
   * re-uploading), it must collapse back to the SAME stored `r2-private://` ref
   * so ownership-grandfathering matches and we never persist an expiring URL.
   * Idempotent: a canonical ref or a public URL is returned unchanged; only OUR
   * OWN signed private URLs are rewritten. Anything we don't recognise passes
   * through to the normal ownership/host validation (which fails it closed).
   */
  normalizeIncomingRef(value: string | null | undefined): string | null | undefined {
    if (!value || isPrivateRef(value)) return value;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value; // not a URL (and not a ref) - leave for validation to reject
    }
    // Local-dev signed route: the object key rides in `?key=`.
    if (url.pathname.endsWith(LOCAL_PRIVATE_DEV_ROUTE)) {
      const key = url.searchParams.get('key');
      return key ? toPrivateRef(key) : value;
    }
    // R2 presigned URL on our account host. Path is `/<bucket>/<key>` (path-style)
    // or `/<key>` (virtual-hosted); strip a leading bucket segment if present.
    if (this.r2Host && url.host === this.r2Host) {
      const segs = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
      if (this.privateBucket && segs[0] === this.privateBucket) segs.shift();
      const key = segs.join('/');
      return key ? toPrivateRef(key) : value;
    }
    return value;
  }

  /** True when `value` is a private canonical ref (vs a public URL or empty). */
  isPrivateRef(value: string | null | undefined): boolean {
    return isPrivateRef(value);
  }

  /**
   * Decorate a single value: a private ref => fresh signed URL; a public URL or
   * empty value => returned unchanged. Never throws into the caller - a signing
   * failure logs + returns the raw value (the screen degrades, it does not 500).
   */
  async decorate(value: string | null | undefined): Promise<string | null> {
    if (!value) return value ?? null;
    if (!isPrivateRef(value)) return value;
    try {
      return await this.storage.getSignedUrl(value);
    } catch (err) {
      this.logger.error(`Failed to sign private media ref: ${(err as Error)?.message}`);
      return value;
    }
  }

  /**
   * Batch-sign every distinct private ref in `values`, returning a
   * `ref -> signedUrl` map. Public / empty values are ignored (callers keep them
   * as-is). One signed URL per distinct ref even if it appears many times.
   */
  async signMany(values: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
    const refs = [...new Set(values.filter((v): v is string => isPrivateRef(v)))];
    const out = new Map<string, string>();
    await Promise.all(
      refs.map(async (ref) => {
        try {
          out.set(ref, await this.storage.getSignedUrl(ref));
        } catch (err) {
          this.logger.error(`Failed to sign private media ref: ${(err as Error)?.message}`);
        }
      }),
    );
    return out;
  }

  /** Resolve a single value against a prebuilt `signMany` map (public passes through). */
  resolve(value: string | null | undefined, signed: Map<string, string>): string | null {
    if (!value) return value ?? null;
    return signed.get(value) ?? value;
  }
}
