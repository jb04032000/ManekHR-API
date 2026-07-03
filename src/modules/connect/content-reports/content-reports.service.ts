import { Injectable, NotFoundException, Optional, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContentReport } from './schemas/content-report.schema';
import { CreateContentReportDto } from './dto/content-report.dto';
import { CONTENT_TAKEDOWN_EVENT, type ContentTakedownEvent } from './content-reports.constants';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';

/**
 * ManekHR Connect -- public-UGC abuse reports + the admin moderation queue.
 *
 * Member path: `create` (dedup'd, one OPEN report per reporter+target). Admin
 * path: `listOpen`/`countOpen` (the queue) + `action`/`dismiss` (resolve). On
 * `action` it emits CONTENT_TAKEDOWN_EVENT; feed.service + listing-moderation
 * listen and perform the real cascade delete, so this stays a leaf module.
 *
 * Cross-module links: AuditService (admin writes under AppModule.CONNECT),
 * PostHogService (report submitted event), EventEmitter2 (takedown). Distinct
 * from inbox message reports (private DMs).
 */
@Injectable()
export class ContentReportsService {
  constructor(
    @InjectModel(ContentReport.name)
    private readonly reportModel: Model<ContentReport>,
    private readonly auditService: AuditService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  // ── Member ───────────────────────────────────────────────────────────────────

  /**
   * File a report. Idempotent per (reporter, target): if the same member already
   * has an OPEN report on this target, return it instead of stacking duplicates.
   */
  async create(reporterUserId: string, dto: CreateContentReportDto): Promise<ContentReport> {
    const existing = await this.reportModel
      .findOne({
        reporterUserId: new Types.ObjectId(reporterUserId),
        targetType: dto.targetType,
        targetId: dto.targetId,
        status: 'open',
      })
      .exec();
    if (existing) return existing;

    const created = await this.reportModel.create({
      reporterUserId: new Types.ObjectId(reporterUserId),
      targetType: dto.targetType,
      targetId: dto.targetId,
      targetOwnerUserId: dto.targetOwnerUserId ? new Types.ObjectId(dto.targetOwnerUserId) : null,
      reason: dto.reason,
      detail: dto.detail ?? '',
      snapshot: dto.snapshot ?? '',
      targetUrl: dto.targetUrl ?? '',
      status: 'open',
    });

    this.posthog?.capture({
      distinctId: reporterUserId,
      event: 'connect.content_reported',
      properties: { targetType: dto.targetType, reason: dto.reason },
    });

    return created;
  }

  // ── Admin queue ──────────────────────────────────────────────────────────────

  /** Open reports, newest-first (optionally filtered by target type). */
  listOpen(filter?: { targetType?: string }): Promise<ContentReport[]> {
    const query: Record<string, unknown> = { status: 'open' };
    if (filter?.targetType) query.targetType = filter.targetType;
    return this.reportModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()
      .exec() as unknown as Promise<ContentReport[]>;
  }

  /** Count of open reports (drives the admin nav badge). */
  countOpen(): Promise<number> {
    return this.reportModel.countDocuments({ status: 'open' }).exec();
  }

  /**
   * Resolve a report as ACTIONED and remove the content. Marks the report, then
   * emits CONTENT_TAKEDOWN_EVENT so the owning module performs the real cascade
   * delete (best-effort: a missing listener never blocks the resolution).
   */
  async action(id: string, adminId: string, note?: string): Promise<ContentReport> {
    const report = await this.resolve(id, adminId, 'actioned', note);
    const payload: ContentTakedownEvent = {
      targetType: report.targetType,
      targetId: report.targetId,
      actorId: adminId,
    };
    this.events?.emit(CONTENT_TAKEDOWN_EVENT, payload);
    return report;
  }

  /** Resolve a report as DISMISSED (no action). */
  dismiss(id: string, adminId: string, note?: string): Promise<ContentReport> {
    return this.resolve(id, adminId, 'dismissed', note);
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private async resolve(
    id: string,
    adminId: string,
    status: 'actioned' | 'dismissed',
    note?: string,
  ): Promise<ContentReport> {
    const updated = await this.reportModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status,
            reviewedBy: new Types.ObjectId(adminId),
            reviewedAt: new Date(),
            resolution: note ?? '',
          },
        },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('Report not found');
    const doc = updated as unknown as ContentReport & { _id: Types.ObjectId };
    this.audit(adminId, String(doc._id), `content_report_${status}`, {
      targetType: doc.targetType,
      targetId: doc.targetId,
    });
    return doc;
  }

  /** Fire-and-forget admin audit under the CONNECT module; never blocks the write. */
  private audit(
    actorId: string,
    entityId: string,
    action: string,
    meta: Record<string, unknown>,
  ): void {
    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.CONNECT,
        entityType: 'ContentReport',
        entityId,
        action,
        actorId,
        meta,
      })
      .catch(() => undefined);
  }
}
