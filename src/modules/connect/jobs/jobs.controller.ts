import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { JobsService } from './jobs.service';
import {
  CreateJobDto,
  UpdateJobDto,
  CloseJobDto,
  CreateJobApplicationDto,
  SetApplicationStatusDto,
  BoardQueryDto,
  BoardFacetsQueryDto,
} from './dto/job.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/jobs` -- the Jobs board + the hiring funnel (Phase 5). Person-centric:
 * the actor is always `req.user.sub`. Literal routes (`board`, `mine`,
 * `my-applications`) are declared BEFORE `:id` so they are not captured as ids.
 */
@LegacyUnclassified()
@Controller('connect/jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  // ── Literal routes (before :id) ────────────────────────────────────────

  @Get('board')
  board(@Query() query: BoardQueryDto) {
    return this.jobs.listBoard(query);
  }

  @Get('board/stats')
  boardStats() {
    return this.jobs.boardStats();
  }

  /**
   * Filter-rail counts for the board (one $facet aggregation). Literal route, so
   * declared before `:id`. Heavier throttle than `board` (the aggregation is
   * pricier than the paged list, and the rail refetches it on every filter
   * change). Same JwtAuthGuard as the rest of the controller. Web:
   * jobs.actions.getJobBoardFacets -> JobFilterRail.
   */
  @Get('board/facets')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  boardFacets(@Query() query: BoardFacetsQueryDto) {
    return this.jobs.boardFacets(query);
  }

  /**
   * Read-only "Promoted" jobs block for the board (Phase 5.1). Literal route, so
   * declared BEFORE `:id`. Same JwtAuthGuard as the rest of the controller. This
   * never bills: it pins active job boosts (status open + matching the active
   * filters) without opening an ad impression or calling decide. Web:
   * jobs.actions.listPromotedJobs -> PromotedJobs block.
   */
  @Get('board/promoted')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  boardPromoted(@Query() query: BoardQueryDto) {
    return this.jobs.listPromotedForBoard(query);
  }

  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    return this.jobs.listMine(req.user.sub);
  }

  @Get('my-applications')
  myApplications(@Req() req: AuthedRequest) {
    return this.jobs.listMyApplications(req.user.sub);
  }

  /** The caller's saved (bookmarked) jobs, newest-saved first. */
  @Get('saved')
  savedJobs(@Req() req: AuthedRequest) {
    return this.jobs.listSavedJobs(req.user.sub);
  }

  /** A company page's public open jobs (the page Jobs tab; logged-out OK). */
  @Public()
  @Get('by-page/:pageId')
  byPage(@Param('pageId') pageId: string) {
    return this.jobs.listByCompanyPage(pageId);
  }

  /**
   * Public: a person's open jobs for their profile Hiring card (logged-out OK).
   * Declared with the literal `by-user` prefix BEFORE `:id` so Nest does not
   * capture `by-user` as a job id. Web: profile IntentCards.
   */
  @Public()
  @Get('by-user/:userId/open')
  openByUser(@Param('userId') userId: string) {
    return this.jobs.listOpenJobsByUser(userId);
  }

  /** The owner's full job history for one page (all statuses) - the manage console. */
  @Get('by-page/:pageId/manage')
  byPageManage(@Req() req: AuthedRequest, @Param('pageId') pageId: string) {
    return this.jobs.listByCompanyPageForOwner(req.user.sub, pageId);
  }

  /**
   * Public single OPEN job read for the logged-out web `/jobs/[id]` SEO page +
   * crawlers. Declared with the literal `public/` prefix BEFORE `:id` so Nest
   * does not capture `public` as a job id (same ordering rule as `by-user` /
   * `by-page`). 404s any non-open (closed / filled / suppressed) job so a crawler
   * can never index a job that is off the board - mirrors the suppressed-listing
   * detail 404. Read-only, never leaks applicant data (returns the same Job shape
   * as the authed read). Modest read throttle, consistent with `board/promoted`.
   * Web: jobs.actions.getPublicJob -> public job page.
   */
  @Public()
  @Get('public/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  getPublic(@Param('id') id: string) {
    return this.jobs.getPublicJob(id);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateJobDto) {
    return this.jobs.createJob(req.user.sub, dto);
  }

  // ── Application review actions (literal `applications/` prefix) ─────────

  @Post('applications/:applicationId/accept')
  acceptApplication(@Req() req: AuthedRequest, @Param('applicationId') applicationId: string) {
    return this.jobs.acceptApplication(req.user.sub, applicationId);
  }

  @Post('applications/:applicationId/status')
  setApplicationStatus(
    @Req() req: AuthedRequest,
    @Param('applicationId') applicationId: string,
    @Body() dto: SetApplicationStatusDto,
  ) {
    return this.jobs.setApplicationStatus(req.user.sub, applicationId, dto.status);
  }

  @Post('applications/:applicationId/withdraw')
  withdrawApplication(@Req() req: AuthedRequest, @Param('applicationId') applicationId: string) {
    return this.jobs.withdrawApplication(req.user.sub, applicationId);
  }

  // ── :id routes ─────────────────────────────────────────────────────────

  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.jobs.getJob(id, req.user.sub);
  }

  @Get(':id/applications')
  applications(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.jobs.listApplicationsForMyJob(req.user.sub, id);
  }

  /** Edit an open job (owner only; ownership + open-status enforced in service). */
  @Patch(':id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpdateJobDto) {
    return this.jobs.updateJob(req.user.sub, id, dto);
  }

  /** Close a job, capturing the hire outcome (filled = hired, else just closed). */
  @Post(':id/close')
  close(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: CloseJobDto) {
    return this.jobs.closeJob(req.user.sub, id, dto.filled);
  }

  @Post(':id/apply')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  apply(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: CreateJobApplicationDto) {
    return this.jobs.applyToJob(req.user.sub, id, dto);
  }

  /** Save (bookmark) a job for the caller. Idempotent. */
  @Post(':id/save')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  save(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.jobs.saveJob(req.user.sub, id);
  }

  /** Un-save a job for the caller. Tolerates a missing bookmark. */
  @Delete(':id/save')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  unsave(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.jobs.unsaveJob(req.user.sub, id);
  }
}
