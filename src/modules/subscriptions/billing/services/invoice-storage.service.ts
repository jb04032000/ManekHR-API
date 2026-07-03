import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

/**
 * Cloudflare R2 storage for billing invoices (D1f).
 *
 * Direct S3Client (not the workspace `UploadsService`) because:
 *   - Invoices are platform-owned, not user-owned — no workspace
 *     storage quota tracking applies.
 *   - Deterministic key path enables idempotent re-uploads on
 *     regenerate (same invoice number → same R2 key → overwrite).
 *
 * Key format: `billing/invoices/<fy>/<invoice-number>.pdf` e.g.
 * `billing/invoices/FY26/ZAR-FY26-000123.pdf`. Listing by FY is the
 * common access pattern for accounting export.
 *
 * Access pattern: invoice numbers are SEQUENTIAL (GST law) which makes
 * direct R2 URLs trivially enumerable. Therefore the controller proxies
 * downloads through an authenticated API endpoint — never expose the
 * R2 key as a client-facing URL. `download()` returns the raw bytes;
 * the controller streams them with auth checks.
 */
@Injectable()
export class InvoiceStorageService {
  private readonly logger = new Logger(InvoiceStorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('storage.r2.accountId');
    this.bucket = this.configService.get<string>('storage.r2.bucket') ?? '';
    const accessKeyId = this.configService.get<string>(
      'storage.r2.accessKeyId',
    );
    const secretAccessKey = this.configService.get<string>(
      'storage.r2.secretAccessKey',
    );

    if (!accountId || !this.bucket || !accessKeyId || !secretAccessKey) {
      this.logger.warn(
        'R2 credentials missing — invoice storage disabled (set R2_* env vars)',
      );
      this.client = null;
      return;
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /**
   * Upload an invoice PDF buffer. Uses a deterministic key so a
   * regenerate overwrites the existing object — invoice numbers are
   * stable for the life of the payment.
   */
  async upload(args: { invoiceNumber: string; pdf: Buffer }): Promise<{ key: string }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Invoice storage not configured — set R2 credentials in env',
      );
    }
    const key = this.keyFor(args.invoiceNumber);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: args.pdf,
        ContentType: 'application/pdf',
        ContentLength: args.pdf.length,
        ContentDisposition: `attachment; filename="${args.invoiceNumber}.pdf"`,
      }),
    );
    return { key };
  }

  /**
   * Fetch an invoice PDF for streaming back to an authenticated client.
   * Throws on missing/unreadable object so the controller can 404 cleanly.
   */
  async download(key: string): Promise<Buffer> {
    if (!this.client) {
      throw new ServiceUnavailableException('Invoice storage not configured');
    }
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`Invoice object empty: ${key}`);
    }
    return this.streamToBuffer(response.Body as Readable);
  }

  async delete(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(`Invoice delete failed key=${key} err=${(err as Error).message}`);
    }
  }

  keyFor(invoiceNumber: string): string {
    const match = invoiceNumber.match(/-(FY\d{2})-/);
    const fy = match ? match[1] : 'misc';
    return `billing/invoices/${fy}/${invoiceNumber}.pdf`;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
