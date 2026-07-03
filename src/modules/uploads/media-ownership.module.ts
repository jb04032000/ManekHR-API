import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import storageConfig from '../../config/storage.config';
import { UploadEvent, UploadEventSchema } from './schemas/upload-event.schema';
import { MediaOwnershipService } from './services/media-ownership.service';
import { PrivateMediaService } from './services/private-media.service';
import { LocalStorageService } from './services/local-storage.service';
import { R2StorageService } from './services/r2-storage.service';

/**
 * Self-contained provider for the shared media guards. Kept separate from
 * `UploadsModule` so Connect modules can import just this without dragging in
 * `UploadsService` and its `ConnectAllowanceModule` dependency (which would risk
 * an import cycle back through Connect).
 *
 * Exports:
 *  - `MediaOwnershipService` — write-path "may this user attach this file?" guard.
 *  - `PrivateMediaService`   — read-path canonical-ref -> signed-URL decorator.
 * The storage adapters are config-only (no DB / Connect deps) so providing them
 * here is cycle-safe; a second instance from `UploadsModule` is harmless (stateless).
 */
@Module({
  imports: [
    ConfigModule.forFeature(storageConfig),
    MongooseModule.forFeature([{ name: UploadEvent.name, schema: UploadEventSchema }]),
  ],
  providers: [MediaOwnershipService, PrivateMediaService, LocalStorageService, R2StorageService],
  exports: [MediaOwnershipService, PrivateMediaService],
})
export class MediaOwnershipModule {}
