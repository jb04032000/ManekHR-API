import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Feedback } from './schemas/feedback.schema';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import { AdminPaginationDto } from '../admin/dto/admin.dto';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
// Read-path decorator: signs r2-private:// attachment refs into 1h URLs for the
// detail view (sign once, resolve per ref). Provided by MediaOwnershipModule.
import { PrivateMediaService } from '../uploads/services/private-media.service';

@Injectable()
export class FeedbackAdminService {
  private readonly logger = new Logger(FeedbackAdminService.name);

  constructor(
    @InjectModel(Feedback.name)
    private readonly feedbackModel: Model<Feedback>,
    private readonly audit: AuditService,
    private readonly privateMedia: PrivateMediaService,
  ) {}

  async list(query: AdminPaginationDto) {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.max(query.limit ?? 20, 1);
    const search = query.search?.trim();
    const includeDeleted = query.includeDeleted ?? false;

    const filter: Record<string, unknown> = {};
    if (!includeDeleted) {
      filter.isDeleted = { $ne: true };
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ message: rx }, { module: rx }, { category: rx }];
    }
    // Exact-match facets (enum fields — kept out of the regex $or).
    if (query.scope === 'page' || query.scope === 'general') {
      filter.scope = query.scope;
    }
    if (query.status) {
      filter.status = query.status;
    }

    const [items, total] = await Promise.all([
      this.feedbackModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.feedbackModel.countDocuments(filter).exec(),
    ]);

    // Expose a light photo count per row (do NOT sign URLs in the list — the
    // detail view signs them on demand to keep the list cheap).
    const rows = items.map((it) => ({
      ...it,
      attachmentCount: Array.isArray(it.attachments) ? it.attachments.length : 0,
    }));

    return {
      items: rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    };
  }

  // Single feedback for the admin detail drawer. Decorates the private
  // attachment refs into fresh 1h signed URLs (sign once, resolve per ref). The
  // DB always stores raw r2-private:// refs; only this read path mints URLs.
  async getOne(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Feedback not found');
    }
    const doc = await this.feedbackModel.findById(id).lean().exec();
    if (!doc || doc.isDeleted) throw new NotFoundException('Feedback not found');

    const refs = Array.isArray(doc.attachments) ? doc.attachments : [];
    const signed = await this.privateMedia.signMany(refs);
    const attachments = refs.map((r) => this.privateMedia.resolve(r, signed));
    return { ...doc, attachments };
  }

  async updateStatus(id: string, dto: UpdateFeedbackStatusDto, actorId: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Feedback not found');
    }

    const before = await this.feedbackModel.findById(id).lean().exec();
    if (!before) throw new NotFoundException('Feedback not found');

    const updated = await this.feedbackModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status: dto.status,
            ...(dto.adminNotes !== undefined ? { adminNotes: dto.adminNotes } : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Feedback not found');

    void this.audit
      .logEvent({
        workspaceId: before.workspaceId as Types.ObjectId,
        module: AppModule.FEEDBACK,
        entityType: 'feedback',
        entityId: updated._id,
        action: 'update_status',
        actorId,
        before: { status: before.status, adminNotes: before.adminNotes },
        after: { status: updated.status, adminNotes: updated.adminNotes },
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(`Audit log failed for feedback ${id}: ${detail}`);
      });

    return updated;
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
