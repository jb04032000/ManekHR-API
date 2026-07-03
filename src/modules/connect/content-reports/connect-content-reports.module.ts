import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentReport, ContentReportSchema } from './schemas/content-report.schema';
import { ContentReportsService } from './content-reports.service';
import { ContentReportsController } from './content-reports.controller';
import { ContentReportsAdminController } from './content-reports.admin.controller';
import { AuditModule } from '../../audit/audit.module';

/**
 * ManekHR Connect -- Content Reports & Moderation module. Owns the
 * `connect_content_reports` collection, the member report endpoint
 * (`/connect/content-reports`) and the admin moderation queue
 * (`/admin/connect/content-reports`).
 *
 * The UGC moderation capability required for Google AdSense approval. Leaf
 * module: it emits CONTENT_TAKEDOWN_EVENT (via the global EventEmitter) on an
 * admin "Remove" action; feed.service + listing-moderation.service listen and
 * perform the real cascade delete. Audit goes through AuditModule.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ContentReport.name, schema: ContentReportSchema }]),
    AuditModule,
  ],
  controllers: [ContentReportsController, ContentReportsAdminController],
  providers: [ContentReportsService],
  exports: [ContentReportsService],
})
export class ConnectContentReportsModule {}
