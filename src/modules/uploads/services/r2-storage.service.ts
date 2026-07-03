import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as path from 'path';
import { IStorageService } from './storage.interface';
import { UploadResponseDto } from '../dto/upload-response.dto';
import type { StorageVisibility } from '../upload-policies';
import { isPrivateRef, privateRefToKey, toPrivateRef } from '../private-media.ref';

/** Signed private GET URLs live for one hour, minted only at read time. */
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Cache-Control written onto each upload at PutObject time. Filenames are unique
 * by construction (`{category}/{timestamp}-{random}.{ext}`) so an object is
 * immutable -> we can cache it forever and skip revalidation. This is what lets
 * the CDN + browser keep an image across visits instead of re-downloading it.
 *
 *  - PUBLIC: one year + `immutable` (the unique-name guarantee makes this safe).
 *  - PRIVATE: only 1h, matching the signed-URL TTL above so a cached copy never
 *    outlives the signature that authorised it. `private` keeps shared caches /
 *    the CDN from storing it at all.
 *
 * NOTE: this header lands on NEW uploads only. Objects written before this
 * change keep their old (absent) header; a one-off backfill could re-PUT them
 * with the new Cache-Control, but because names are immutable it only affects
 * already-uploaded files and is not worth building. See the task report.
 */
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PRIVATE_CACHE_CONTROL = `private, max-age=${SIGNED_URL_TTL_SECONDS}`;

@Injectable()
export class R2StorageService implements IStorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Second, NON-public bucket for private media. Empty => private uploads fail. */
  private readonly privateBucket: string;
  private readonly publicUrl: string;

  constructor(private configService: ConfigService) {
    const accountId = this.configService.get<string>('storage.r2.accountId');
    this.bucket = this.configService.get<string>('storage.r2.bucket');
    this.privateBucket = this.configService.get<string>('storage.r2.privateBucket') ?? '';
    this.publicUrl = this.configService.get<string>('storage.r2.publicUrl');

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.configService.get<string>('storage.r2.accessKeyId'),
        secretAccessKey: this.configService.get<string>('storage.r2.secretAccessKey'),
      },
    });
  }

  async uploadFile(
    file: any,
    category: string,
    visibility: StorageVisibility = 'public',
  ): Promise<UploadResponseDto> {
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(file.originalname);
    const fileName = `${timestamp}-${randomStr}${ext}`;
    const key = `${category}/${fileName}`;

    const isPrivate = visibility === 'private';
    if (isPrivate && !this.privateBucket) {
      // Hard fail — never silently fall back to the world-readable public bucket
      // for content the policy marked private. The owner must set R2_PRIVATE_BUCKET_NAME.
      throw new InternalServerErrorException(
        'Private storage is not configured (R2_PRIVATE_BUCKET_NAME is unset). Refusing to store private media on the public bucket.',
      );
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: isPrivate ? this.privateBucket : this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentLength: file.size,
        // Long-lived immutable caching for public objects (unique names);
        // short, private caching for signed private media. See constants above.
        CacheControl: isPrivate ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL,
      }),
    );

    // Private => stable canonical ref (signed at read time); public => permanent URL.
    const url = isPrivate ? toPrivateRef(key) : `${this.publicUrl.replace(/\/$/, '')}/${key}`;

    return {
      url,
      fileName,
      fileSize: file.size,
      mimeType: file.mimetype,
    };
  }

  async deleteFile(fileUrlOrRef: string): Promise<void> {
    try {
      // Private canonical ref => delete from the private bucket by its key.
      if (isPrivateRef(fileUrlOrRef)) {
        const key = privateRefToKey(fileUrlOrRef);
        if (!key || !this.privateBucket) return;
        await this.client.send(new DeleteObjectCommand({ Bucket: this.privateBucket, Key: key }));
        return;
      }

      // Public URL => strip the public base to recover the key.
      const base = this.publicUrl.replace(/\/$/, '');
      const key = fileUrlOrRef.replace(`${base}/`, '');
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // Tolerate an already-removed object so a delete never throws, but log it:
      // a real R2 outage / permission error would otherwise vanish here. Last
      // path segment only -- never the full URL, no PII.
      const hint = fileUrlOrRef.split('/').pop() || fileUrlOrRef.slice(-32);
      this.logger.warn(
        `R2 deleteFile tolerated for "${hint}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * HeadObject existence probe for the orphan-reconcile cron (report-only).
   * Resolves the bucket + key the same way deleteFile does. A 404 / NotFound
   * means definitively absent (false); any other error -> null (indeterminate,
   * the cron skips it) so a transient R2 blip never reads as drift.
   */
  async objectExists(fileUrlOrRef: string): Promise<boolean | null> {
    let bucket: string;
    let key: string | null;
    if (isPrivateRef(fileUrlOrRef)) {
      bucket = this.privateBucket;
      key = privateRefToKey(fileUrlOrRef);
      if (!key || !this.privateBucket) return null; // can't decide without the private bucket
    } else {
      const base = this.publicUrl.replace(/\/$/, '');
      bucket = this.bucket;
      key = fileUrlOrRef.replace(`${base}/`, '');
    }
    if (!key) return null;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } })?.name ?? '';
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (code === 'NotFound' || code === 'NoSuchKey' || status === 404) return false;
      // Any other error (auth, network, throttle) -> indeterminate, do not report.
      this.logger.warn(
        `R2 objectExists indeterminate for "${key.split('/').pop() ?? key}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Presigned GET (1h) for a private ref. Local crypto on the SDK side; no network. */
  async getSignedUrl(privateRef: string): Promise<string> {
    const key = privateRefToKey(privateRef);
    if (!key) {
      throw new InternalServerErrorException('Cannot sign a non-private storage reference.');
    }
    if (!this.privateBucket) {
      throw new InternalServerErrorException(
        'Private storage is not configured (R2_PRIVATE_BUCKET_NAME is unset).',
      );
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.privateBucket, Key: key }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
  }
}
