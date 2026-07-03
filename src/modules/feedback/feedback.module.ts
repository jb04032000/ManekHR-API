import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FeedbackController } from './feedback.controller';
import { FeedbackAdminController } from './feedback-admin.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackAdminService } from './feedback-admin.service';
import { Feedback, FeedbackSchema } from './schemas/feedback.schema';
import { AuditModule } from '../audit/audit.module';
// Exports PrivateMediaService (signs r2-private:// refs into 1h URLs for the
// admin console). Importing this module — not UploadsModule — avoids pulling in
// UploadsService and risking an import cycle.
import { MediaOwnershipModule } from '../uploads/media-ownership.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Feedback.name, schema: FeedbackSchema }]),
    AuditModule,
    MediaOwnershipModule,
  ],
  controllers: [FeedbackController, FeedbackAdminController],
  providers: [FeedbackService, FeedbackAdminService],
  exports: [FeedbackService, FeedbackAdminService],
})
export class FeedbackModule {}
