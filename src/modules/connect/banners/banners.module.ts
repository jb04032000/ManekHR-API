import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectBanner, ConnectBannerSchema } from './schemas/connect-banner.schema';
import { BannerService } from './services/banner.service';
import { BannerPublicController } from './controllers/banner-public.controller';
import { BannerAdminController } from './controllers/banner-admin.controller';
import { AuditModule } from '../../audit/audit.module';
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';

/**
 * ManekHR Connect — feed banner carousel.
 *
 * Public read (`connect/banners`) + platform-admin CRUD (`admin/connect/
 * banners`). Imports:
 *  - `MediaOwnershipModule` for `PrivateMediaService` (sign private image refs
 *    on read, normalise signed URLs back to refs on write).
 *  - `AuditModule` for the admin-write audit trail.
 *  `PostHogService` is `@Global` so it is injected without an import.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ConnectBanner.name, schema: ConnectBannerSchema }]),
    MediaOwnershipModule,
    AuditModule,
  ],
  controllers: [BannerPublicController, BannerAdminController],
  providers: [BannerService],
  exports: [BannerService],
})
export class ConnectBannersModule {}
