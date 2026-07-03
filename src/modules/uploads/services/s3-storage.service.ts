import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IStorageService } from './storage.interface';
import { UploadResponseDto } from '../dto/upload-response.dto';

@Injectable()
export class S3StorageService implements IStorageService {
  constructor(private configService: ConfigService) {}

  uploadFile(_file: any, _category: string): Promise<UploadResponseDto> {
    // TODO: Implement S3 upload using AWS SDK
    // const s3Config = this.configService.get('storage.s3');
    // Upload to S3 bucket
    // Return S3 URL

    throw new Error('S3 storage not implemented yet. Set STORAGE_PROVIDER=local');
  }

  deleteFile(_fileUrl: string): Promise<void> {
    // TODO: Implement S3 delete using AWS SDK
    throw new Error('S3 storage not implemented yet');
  }

  // Interface conformance (IStorageService gained private signed-URL support).
  // This provider is an unused stub; implement alongside the upload/delete TODOs
  // if STORAGE_PROVIDER=s3 is ever wired up.
  getSignedUrl(_privateRef: string): Promise<string> {
    throw new Error('S3 storage not implemented yet');
  }

  // Interface conformance only. This provider is an unused stub; if S3 is ever
  // wired up, implement via HeadObjectCommand like R2StorageService.objectExists.
  objectExists(_fileUrlOrRef: string): Promise<boolean | null> {
    throw new Error('S3 storage not implemented yet');
  }
}
