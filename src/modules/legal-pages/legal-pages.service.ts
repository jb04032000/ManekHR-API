import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LegalPage } from './schemas/legal-page.schema';
import { CreateLegalPageDto, UpdateLegalPageDto } from './dto/legal-page.dto';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * Admin-managed legal/policy documents (Terms + Privacy, per product).
 *
 * Cross-module links:
 *   - AuditService: every admin write is logged under AppModule.LEGAL
 *     (fire-and-forget; an audit failure never blocks the write).
 *   - Public read (getPublishedBySlug) is the ONLY method that serves content to
 *     unauthenticated visitors and it filters `status: 'published'`, so drafts
 *     never leak. Keep that filter if you refactor.
 */
@Injectable()
export class LegalPagesService {
  constructor(
    @InjectModel(LegalPage.name)
    private readonly legalPageModel: Model<LegalPage>,
    private readonly auditService: AuditService,
  ) {}

  // ── Admin ──────────────────────────────────────────────────────────────────

  /** All pages (admin console), optionally filtered by product/kind. */
  list(filter?: { product?: string; kind?: string }): Promise<LegalPage[]> {
    const query: Record<string, string> = {};
    if (filter?.product) query.product = filter.product;
    if (filter?.kind) query.kind = filter.kind;
    return this.legalPageModel
      .find(query)
      .sort({ product: 1, kind: 1 })
      .lean()
      .exec() as unknown as Promise<LegalPage[]>;
  }

  async getById(id: string): Promise<LegalPage> {
    const page = await this.legalPageModel.findById(id).lean().exec();
    if (!page) throw new NotFoundException('Legal page not found');
    return page as unknown as LegalPage;
  }

  async create(dto: CreateLegalPageDto, actorId: string): Promise<LegalPage> {
    const existing = await this.legalPageModel.findOne({ slug: dto.slug }).lean().exec();
    if (existing) {
      throw new ConflictException('A legal page with this slug already exists');
    }
    const created = await this.legalPageModel.create(dto);
    this.audit(actorId, (created as { _id: Types.ObjectId })._id, 'legal_page_created', {
      after: { slug: dto.slug },
    });
    return created;
  }

  async update(id: string, dto: UpdateLegalPageDto, actorId: string): Promise<LegalPage> {
    const updated = await this.legalPageModel
      .findByIdAndUpdate(id, { $set: dto }, { returnDocument: 'after' })
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('Legal page not found');
    this.audit(actorId, (updated as { _id: Types.ObjectId })._id, 'legal_page_updated', {
      after: { ...dto },
    });
    return updated as unknown as LegalPage;
  }

  /**
   * Publish: flip status -> published and bump the version counter atomically so
   * the public route starts serving this content. Idempotent on content; each
   * call increments `version` (the publish history signal).
   */
  async publish(id: string, actorId: string): Promise<LegalPage> {
    const updated = await this.legalPageModel
      .findByIdAndUpdate(
        id,
        { $set: { status: 'published' }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('Legal page not found');
    this.audit(actorId, (updated as { _id: Types.ObjectId })._id, 'legal_page_published', {
      after: { status: 'published', version: (updated as { version?: number }).version },
    });
    return updated as unknown as LegalPage;
  }

  async remove(id: string, actorId: string): Promise<{ message: string }> {
    const deleted = await this.legalPageModel.findByIdAndDelete(id).lean().exec();
    if (!deleted) throw new NotFoundException('Legal page not found');
    this.audit(actorId, (deleted as { _id: Types.ObjectId })._id, 'legal_page_deleted', {
      before: { slug: (deleted as { slug?: string }).slug },
    });
    return { message: 'Legal page deleted' };
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /**
   * Public read used by the marketing /terms + /privacy routes. Returns the page
   * ONLY when it is published; a draft-only (or missing) slug throws NotFound so
   * unpublished content never leaks.
   */
  async getPublishedBySlug(slug: string): Promise<LegalPage> {
    const page = await this.legalPageModel.findOne({ slug, status: 'published' }).lean().exec();
    if (!page) throw new NotFoundException('Legal page not found');
    return page as unknown as LegalPage;
  }

  // ── internal ───────────────────────────────────────────────────────────────

  /** Fire-and-forget admin audit (mirrors AdminService); never blocks the write. */
  private audit(
    actorId: string,
    entityId: Types.ObjectId | string,
    action: string,
    extra: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {},
  ): void {
    void this.auditService
      .logEvent({
        module: AppModule.LEGAL,
        entityType: 'legal_page',
        entityId,
        action,
        actorId,
        ...extra,
      })
      .catch(() => undefined);
  }
}
