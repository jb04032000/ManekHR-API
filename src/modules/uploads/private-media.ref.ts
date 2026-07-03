/**
 * Canonical reference for a PRIVATE media object.
 *
 * Private uploads (chat attachments, job-application files) never get a public
 * URL. Instead the upload response + every stored DB reference + the
 * `UploadEvent.fileUrl` carry this stable, provider-agnostic ref:
 *
 *     r2-private://<objectKey>          e.g.  r2-private://connect-inbox-media/172-ab12.webm
 *
 * The `<objectKey>` is the exact same `<category>/<filename>` key the public
 * adapter uses, so the same object can be migrated between buckets without the
 * key changing. The ref is identical for the R2 and local-dev providers, so DB
 * rows stay portable across environments.
 *
 * Read paths turn this ref into a fresh 1-hour signed URL via `PrivateMediaService`
 * (R2 presigned GET in prod; a token-checked dev route locally). The scheme is
 * recognised by `MediaOwnershipService` (write-path ownership validation) and the
 * storage adapters' delete paths.
 *
 * Cross-module: produced by `r2-storage.service` / `local-storage.service` on a
 * private upload; consumed by `private-media.service`, `media-ownership.service`,
 * `uploads.service` (delete), and `scripts/migrate-private-media.ts`.
 */

/** Scheme prefix for a private canonical ref. */
export const PRIVATE_REF_SCHEME = 'r2-private://';

/** True when `value` is a canonical private ref (not a public http(s) URL). */
export function isPrivateRef(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(PRIVATE_REF_SCHEME);
}

/** Build a canonical private ref from a storage object key (`<category>/<file>`). */
export function toPrivateRef(objectKey: string): string {
  return `${PRIVATE_REF_SCHEME}${objectKey}`;
}

/**
 * Extract the object key from a canonical private ref. Returns null when the
 * value is not a private ref (callers should guard with `isPrivateRef` first
 * when they expect one).
 */
export function privateRefToKey(ref: string): string | null {
  if (!isPrivateRef(ref)) return null;
  return ref.slice(PRIVATE_REF_SCHEME.length);
}
