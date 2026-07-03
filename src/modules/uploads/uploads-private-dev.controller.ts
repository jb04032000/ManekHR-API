import { Controller, Get, Query, Res, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Public } from '../../common/decorators/public.decorator';
import { LOCAL_PRIVATE_DEV_ROUTE, verifyLocalPrivateToken } from './local-private-url';

/**
 * DEV-ONLY token-checked stream for private media when running WITHOUT R2.
 *
 * Production serves private media via real R2 presigned URLs and this route is
 * inert (provider === 'r2' => 404 on every request). Locally it is the dev
 * equivalent: the signed URL minted by `LocalStorageService.getSignedUrl`
 * carries an HMAC token this route verifies before streaming the file from the
 * private (non-statically-served) uploads dir.
 *
 * `@Public()` because, exactly like an R2 presigned URL, the signed token IS the
 * authorization - there is no JWT on an <img>/<audio> GET. The token gates access;
 * an expired or forged one 403s.
 */
@Public()
@Controller()
export class UploadsPrivateDevController {
  private readonly enabled: boolean;
  private readonly privateUploadsDir: string;
  private readonly devSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get<string>('storage.provider') !== 'r2';
    this.privateUploadsDir = this.configService.get<string>('storage.privateUploadsDir');
    this.devSecret = this.configService.get<string>('storage.privateUrlDevSecret');
  }

  @Get(LOCAL_PRIVATE_DEV_ROUTE)
  serve(
    @Query('key') key: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): void {
    // Inert under R2 — there is no local private store to read from.
    if (!this.enabled) throw new NotFoundException();
    if (!key) throw new NotFoundException();

    if (!verifyLocalPrivateToken(key, Number(exp), sig, this.devSecret)) {
      throw new ForbiddenException('Invalid or expired media link');
    }

    // Path-traversal guard: the resolved file must stay inside the private root.
    const root = path.resolve(this.privateUploadsDir);
    const filePath = path.resolve(root, key);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      throw new ForbiddenException('Invalid media path');
    }
    if (!fs.existsSync(filePath)) throw new NotFoundException();

    res.sendFile(filePath);
  }
}
