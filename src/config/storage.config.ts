import { registerAs } from '@nestjs/config';
import { env } from './env';

export default registerAs('storage', () => ({
  provider: env.storage.provider,
  maxFileSize: env.storage.maxFileSize,
  allowedTypes: env.storage.allowedTypesRaw.split(','),
  uploadsDir: env.storage.uploadsDir,
  privateUploadsDir: env.storage.privateUploadsDir,
  privateUrlDevSecret: env.storage.privateUrlDevSecret,
  r2: {
    accountId: env.storage.r2.accountId,
    bucket: env.storage.r2.bucket,
    privateBucket: env.storage.r2.privateBucket,
    accessKeyId: env.storage.r2.accessKeyId,
    secretAccessKey: env.storage.r2.secretAccessKey,
    publicUrl: env.storage.r2.publicUrl,
  },
}));
