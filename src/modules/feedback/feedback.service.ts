import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Feedback } from './schemas/feedback.schema';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    @InjectModel(Feedback.name)
    private readonly feedbackModel: Model<Feedback>,
    private readonly audit: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  async create(workspaceId: string, userId: string, dto: CreateFeedbackDto) {
    const doc = await this.feedbackModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: new Types.ObjectId(userId),
      module: dto.module,
      rating: dto.rating ?? null,
      message: dto.message,
      category: dto.category ?? 'general',
      scope: dto.scope ?? 'page',
      attachments: dto.attachments ?? [],
      context: dto.context ?? null,
    });

    void this.audit
      .logEvent({
        workspaceId,
        module: AppModule.FEEDBACK,
        entityType: 'feedback',
        entityId: doc._id,
        action: 'create',
        actorId: userId,
        meta: {
          module: dto.module,
          rating: dto.rating,
          category: dto.category ?? 'general',
        },
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(`Audit log failed for feedback ${doc._id.toString()}: ${detail}`);
      });

    // Product analytics: one write event per submission. distinct-id = userId;
    // counts/booleans only (no message text / image data). Read-only admin list
    // stays event-free per the observability convention. Keyless = no-op.
    this.postHog.capture({
      distinctId: userId,
      event: 'feedback.feedback_submitted',
      properties: {
        workspaceId,
        module: dto.module,
        scope: dto.scope ?? 'page',
        category: dto.category ?? 'general',
        hasRating: dto.rating != null,
        attachmentCount: dto.attachments?.length ?? 0,
      },
    });

    return doc;
  }
}
