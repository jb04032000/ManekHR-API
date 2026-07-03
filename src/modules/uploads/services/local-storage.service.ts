import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IStorageService } from './storage.interface';
import { UploadResponseDto } from '../dto/upload-response.dto';
import type { StorageVisibility } from '../upload-policies';
import { isPrivateRef, privateRefToKey, toPrivateRef } from '../private-media.ref';
import { signLocalPrivateKey, LOCAL_PRIVATE_DEV_ROUTE } from '../local-private-url';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

/**
 * Dev / no-R2 storage. Public files go under `uploadsDir` (served by ServeStatic
 * at /uploads); PRIVATE files go under `privateUploadsDir` (NOT statically served)
 * and are reachable only through the token-checked dev route in
 * `UploadsPrivateDevController`. The private path mirrors R2: the same canonical
 * `r2-private://<key>` ref is stored, so DB rows are portable to prod.
 */
@Injectable()
export class LocalStorageService implements IStorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly uploadsDir: string;
  private readonly privateUploadsDir: string;
  private readonly devSecret: string;
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.uploadsDir = this.configService.get<string>('storage.uploadsDir');
    this.privateUploadsDir = this.configService.get<string>('storage.privateUploadsDir');
    this.devSecret = this.configService.get<string>('storage.privateUrlDevSecret');
    const port = this.configService.get<number>('PORT') || 3000;
    this.baseUrl = `http://localhost:${port}`;
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

    const rootDir = isPrivate ? this.privateUploadsDir : this.uploadsDir;
    const categoryDir = path.join(rootDir, category);
    await mkdir(categoryDir, { recursive: true });
    await writeFile(path.join(categoryDir, fileName), file.buffer);

    // Private => canonical ref (signed at read time); public => static URL.
    const url = isPrivate ? toPrivateRef(key) : `${this.baseUrl}/uploads/${category}/${fileName}`;

    return { url, fileName, fileSize: file.size, mimeType: file.mimetype };
  }

  async deleteFile(fileUrlOrRef: string): Promise<void> {
    try {
      if (isPrivateRef(fileUrlOrRef)) {
        const key = privateRefToKey(fileUrlOrRef);
        if (!key) return;
        const filePath = path.join(this.privateUploadsDir, key);
        if (fs.existsSync(filePath)) await unlink(filePath);
        return;
      }
      // Public URL => path under cwd (the ServeStatic root).
      const urlPath = new URL(fileUrlOrRef).pathname;
      const filePath = path.join(process.cwd(), urlPath);
      if (fs.existsSync(filePath)) await unlink(filePath);
    } catch (err) {
      // Tolerate an already-removed file so a delete never throws, but log it
      // (a permission / disk error would otherwise be invisible). Last path
      // segment only -- never the full URL, no PII.
      const hint = fileUrlOrRef.split('/').pop() || fileUrlOrRef.slice(-32);
      this.logger.warn(
        `local deleteFile tolerated for "${hint}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Filesystem existence probe for the orphan-reconcile cron (report-only).
   * Mirrors deleteFile's path resolution. Returns null when the key can't be
   * decoded (indeterminate -> the cron skips it).
   */
  objectExists(fileUrlOrRef: string): Promise<boolean | null> {
    // Sync fs check wrapped in a resolved Promise to satisfy the async interface
    // (no await needed -- existsSync is synchronous).
    try {
      if (isPrivateRef(fileUrlOrRef)) {
        const key = privateRefToKey(fileUrlOrRef);
        if (!key) return Promise.resolve(null);
        return Promise.resolve(fs.existsSync(path.join(this.privateUploadsDir, key)));
      }
      const urlPath = new URL(fileUrlOrRef).pathname;
      return Promise.resolve(fs.existsSync(path.join(process.cwd(), urlPath)));
    } catch (err) {
      // Undecodable URL / unexpected fs error -> indeterminate, never report.
      this.logger.warn(
        `local objectExists indeterminate: ${err instanceof Error ? err.message : String(err)}`,
      );
      return Promise.resolve(null);
    }
  }

  /**
   * Dev equivalent of an R2 presigned GET: a 1-hour HMAC-signed URL to the
   * token-checked dev route. Clearly DEV-ONLY (prod uses real R2 presigning).
   */
  async getSignedUrl(privateRef: string): Promise<string> {
    const key = privateRefToKey(privateRef);
    if (!key) {
      throw new InternalServerErrorException('Cannot sign a non-private storage reference.');
    }
    const { exp, sig } = signLocalPrivateKey(key, this.devSecret);
    const qs = `key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
    return Promise.resolve(`${this.baseUrl}${LOCAL_PRIVATE_DEV_ROUTE}?${qs}`);
  }
}
