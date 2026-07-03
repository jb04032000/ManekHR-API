import { UploadResponseDto } from '../dto/upload-response.dto';
import type { StorageVisibility } from '../upload-policies';

export interface IStorageService {
  /**
   * Store a file. `visibility` (default `public`, so every legacy 2-arg caller
   * is unchanged) decides the bucket + the returned `url`:
   *  - `public`  → world-readable bucket, permanent public URL.
   *  - `private` → private bucket, a canonical `r2-private://<key>` ref (NEVER a
   *    public URL). Read paths sign it on demand.
   */
  uploadFile(
    file: any,
    category: string,
    visibility?: StorageVisibility,
  ): Promise<UploadResponseDto>;

  /** Delete by public URL OR by a canonical `r2-private://<key>` ref. */
  deleteFile(fileUrlOrRef: string): Promise<void>;

  /**
   * Whether the underlying object still exists in storage, by public URL OR by a
   * canonical `r2-private://<key>` ref. Returns:
   *  - `true`  - the object is present.
   *  - `false` - the object is definitively absent (e.g. R2 HeadObject 404).
   *  - `null`  - indeterminate: the existence could not be decided (the key was
   *    undecodable, the private bucket is unconfigured, or the storage call
   *    errored for a reason OTHER than not-found). Callers (the orphan-reconcile
   *    cron) treat `null` as "skip" so transient errors never read as drift.
   *
   * Used by the storage-orphan reconcile cron (report-only). Not on any hot path.
   */
  objectExists(fileUrlOrRef: string): Promise<boolean | null>;

  /**
   * Mint a short-lived (1-hour) signed GET URL for a private canonical ref.
   * Generated ONLY at read time. Throws if given a non-private value.
   */
  getSignedUrl(privateRef: string): Promise<string>;
}
