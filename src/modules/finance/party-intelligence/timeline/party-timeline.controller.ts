/**
 * Phase 17 / FIN-16-03 — Party CRM Timeline read/write controller.
 *
 * Endpoints (D-19, D-20):
 *   GET    /workspaces/:wsId/parties/:partyId/timeline       — cursor-paginated reverse-chrono
 *   POST   /workspaces/:wsId/parties/:partyId/timeline       — manual entry (call/email/note)
 *   PATCH  /workspaces/:wsId/parties/:partyId/timeline/:eventId  — owner edit within 24h
 *   DELETE /workspaces/:wsId/parties/:partyId/timeline/:eventId  — owner delete within 24h
 *
 * RBAC: existing AppModule.FINANCE permission (party-intelligence reads/writes
 * piggy-back on Finance module). Subscription gate: `party_intelligence_timeline`.
 *
 * Cross-workspace read isolation (T-17-W1A-02): every query filter includes
 * workspaceId from the route param wrapped in new Types.ObjectId.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';

import { Party } from '../../parties/party.schema';
import { PartyTimelineEvent, PARTY_TIMELINE_EVENT_TYPES } from './party-timeline-event.schema';
import { PartyTimelineService } from './party-timeline.service';
import { CreateTimelineEventDto } from './dto/create-timeline-event.dto';
import { ListTimelineDto } from './dto/list-timeline.dto';

const MANUAL_TYPES = new Set(['call.logged', 'email.logged', 'note.added']);
const TWENTYFOUR_HOURS_MS = 24 * 60 * 60 * 1000;

@ApiTags('Finance - Parties')
@Controller('workspaces/:wsId/parties/:partyId/timeline')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({
  module: AppModule.FINANCE,
  subFeature: 'party_intelligence_timeline',
})
export class PartyTimelineController {
  constructor(
    @InjectModel(PartyTimelineEvent.name)
    private readonly model: Model<PartyTimelineEvent>,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    private readonly service: PartyTimelineService,
  ) {}

  // ─── GET /timeline ────────────────────────────────────────────────────────
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Query() query: ListTimelineDto,
  ): Promise<{ events: PartyTimelineEvent[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const filter: Record<string, unknown> = {
      // Pitfall 1 (Mongoose autocast): always wrap.
      workspaceId: new Types.ObjectId(wsId),
      partyId: new Types.ObjectId(partyId),
    };
    if (query.before) {
      filter.occurredAt = { $lt: new Date(query.before) };
    }
    if (query.types && query.types.length > 0) {
      filter.type = { $in: query.types };
    }
    const events = await this.model
      .find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()
      .exec();

    let nextCursor: string | null = null;
    if (events.length > limit) {
      const last = events[limit - 1];
      nextCursor =
        (last.occurredAt instanceof Date
          ? last.occurredAt.toISOString()
          : new Date(last.occurredAt as string).toISOString()) ?? null;
      events.length = limit;
    }
    return { events: events as PartyTimelineEvent[], nextCursor };
  }

  // ─── POST /timeline ───────────────────────────────────────────────────────
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Body() dto: CreateTimelineEventDto,
    @CurrentUser() user: { _id: string; userId?: string },
  ): Promise<PartyTimelineEvent> {
    if (!MANUAL_TYPES.has(dto.type)) {
      throw new BadRequestException(`Type '${dto.type}' is not a manual type`);
    }
    // Resolve firmId from the Party doc — manual entries don't carry it.
    const party = await this.partyModel
      .findOne({
        _id: new Types.ObjectId(partyId),
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: { $ne: true },
      })
      .select('firmId')
      .lean();
    if (!party) throw new NotFoundException('Party not found');

    const userId = (user as any)?._id ?? (user as any)?.userId;
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    await this.service.append({
      type: dto.type,
      workspaceId: wsId,
      firmId: (party as any).firmId,
      partyId,
      occurredAt,
      actorUserId: userId,
      summary: dto.summary,
      meta: dto.meta,
    });

    // Service.append doesn't return the doc; re-fetch the most recent matching
    // row for the response. (Cheap — same wsId+partyId+type+occurredAt window.)
    const created = await this.model
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        partyId: new Types.ObjectId(partyId),
        type: dto.type,
        actorUserId: new Types.ObjectId(userId),
        occurredAt,
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return created as PartyTimelineEvent;
  }

  // ─── PATCH /timeline/:eventId ─────────────────────────────────────────────
  @Patch(':eventId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Param('eventId') eventId: string,
    @Body() body: { summary?: string; meta?: Record<string, unknown> },
    @CurrentUser() user: { _id: string; userId?: string },
  ): Promise<PartyTimelineEvent> {
    const userId = (user as any)?._id ?? (user as any)?.userId;
    const event = await this.assertManualOwnerWithin24h(wsId, partyId, eventId, userId);
    if (body.summary !== undefined) {
      if (
        typeof body.summary !== 'string' ||
        body.summary.length === 0 ||
        body.summary.length > 500
      ) {
        throw new BadRequestException('summary must be 1..500 chars');
      }
      event.summary = body.summary;
    }
    if (body.meta !== undefined) event.meta = body.meta;
    await event.save();
    return event;
  }

  // ─── DELETE /timeline/:eventId ────────────────────────────────────────────
  @Delete(':eventId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async remove(
    @Param('wsId') wsId: string,
    @Param('partyId') partyId: string,
    @Param('eventId') eventId: string,
    @CurrentUser() user: { _id: string; userId?: string },
  ): Promise<{ deleted: true }> {
    const userId = (user as any)?._id ?? (user as any)?.userId;
    const event = await this.assertManualOwnerWithin24h(wsId, partyId, eventId, userId);
    await this.model.deleteOne({ _id: event._id });
    return { deleted: true };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /**
   * Loads the event and enforces the D-20 immutability window:
   *   - actorUserId === current user
   *   - type ∈ manual types
   *   - createdAt >= now - 24h
   */
  private async assertManualOwnerWithin24h(
    wsId: string,
    partyId: string,
    eventId: string,
    userId: string,
  ): Promise<PartyTimelineEvent> {
    if (!userId) throw new ForbiddenException('User context missing');
    const event = await this.model.findOne({
      _id: new Types.ObjectId(eventId),
      workspaceId: new Types.ObjectId(wsId),
      partyId: new Types.ObjectId(partyId),
    });
    if (!event) throw new NotFoundException('Timeline event not found');
    if (!MANUAL_TYPES.has(event.type)) {
      throw new ForbiddenException(
        'Only manual entries (call.logged, email.logged, note.added) can be edited or deleted',
      );
    }
    if (!event.actorUserId || event.actorUserId.toString() !== String(userId)) {
      throw new ForbiddenException('Only the original author can edit or delete this entry');
    }
    const createdAt = (event as any).createdAt as Date | undefined;
    if (!createdAt) {
      throw new ForbiddenException('Event has no createdAt — cannot edit');
    }
    if (Date.now() - createdAt.getTime() > TWENTYFOUR_HOURS_MS) {
      throw new ForbiddenException('Edit/delete window (24 hours) has expired for this entry');
    }
    return event;
  }
}

// Re-export to keep the locked event-types list discoverable.
export { PARTY_TIMELINE_EVENT_TYPES };
