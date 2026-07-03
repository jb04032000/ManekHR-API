/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Pre-existing toDocResponse(doc: any) pattern; documented Phase 5 W6 carry-forward for separate refactor approval. */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { TeamMemberDocument } from './schemas/team-member-document.schema';
import { TeamMember } from './schemas/team-member.schema';
import { UploadsService } from '../uploads/uploads.service';
import { CreateTeamMemberDocumentDto } from './dto/team-member-document.dto';
import { PostHogService } from '../../common/posthog/posthog.service';

function toDocResponse(doc: any) {
  return {
    id: (doc._id as Types.ObjectId).toString(),
    type: doc.type,
    label: doc.label,
    fileUrl: doc.fileUrl,
    fileName: doc.fileName,
    fileSize: doc.fileSize,
    mimeType: doc.mimeType,
    uploadedBy: doc.uploadedBy?.toString(),
    createdAt: doc.createdAt,
  };
}

@Injectable()
export class TeamMemberDocumentsService {
  private readonly tracer = trace.getTracer('team');

  constructor(
    @InjectModel(TeamMemberDocument.name)
    private readonly docModel: Model<TeamMemberDocument>,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
    private readonly uploadsService: UploadsService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Phase 5 W6 — wrap a handler body with an OpenTelemetry span. Mirrors
   * `TeamService.withTeamSpan`.
   */
  private async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async assertMemberInWorkspace(workspaceId: string, memberId: string): Promise<void> {
    // Mirror TeamService.findById exactly so a member visible on the detail
    // page is also reachable from the documents tab. Two prior bugs here:
    //   1. workspaceId passed as raw string — mongoose auto-cast IS reliable
    //      for ObjectId-typed fields, but explicit cast removes ambiguity and
    //      matches the rest of the codebase.
    //   2. Filter was `isDeleted: { $ne: true }` (soft-delete flag) but
    //      findById uses `isPermanentlyDeleted: { $ne: true }`. Soft-deleted
    //      (archived) members loaded via the detail page were 404-ing here
    //      even though every other team-routed call accepted them.
    const member = await this.teamMemberModel
      .findOne({
        _id: new Types.ObjectId(memberId),
        workspaceId: new Types.ObjectId(workspaceId),
        isPermanentlyDeleted: { $ne: true },
      })
      .lean();
    if (!member) {
      throw new NotFoundException('Team member not found');
    }
  }

  async list(workspaceId: string, memberId: string) {
    return this.withSpan('team_documents.list', { workspaceId, memberId }, async () => {
      await this.assertMemberInWorkspace(workspaceId, memberId);
      const docs = await this.docModel
        .find({
          workspaceId: new Types.ObjectId(workspaceId),
          teamMemberId: new Types.ObjectId(memberId),
        })
        .sort({ createdAt: 1 })
        .lean();
      return { success: true, data: { documents: docs.map(toDocResponse) } };
    });
  }

  async create(
    workspaceId: string,
    memberId: string,
    userId: string,
    dto: CreateTeamMemberDocumentDto,
  ) {
    return this.withSpan('team_documents.create', { workspaceId, memberId, userId }, async () => {
      await this.assertMemberInWorkspace(workspaceId, memberId);
      const doc = await this.docModel.create({
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(memberId),
        uploadedBy: new Types.ObjectId(userId),
        type: dto.type,
        label: dto.label,
        fileUrl: dto.fileUrl,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        mimeType: dto.mimeType,
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'team.document_uploaded',
        properties: {
          workspaceId,
          memberId,
          docType: dto.type,
          fileSize: dto.fileSize,
        },
      });

      return { success: true, data: { document: toDocResponse(doc) } };
    });
  }

  async remove(workspaceId: string, memberId: string, docId: string) {
    return this.withSpan('team_documents.remove', { workspaceId, memberId, docId }, async () => {
      const doc = await this.docModel.findOne({
        _id: new Types.ObjectId(docId),
        workspaceId: new Types.ObjectId(workspaceId),
        teamMemberId: new Types.ObjectId(memberId),
      });
      if (!doc) {
        throw new NotFoundException('Document not found');
      }
      // Wave-3 Drift #36 — workspaceId for storage-quota refund.
      await this.uploadsService.deleteFile(doc.fileUrl, workspaceId);
      await doc.deleteOne();
      return { success: true };
    });
  }
}
