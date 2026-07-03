import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import { LIST_HARD_CAP } from '../common/keyset-cursor';
import { Job, type JobDocument } from './schemas/job.schema';
import { CONNECT_JOB_CHANGED, type ConnectJobChangeType } from './events/connect-job.events';
import { JobApplication, type JobApplicationDocument } from './schemas/job-application.schema';
import { JobView, type JobViewDocument } from './schemas/job-view.schema';
import { SavedJob, type SavedJobDocument } from './schemas/saved-job.schema';
import { buildBoardFilter, buildBoardSort } from './board-query.helpers';
import { User } from '../../users/schemas/user.schema';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { ConnectAllowanceService } from '../monetization/connect-allowance.service';
import { ConnectOverLimitService } from '../over-limit/connect-over-limit.service';
import { CompanyPageService } from '../entities/services/company-page.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { TagService } from '../tags/tag.service';
import { JobBoostResolverService } from '../ads/services/job-boost-resolver.service';
import { MediaOwnershipService } from '../../uploads/services/media-ownership.service';
import { PrivateMediaService } from '../../uploads/services/private-media.service';
// CN-LIM-3: serialize the open-job cap check+insert per owner (see listing.service
// / connect-cap-lock.util). Reuses the shared Redis mutex, not a new primitive.
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { connectCapLockKey } from '../over-limit/connect-cap-lock.util';
import type {
  CreateJobDto,
  UpdateJobDto,
  CreateJobApplicationDto,
  BoardQueryDto,
  BoardFacetsQueryDto,
} from './dto/job.dto';

/** One countable value in a facet (e.g. district "Varachha" with 12 open jobs). */
export interface FacetEntry {
  value: string;
  count: number;
}

/**
 * Counts payload for the board filter rail (the $facet aggregation). `total` is
 * the count of jobs matching ALL active filters; each facet array is the per-value
 * count when that facet's OWN field is removed from the filter set (so it answers
 * "how many would I get if I also picked this"). Mirrored in web jobs.types.ts
 * BoardFacets; served by GET /connect/jobs/board/facets.
 */
export interface JobBoardFacets {
  total: number;
  district: FacetEntry[];
  role: FacetEntry[];
  employmentType: FacetEntry[];
  machineType: FacetEntry[];
  skill: FacetEntry[];
  wageType: FacetEntry[];
}

/** Raw $sortByCount bucket shape ({_id, count}) before we map it to a FacetEntry. */
interface RawBucket {
  _id: string | null;
  count: number;
}

/** A worker's own application enriched for the My applications list: the raw
 *  application + a small job snapshot (title, role for the icon, location) and the
 *  employer display name. Mirror on the web: features/connect/jobs/jobs.types.ts
 *  MyApplicationView. job is null only if the job was hard-deleted. */
export interface MyApplicationView extends JobApplication {
  job: {
    id: string;
    title: string;
    role: string | null;
    location: { district?: string; state?: string } | null;
  } | null;
  employer: { name: string };
}

/**
 * ManekHR Connect -- Jobs (Phase 5). A company posts work it needs people for;
 * karigars browse the board + apply. Person-centric (`companyUserId` /
 * `applicantUserId`), never a workspace. A job may be posted AS a company page
 * (ownership verified via `CompanyPageService`). Unlike the board-only RFQ, the
 * hiring funnel DOES notify: the company on a new application, the applicant on
 * accept / decline. The deal is closed off-platform (mediator model).
 */
@Injectable()
export class JobsService {
  // Surfaces a failed "new application" notification dispatch instead of
  // swallowing it silently. Links to notifications module (NotificationsService.
  // dispatch); a quiet failure here is exactly why a recruiter sees no bell.
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectModel(Job.name) private readonly jobModel: Model<JobDocument>,
    @InjectModel(JobApplication.name)
    private readonly applicationModel: Model<JobApplicationDocument>,
    // One row per (job, viewer): dedups the employer's views stat. See getJob.
    @InjectModel(JobView.name)
    private readonly jobViewModel: Model<JobViewDocument>,
    // The candidate's private job bookmarks (saveJob / unsaveJob / listSavedJobs).
    @InjectModel(SavedJob.name)
    private readonly savedJobModel: Model<SavedJobDocument>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly allowances: ConnectAllowanceService,
    private readonly companyPages: CompanyPageService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly eventEmitter: EventEmitter2,
    // Folds category + role into the shared ConnectTag pool (same engine as a
    // listing's category / hashtags) so custom values self-register, dedupe, and
    // become searchable. See createJob.
    private readonly tagService: TagService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    // Read-only promoted-jobs resolver (ads module, Phase 5.1). Optional only so
    // the existing positional-construction unit tests still build; Nest DI always
    // provides it (ConnectJobsModule imports AdsModule which exports it). Used by
    // listPromotedForBoard; that method guards on its presence.
    @Optional()
    @Inject(JobBoostResolverService)
    private readonly jobBoosts?: JobBoostResolverService,
    // Shared media-URL ownership guard (uploads module). Enforces that an
    // apply-path voice-note / resume URL is a real file on our storage uploaded
    // by the applicant. @Optional() keeps positional unit-test constructors
    // working; Nest DI always provides it (ConnectJobsModule imports
    // MediaOwnershipModule).
    @Optional() private readonly media: MediaOwnershipService,
    // Read-path private-media decorator: turns the stored `r2-private://` refs on
    // an application (resume + apply voice note) into fresh 1h signed URLs at
    // serialize time. @Optional() for the same positional-unit-test reason.
    @Optional() private readonly privateMedia?: PrivateMediaService,
    /**
     * Over-limit suppression (grandfathering). Hides an owner's newest-beyond-
     * limit OPEN jobs from the public board / public reads under the hide_newest
     * policy; the owner still sees them in their own management views. @Optional +
     * LAST so positional unit-test constructors keep working; a no-op under freeze.
     */
    @Optional() private readonly overLimit?: ConnectOverLimitService,
    /**
     * CN-LIM-3: shared Redis mutex to serialize the open-job cap check+insert per
     * owner (closes the two-parallel-creates-at-limit-1 race). @Optional + LAST so
     * positional unit-test constructors keep working; runs inline when absent.
     * Provided globally by SchedulerModule (@Global).
     */
    @Optional() private readonly capLock?: SingleFlightService,
  ) {}

  /**
   * CN-LIM-3: run `fn` under the per-owner open-job cap mutex. Inline (no lock)
   * when the SingleFlightService isn't injected (positional unit-test constructors).
   */
  private async withJobCapLock<T>(companyUserId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.capLock) return fn();
    return this.capLock.withLock(connectCapLockKey('job', companyUserId), fn);
  }

  /**
   * Drop a single owner's over-limit-suppressed jobs (hide_newest). No-op under
   * freeze / when the service is absent. `ownerUserId` is the jobs' companyUserId.
   */
  private async dropSuppressedJobs<T extends { _id: Types.ObjectId }>(
    jobs: T[],
    ownerUserId: string,
  ): Promise<T[]> {
    if (!this.overLimit || jobs.length === 0) return jobs;
    const suppressed = new Set(await this.overLimit.getSuppressedIds(ownerUserId, 'job'));
    if (suppressed.size === 0) return jobs;
    return jobs.filter((j) => !suppressed.has(String(j._id)));
  }

  /**
   * Decorate an application's private file refs (`voiceNoteUrl`, `resumeUrl`)
   * into fresh 1-hour signed URLs. Public values / legacy URLs pass through.
   * Returns a PLAIN object with the SAME field names (mobile-app safe - only the
   * URL strings change). Accepts a lean object, a mongoose doc, or an enriched
   * view; preserves every other field via spread.
   */
  private async decorateApplication<T>(app: T): Promise<T> {
    if (!app) return app;
    const base = this.toPlain(app) as Record<string, unknown> & {
      voiceNoteUrl?: string | null;
      resumeUrl?: string | null;
    };
    if (!this.privateMedia) return base as unknown as T;
    const [voiceNoteUrl, resumeUrl] = await Promise.all([
      this.privateMedia.decorate(base.voiceNoteUrl),
      this.privateMedia.decorate(base.resumeUrl),
    ]);
    return { ...base, voiceNoteUrl, resumeUrl } as unknown as T;
  }

  /** Batch-decorate a list of applications (one signed URL per distinct ref). */
  private async decorateApplications<T>(apps: T[]): Promise<T[]> {
    const plain = apps.map((a) => this.toPlain(a)) as Array<
      Record<string, unknown> & { voiceNoteUrl?: string | null; resumeUrl?: string | null }
    >;
    if (!this.privateMedia || plain.length === 0) return plain as unknown as T[];
    const signed = await this.privateMedia.signMany(
      plain.flatMap((a) => [a.voiceNoteUrl, a.resumeUrl]),
    );
    if (signed.size === 0) return plain as unknown as T[];
    return plain.map((a) => ({
      ...a,
      voiceNoteUrl: this.privateMedia.resolve(a.voiceNoteUrl, signed),
      resumeUrl: this.privateMedia.resolve(a.resumeUrl, signed),
    })) as unknown as T[];
  }

  /** Mongoose doc -> plain object (so spreads keep only data fields); passthrough otherwise. */
  private toPlain(value: unknown): Record<string, unknown> {
    const v = value as { toObject?: () => Record<string, unknown> };
    return typeof v?.toObject === 'function' ? v.toObject() : (value as Record<string, unknown>);
  }

  /**
   * Fire-and-forget `connect.job.changed` so the search indexer keeps the
   * `connect_jobs` index warm (open jobs upserted, closed/filled dropped).
   */
  private emitJobChanged(jobId: Types.ObjectId | string, change: ConnectJobChangeType): void {
    this.eventEmitter.emit(CONNECT_JOB_CHANGED, { jobId: String(jobId), change });
  }

  // ── Company: jobs ──────────────────────────────────────────────────────

  /**
   * Demo Content scope — resolve whether a user is a seeded demo/sample account.
   * The MARKER is `User.isDemo === true` OR an `@connect-demo.zari360.test` email
   * (the seed convention). Used to (a) stamp the denormalized `isDemo` on a Job /
   * JobApplication at write time, and (b) gate cross demo<->real applications. A
   * missing user resolves to `false` (treated as real — never blocks on a lookup
   * miss). Single source so the stamp and the gate agree.
   */
  private async resolveIsDemo(userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    const user = await this.userModel
      .findById(userId)
      .select('isDemo email')
      .lean<{ isDemo?: boolean; email?: string }>()
      .exec();
    if (!user) return false;
    return user.isDemo === true || (user.email ?? '').endsWith('@connect-demo.zari360.test');
  }

  async createJob(companyUserId: string, dto: CreateJobDto): Promise<JobDocument> {
    // Demo Content scope: denormalize the owner's demo flag onto the job at create
    // (mirrors Post.authorErpLinked / Listing.isDemo) so the board down-rank +
    // the web "Sample" badge read one source.
    const isDemo = await this.resolveIsDemo(companyUserId);

    // Posting AS a company page: verify ownership (getMine 404s otherwise).
    let companyPageId: Types.ObjectId | null = null;
    if (dto.companyPageId) {
      const page = await this.companyPages.getMine(companyUserId, dto.companyPageId);
      companyPageId = page._id;
    }

    // Resolve category + role through the same tag engine as a listing's
    // category so a custom term self-registers into the shared ConnectTag pool
    // and stays canonical (the composer suggests from this pool via
    // /connect/tags/search). Fall back to trim+lowercase if the tag engine
    // returns nothing. recordUsage is fire-and-forget (popularity ranking).
    const [categorySlug] = await this.tagService.normalizeHashtags([dto.category]);
    const category = categorySlug ?? dto.category.trim().toLowerCase();
    let role: string | null = null;
    let roleSlug: string | undefined;
    if (dto.role) {
      [roleSlug] = await this.tagService.normalizeHashtags([dto.role]);
      role = roleSlug ?? dto.role.trim().toLowerCase();
    }

    // Job video(s): same media-ownership guard on url + posterUrl, plus the
    // server-derived duration stamped on each clip (see buildOwnedVideos). Empty
    // when none submitted, so a video-less job is unchanged. Mirrors listing.
    const videos = await this.buildOwnedVideos(dto.videos, companyUserId);

    // CN-LIM-3 critical section: (re-)count OPEN jobs, assert the cap, and insert
    // under the per-owner mutex. Cap is on OPEN jobs (close one to free a slot, or
    // upgrade). Counting INSIDE the lock closes the race: a second concurrent
    // create blocks, re-reads the incremented open count, and is rejected at the
    // cap. The pre-persist resolution (isDemo, company-page ownership, tags,
    // videos) stays outside the lock so the held section is a single count+insert.
    const job = await this.withJobCapLock(companyUserId, async () => {
      const openCount = await this.jobModel.countDocuments({
        companyUserId: new Types.ObjectId(companyUserId),
        status: 'open',
      });
      await this.allowances.assertCanCreateJob(companyUserId, openCount);

      return this.jobModel.create({
        companyUserId: new Types.ObjectId(companyUserId),
        companyPageId,
        title: dto.title,
        description: dto.description ?? '',
        responsibilities: dto.responsibilities ?? [],
        category,
        wageType: dto.wageType ?? null,
        wageMin: dto.wageMin ?? null,
        wageMax: dto.wageMax ?? null,
        openings: dto.openings ?? 1,
        location: dto.location ?? {},
        role,
        skills: dto.skills ?? [],
        machineType: dto.machineType ?? '',
        employmentType: dto.employmentType ?? null,
        experienceMin: dto.experienceMin ?? null,
        shift: dto.shift ?? null,
        workingDays: dto.workingDays ?? '',
        languages: dto.languages ?? [],
        benefits: dto.benefits ?? [],
        videos,
        closesAt: dto.closesAt ? new Date(dto.closesAt) : null,
        status: 'open',
        applicationsCount: 0,
        isDemo,
      });
    });

    // Record popularity for the resolved canonical slugs (best-effort).
    const recordSlugs = [categorySlug, roleSlug].filter(Boolean);
    if (recordSlugs.length) void this.tagService.recordUsage(recordSlugs, companyUserId);

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Job',
      entityId: String(job._id),
      action: 'job_created',
      actorId: companyUserId,
      meta: { category, role, companyPageId: companyPageId ? String(companyPageId) : null },
    });
    this.posthog?.capture({
      distinctId: companyUserId,
      event: 'connect.job_created',
      properties: { jobId: String(job._id), category, role },
    });
    this.emitJobChanged(job._id, 'created');
    return job;
  }

  /**
   * The public-to-members board. Supports the filter rail (category / wageType /
   * district / role / skills / pay / posted), sort, text search and paging. A
   * bare call returns open jobs newest-first (prior behaviour preserved).
   */
  async listBoard(query: BoardQueryDto = {}): Promise<Job[]> {
    const filter = buildBoardFilter(query, new Date()) as FilterQuery<Job>;
    const limit = query.limit ?? 50;
    const skip = query.skip ?? 0;
    const jobs = await this.jobModel
      .find(filter)
      .sort(buildBoardSort(query.sort))
      .skip(skip)
      .limit(limit)
      .lean<Job[]>()
      .exec();
    // Over-limit suppression: drop owners' newest-beyond-limit open jobs from the
    // public board (hide_newest). Post-filter so the index/query stay drift-free;
    // a no-op under the default freeze policy.
    if (!this.overLimit) return jobs;
    return this.overLimit.filterSuppressed(
      jobs,
      'job',
      (j) => String(j.companyUserId),
      (j) => String(j._id),
    );
  }

  /**
   * The board's read-only "Promoted" block (Phase 5.1). Returns up to `limit`
   * currently-boosted jobs to pin above the organic stream.
   *
   * READ-ONLY + NON-BILLING: it asks the ads resolver
   * (JobBoostResolverService.resolveActiveJobBoosts) for the active boost jobRefs,
   * then loads those Job docs. It NEVER opens an ad impression, debits the wallet,
   * or calls AdDecisionService.decide (which bills + single-winner). Any
   * impression billing for promoted jobs lives on a separate beacon path.
   *
   * Excludes:
   *   - any job whose `status !== 'open'` (a boost may outlive the job being
   *     closed/filled; we must never surface a closed job in the promoted block).
   *   - any job that does NOT match the active board filter (buildBoardFilter):
   *     a promoted job that falls outside the viewer's current filters is omitted,
   *     so the block stays consistent with the organic results.
   *
   * Resolver order is preserved (newest boost first), then capped to `limit`.
   * Cross-module: ads (JobBoostResolverService) -> jobs board web PromotedJobs.
   */
  async listPromotedForBoard(query: BoardQueryDto = {}, limit = 3): Promise<Job[]> {
    if (!this.jobBoosts) {
      // Never under Nest DI (AdsModule is imported); guarded only because the
      // resolver is an @Optional() constructor param for positional unit tests.
      return [];
    }
    const cap = Math.max(0, Math.floor(limit));
    if (cap === 0) return [];

    // Ask for a few extra so post-filtering (closed / non-matching) still has a
    // chance to fill the cap; resolver caps internally too.
    const refs = await this.jobBoosts.resolveActiveJobBoosts(cap * 3);
    if (refs.length === 0) return [];

    const ids = refs.map((r) => new Types.ObjectId(r.jobId));
    const now = new Date();
    // Same filter the organic board uses, AND-ed with the boosted id set. The
    // filter already pins status:'open' (includeFilled is ignored for promoted),
    // so a closed/filled boosted job is dropped here; we also force 'open'
    // explicitly so an includeFilled query can never leak a filled promoted job.
    const filter = {
      ...(buildBoardFilter(query, now) as FilterQuery<Job>),
      status: 'open',
      _id: { $in: ids },
    } as FilterQuery<Job>;

    const matchedRaw = await this.jobModel.find(filter).lean<Job[]>().exec();
    // A suppressed (over-limit) job is hidden from public surfaces even when
    // boosted (hide_newest); no-op under freeze.
    const matched = this.overLimit
      ? await this.overLimit.filterSuppressed(
          matchedRaw,
          'job',
          (j) => String(j.companyUserId),
          (j) => String(j._id),
        )
      : matchedRaw;

    // Preserve resolver (newest-boost-first) order, then cap. A Map keyed by id
    // gives O(1) lookup while we walk refs in order.
    const byId = new Map(matched.map((j) => [String((j as { _id: unknown })._id), j]));
    const ordered: Job[] = [];
    for (const ref of refs) {
      const job = byId.get(ref.jobId);
      if (job) ordered.push(job);
      if (ordered.length >= cap) break;
    }
    return ordered;
  }

  /**
   * Facet counts for the filter rail. One `$facet` aggregation: a `total` branch
   * (all active filters) + one branch per facet whose `$match` is the active
   * filter set MINUS that facet's own field, then `$sortByCount` + top-50 cap.
   *
   * Cross-module: feeds the web rail (jobs.actions.getJobBoardFacets ->
   * JobFilterRail counts); the per-facet filter is built by the SAME
   * buildBoardFilter the board list uses, so counts and results never diverge.
   *
   * Gotcha: "minus own field" must clear BOTH the plural and singular form of a
   * facet (e.g. dropping the district facet means dropping districts + district),
   * else its own selection would constrain its own counts to a single value.
   */
  async boardFacets(query: BoardFacetsQueryDto): Promise<JobBoardFacets> {
    const now = new Date();

    // Rebuild the filter with one facet's field(s) removed. Both the plural csv
    // param and its singular sibling are cleared so the facet's own selection
    // does not narrow its own bucket list.
    const omit = (...fields: (keyof BoardFacetsQueryDto)[]): Record<string, unknown> => {
      const q = { ...query };
      for (const f of fields) delete (q as Record<string, unknown>)[f as string];
      return buildBoardFilter(q, now);
    };
    // Common tail for every facet branch: rank by frequency, cap the list size.
    const countStage = (path: string) => [{ $sortByCount: `$${path}` }, { $limit: 50 }];

    const [res] = await this.jobModel.aggregate([
      {
        $facet: {
          // total keeps ALL active filters (the "Showing N jobs" number).
          total: [{ $match: buildBoardFilter(query, now) }, { $count: 'n' }],
          district: [{ $match: omit('districts', 'district') }, ...countStage('location.district')],
          role: [{ $match: omit('roles', 'role') }, ...countStage('role')],
          employmentType: [
            { $match: omit('employmentTypes', 'employmentType') },
            ...countStage('employmentType'),
          ],
          machineType: [{ $match: omit('machineTypes') }, ...countStage('machineType')],
          // skills is an array field: unwind before counting per-skill.
          skill: [{ $match: omit('skills') }, { $unwind: '$skills' }, ...countStage('skills')],
          wageType: [{ $match: omit('wageType') }, ...countStage('wageType')],
        },
      },
    ]);

    return this.shapeFacets(res ?? {}, query);
  }

  /**
   * Map the raw $facet output to the FacetEntry shape: {_id,count} -> {value,count},
   * drop the null `_id` bucket (jobs with no value for that field), and UNION-IN
   * any currently-selected value missing from its facet so a selected filter never
   * disappears from the rail. A missing selected value is added at count 0 (we do
   * NOT issue a follow-up countDocuments per value - the rail only needs it present
   * and unselectable-from; an out-of-top-50 selection showing 0 is acceptable).
   */
  private shapeFacets(
    res: Record<string, RawBucket[]>,
    query: BoardFacetsQueryDto,
  ): JobBoardFacets {
    const totalBucket = (res.total?.[0] as unknown as { n?: number } | undefined)?.n ?? 0;

    const map = (buckets: RawBucket[] = []): FacetEntry[] =>
      buckets
        .filter((b) => b._id != null && b._id !== '')
        .map((b) => ({ value: String(b._id), count: b.count }));

    // Selected values for a facet = the csv plural param plus its singular form.
    const selectedOf = (...fields: (keyof BoardFacetsQueryDto)[]): string[] => {
      const out: string[] = [];
      for (const f of fields) {
        const v = query[f];
        if (typeof v === 'string') {
          for (const t of v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean))
            out.push(t);
        }
      }
      return out;
    };

    // Append any selected value absent from the mapped facet (case-insensitive
    // for the free-text facets so "varachha" matches a bucket of "Varachha").
    const unionSelected = (
      entries: FacetEntry[],
      selected: string[],
      caseInsensitive = false,
    ): FacetEntry[] => {
      const present = new Set(
        entries.map((e) => (caseInsensitive ? e.value.toLowerCase() : e.value)),
      );
      for (const sel of selected) {
        const key = caseInsensitive ? sel.toLowerCase() : sel;
        if (!present.has(key)) {
          entries.push({ value: sel, count: 0 });
          present.add(key);
        }
      }
      return entries;
    };

    return {
      total: totalBucket,
      district: unionSelected(map(res.district), selectedOf('districts', 'district'), true),
      role: unionSelected(map(res.role), selectedOf('roles', 'role')),
      employmentType: unionSelected(
        map(res.employmentType),
        selectedOf('employmentTypes', 'employmentType'),
      ),
      machineType: unionSelected(map(res.machineType), selectedOf('machineTypes'), true),
      skill: unionSelected(map(res.skill), selectedOf('skills')),
      wageType: unionSelected(map(res.wageType), selectedOf('wageType')),
    };
  }

  /** Headline counts for the board KPI strip (real numbers, never faked). */
  async boardStats(): Promise<{ openTotal: number; newToday: number }> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [openTotal, newToday] = await Promise.all([
      this.jobModel.countDocuments({ status: 'open' }),
      this.jobModel.countDocuments({ status: 'open', createdAt: { $gte: startOfToday } }),
    ]);
    return { openTotal, newToday };
  }

  /** A person's own posted jobs, newest first. */
  async listMine(companyUserId: string): Promise<Job[]> {
    return this.jobModel
      .find({ companyUserId: new Types.ObjectId(companyUserId) })
      .sort({ createdAt: -1 })
      .lean<Job[]>()
      .exec();
  }

  /**
   * A person OPEN jobs for their public profile Hiring card. Person-centric:
   * keyed on companyUserId (the owning User), status 'open' only, newest first.
   * Returns count + total applicants + the job cards so the profile renders
   * "N roles, M applicants" and links to apply. Cross-module: read by the web
   * profile IntentCards via GET connect/jobs/by-user/:userId/open.
   * Guards a malformed id (a bad profile slug) with an empty tally so a
   * logged-out visitor never hits a 500.
   */
  async listOpenJobsByUser(
    userId: string,
  ): Promise<{ count: number; applicants: number; jobs: Job[] }> {
    if (!Types.ObjectId.isValid(userId)) return { count: 0, applicants: 0, jobs: [] };
    const found = await this.jobModel
      .find({ companyUserId: new Types.ObjectId(userId), status: 'open' })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean<Job[]>()
      .exec();
    // Public profile read → hide the owner's suppressed open jobs (hide_newest).
    const jobs = await this.dropSuppressedJobs(found, userId);
    const applicants = jobs.reduce((s, j) => s + (j.applicationsCount ?? 0), 0);
    return { count: jobs.length, applicants, jobs };
  }

  /** A company page's public open jobs (the page Jobs tab; logged-out OK). */
  async listByCompanyPage(companyPageId: string): Promise<Job[]> {
    if (!Types.ObjectId.isValid(companyPageId)) return [];
    const jobs = await this.jobModel
      .find({ companyPageId: new Types.ObjectId(companyPageId), status: 'open' })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<Job[]>()
      .exec();
    // Public page Jobs tab → hide the owner's suppressed open jobs (hide_newest).
    if (!this.overLimit) return jobs;
    return this.overLimit.filterSuppressed(
      jobs,
      'job',
      (j) => String(j.companyUserId),
      (j) => String(j._id),
    );
  }

  /**
   * The OWNER's full job history for one company page - ALL statuses (open /
   * filled / closed), newest first. Private: getMine 404s a page the caller does
   * not own (no existence leak), so only the page owner sees closed/filled jobs.
   * Powers the manage console Jobs tab (history + page-scoped management); the
   * public `listByCompanyPage` above stays open-only.
   */
  async listByCompanyPageForOwner(companyUserId: string, companyPageId: string): Promise<Job[]> {
    await this.companyPages.getMine(companyUserId, companyPageId);
    return this.jobModel
      .find({ companyPageId: new Types.ObjectId(companyPageId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<Job[]>()
      .exec();
  }

  async getJob(jobId: string, viewerId?: string): Promise<Job> {
    const job = Types.ObjectId.isValid(jobId)
      ? await this.jobModel.findById(jobId).lean<Job>().exec()
      : null;
    if (!job) throw new NotFoundException('Job not found');
    // Over-limit suppression: a suppressed open job reads as not-found to the
    // public (hide_newest), but the OWNER always sees their own job. No-op under
    // freeze. Owner check first so we skip the suppression lookup for the owner.
    const isOwner = viewerId !== undefined && String(job.companyUserId) === viewerId;
    if (this.overLimit && !isOwner) {
      const suppressed = await this.overLimit.getSuppressedIds(String(job.companyUserId), 'job');
      if (suppressed.includes(String(job._id))) throw new NotFoundException('Job not found');
    }
    // Count DISTINCT non-owner viewers, not raw page hits. Try to insert one
    // (job, viewer) row; only a brand-new row (first time this viewer ever
    // opened the job) increments the stat. A refresh / back-nav / router.refresh
    // hits the unique {jobId, viewerId} index and is a no-op, so the number can
    // never inflate. Owner views never count; logged-out views have no viewerId
    // to dedup on, so they are not counted. See job-view.schema.ts.
    if (viewerId && String(job.companyUserId) !== viewerId) {
      void this.recordUniqueView(job._id, viewerId);
    }
    return job;
  }

  /**
   * Public single-job read for the logged-out web `/jobs/[id]` page + crawlers.
   * Returns ONLY an OPEN job (the same Job shape the authed reads return, no
   * applicant data); throws NotFound for a missing id, a non-open (closed /
   * filled) job, OR an over-limit-suppressed open job (hide_newest) - exactly
   * like a suppressed listing 404s on its public detail route, so a crawler can
   * never index a job that is off the public board. No viewer, so no view-stat
   * side effect (logged-out views were never counted anyway). Cross-module:
   * served by @Public GET /connect/jobs/public/:id.
   */
  async getPublicJob(jobId: string): Promise<Job> {
    const job = Types.ObjectId.isValid(jobId)
      ? await this.jobModel.findById(jobId).lean<Job>().exec()
      : null;
    // Not-found OR not-open both read as 404 to the public (the job is not on the
    // board), so closed / filled jobs stay invisible to crawlers.
    if (!job || job.status !== 'open') throw new NotFoundException('Job not found');
    // An open-but-suppressed job (over-limit hide_newest) is also invisible to the
    // public. No-op under the default freeze policy / when the service is absent.
    if (this.overLimit) {
      const suppressed = await this.overLimit.getSuppressedIds(String(job.companyUserId), 'job');
      if (suppressed.includes(String(job._id))) throw new NotFoundException('Job not found');
    }
    return job;
  }

  /**
   * Idempotently record a (job, viewer) view and bump `Job.views` ONLY on the
   * first view by that viewer. The unique {jobId, viewerId} index makes the
   * insert the dedup gate: a duplicate insert throws E11000 (code 11000), which
   * we swallow (the viewer has been counted before). Any other error is also
   * swallowed -- a view-stat hiccup must never break the page load. Fire-and-
   * forget from getJob.
   */
  private async recordUniqueView(jobId: Types.ObjectId, viewerId: string): Promise<void> {
    try {
      await this.jobViewModel.create({ jobId, viewerId: new Types.ObjectId(viewerId) });
      // New row only: this is the viewer's first view, so it counts once.
      await this.jobModel.updateOne({ _id: jobId }, { $inc: { views: 1 } }).exec();
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code !== 11000) {
        // 11000 = already viewed (expected, no-op). Log anything unexpected.
        this.logger.warn(
          `recordUniqueView failed for job ${String(jobId)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Edit an OPEN job the caller owns (PATCH - only provided fields change). An
   * edited category/role is folded through the shared tag pool exactly like
   * createJob, so a custom value still self-registers + stays canonical.
   * Closed/filled jobs are immutable (re-post instead). Re-emits job.changed so
   * the search index re-reads. Web: jobs.actions.updateJob -> PATCH
   * /connect/jobs/:id; the company page + board reflect on router.refresh.
   */
  async updateJob(companyUserId: string, jobId: string, dto: UpdateJobDto): Promise<JobDocument> {
    const job = await this.loadOwnedJob(companyUserId, jobId);
    if (job.status !== 'open') {
      throw new BadRequestException('Only an open job can be edited');
    }

    const recordSlugs: string[] = [];
    if (dto.title !== undefined) job.title = dto.title;
    if (dto.description !== undefined) job.description = dto.description;
    if (dto.responsibilities !== undefined) job.responsibilities = dto.responsibilities;
    if (dto.category !== undefined) {
      const [slug] = await this.tagService.normalizeHashtags([dto.category]);
      job.category = slug ?? dto.category.trim().toLowerCase();
      if (slug) recordSlugs.push(slug);
    }
    if (dto.role !== undefined) {
      const [slug] = await this.tagService.normalizeHashtags([dto.role]);
      job.role = slug ?? dto.role.trim().toLowerCase();
      if (slug) recordSlugs.push(slug);
    }
    if (dto.wageType !== undefined) job.wageType = dto.wageType;
    if (dto.wageMin !== undefined) job.wageMin = dto.wageMin;
    if (dto.wageMax !== undefined) job.wageMax = dto.wageMax;
    if (dto.openings !== undefined) job.openings = dto.openings;
    if (dto.location !== undefined) job.location = dto.location;
    if (dto.skills !== undefined) job.skills = dto.skills;
    if (dto.machineType !== undefined) job.machineType = dto.machineType;
    if (dto.employmentType !== undefined) job.employmentType = dto.employmentType;
    if (dto.experienceMin !== undefined) job.experienceMin = dto.experienceMin;
    if (dto.shift !== undefined) job.shift = dto.shift;
    if (dto.workingDays !== undefined) job.workingDays = dto.workingDays;
    if (dto.languages !== undefined) job.languages = dto.languages;
    if (dto.benefits !== undefined) job.benefits = dto.benefits;
    // Videos are stamped (server duration) + ownership-checked here, NOT in the
    // generic field loop. The job's existing clip is grandfathered (its
    // url/posterUrl predate this edit), so only a newly-added clip needs an
    // ownership record. An omitted `videos` leaves the existing one untouched;
    // `videos: []` clears it. Mirrors listing update.
    if (dto.videos !== undefined) {
      job.videos = await this.buildOwnedVideos(dto.videos, companyUserId, job.videos);
    }
    if (dto.closesAt !== undefined) job.closesAt = new Date(dto.closesAt);

    await job.save();
    if (recordSlugs.length) void this.tagService.recordUsage(recordSlugs, companyUserId);

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Job',
      entityId: jobId,
      action: 'job_updated',
      actorId: companyUserId,
    });
    this.posthog?.capture({
      distinctId: companyUserId,
      event: 'connect.job_updated',
      properties: { jobId },
    });
    this.emitJobChanged(job._id, 'updated');
    return job;
  }

  /**
   * Take an open job off the board. `filled` captures the hiring OUTCOME at close
   * time (the LinkedIn / Indeed / ATS pattern): true -> the role was filled
   * (someone hired, on- or off-platform), false -> just closed (no hire). Filled
   * is also set automatically by `acceptApplication` when an applicant is hired
   * through the platform; this gives the owner the same terminal state when they
   * hire off-platform or never used Accept. Both outcomes leave the open board, so
   * the search index drops the job either way.
   */
  async closeJob(companyUserId: string, jobId: string, filled = false): Promise<JobDocument> {
    const job = await this.loadOwnedJob(companyUserId, jobId);
    job.status = filled ? 'filled' : 'closed';
    await job.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Job',
      entityId: jobId,
      action: filled ? 'job_filled' : 'job_closed',
      actorId: companyUserId,
    });
    this.posthog?.capture({
      distinctId: companyUserId,
      event: filled ? 'connect.job_filled' : 'connect.job_closed',
      properties: { jobId },
    });
    this.emitJobChanged(jobId, 'closed');
    return job;
  }

  // ── Karigar: applications ──────────────────────────────────────────────

  /** Apply to (or update an application on) an open job. One per worker per job. */
  async applyToJob(
    applicantUserId: string,
    jobId: string,
    dto: CreateJobApplicationDto,
  ): Promise<JobApplicationDocument> {
    const job = Types.ObjectId.isValid(jobId) ? await this.jobModel.findById(jobId) : null;
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'open') throw new BadRequestException('This job is no longer open');
    if (String(job.companyUserId) === applicantUserId) {
      throw new BadRequestException('You cannot apply to your own job');
    }

    // Demo Content scope — interaction gate. Keep the sample world and the real
    // world apart: a real worker must not apply to a sample job, and a sample
    // worker must not land in a real employer's inbox. Demo<->demo stays allowed
    // (so the seeded demo is self-consistent). The job's denormalized `isDemo`
    // (stamped at create) is the company side; resolve the applicant's flag now.
    // A demo-involved application is also kept OUT of the real notification +
    // applicantsCount path below, so a real recruiter never sees a sample
    // applicant or a bumped count from one.
    const applicantIsDemo = await this.resolveIsDemo(applicantUserId);
    const jobIsDemo = job.isDemo === true;
    const demoInvolved = applicantIsDemo || jobIsDemo;
    if (demoInvolved && applicantIsDemo !== jobIsDemo) {
      throw new BadRequestException(
        'This is sample content shown while the community grows — it cannot receive real applications.',
      );
    }

    const existing = await this.applicationModel.findOne({
      jobId: job._id,
      applicantUserId: new Types.ObjectId(applicantUserId),
    });

    // Private files now come back to the client as short-lived SIGNED URLs, so a
    // re-apply (edit) without re-uploading resubmits a signed URL. Collapse any
    // such value back to its canonical `r2-private://` ref BEFORE validate + store
    // so grandfathering matches and we never persist an expiring URL. A fresh
    // upload already submits the canonical ref, so this is a no-op for it.
    const voiceNoteRef =
      this.privateMedia?.normalizeIncomingRef(dto.voiceNoteUrl) ?? dto.voiceNoteUrl;
    const resumeRef = this.privateMedia?.normalizeIncomingRef(dto.resumeUrl) ?? dto.resumeUrl;

    // Enforce media ownership via the shared media-ownership guard: the submitted
    // voice-note / resume refs must be real files on our storage uploaded by this
    // applicant. On re-apply, the refs already stored on the existing application
    // are grandfathered (they predate ownership tracking / were already accepted),
    // so editing the message without re-uploading does not re-trip the check.
    await this.media.assertOwnedMedia([voiceNoteRef, resumeRef], applicantUserId, {
      grandfatheredUrls: [existing?.voiceNoteUrl, existing?.resumeUrl],
    });

    let application: JobApplicationDocument;
    let isNew = false;
    if (existing) {
      existing.message = dto.message ?? '';
      existing.voiceNoteUrl = voiceNoteRef ?? null;
      existing.resumeUrl = resumeRef ?? null;
      existing.resumeName = dto.resumeName ?? '';
      existing.status = 'applied';
      application = await existing.save();
    } else {
      application = await this.applicationModel.create({
        jobId: job._id,
        applicantUserId: new Types.ObjectId(applicantUserId),
        message: dto.message ?? '',
        voiceNoteUrl: voiceNoteRef ?? null,
        resumeUrl: resumeRef ?? null,
        resumeName: dto.resumeName ?? '',
        status: 'applied',
        // Demo Content scope: stamp the applicant's demo flag (mirrors Job.isDemo).
        isDemo: applicantIsDemo,
      });
      // Demo Content scope: a demo<->demo application stays out of the real
      // applicantsCount stat (the count an employer sees stays honest about real
      // applicants). Cross demo<->real already threw above, so `demoInvolved`
      // here means demo<->demo only.
      if (!demoInvolved) {
        await this.jobModel.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });
      }
      isNew = true;
    }

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'JobApplication',
      entityId: String(application._id),
      action: isNew ? 'job_application_created' : 'job_application_updated',
      actorId: applicantUserId,
      meta: { jobId },
    });
    this.posthog?.capture({
      distinctId: applicantUserId,
      event: 'connect.job_application_created',
      properties: { jobId, applicationId: String(application._id) },
    });

    // Notify the company on a NEW application (a repeat edit stays quiet).
    // Demo Content scope: a demo-involved application never dispatches the real
    // notification (a real recruiter must never get a sample-applicant bell, and
    // a seeded demo employer needs no live alert).
    if (isNew && !demoInvolved) {
      const applicant = await this.userModel
        .findById(applicantUserId)
        .select('name')
        .lean<{ name?: string }>()
        .exec();
      const name = applicant?.name?.trim() || 'Someone';
      void this.notifications
        .dispatch({
          recipientId: job.companyUserId,
          actorId: new Types.ObjectId(applicantUserId),
          category: 'connect.job_application_received',
          entityType: 'Job',
          entityId: String(job._id),
          title: 'New application',
          message: `${name} applied for "${job.title}".`,
        })
        .catch((err: unknown) =>
          // Do NOT silently swallow: a failed dispatch is precisely why the
          // recruiter would "get no notifications". Log it so it is visible in
          // BE logs (the application itself already succeeded above).
          this.logger.error(
            `Failed to dispatch job_application_received for job ${String(job._id)} -> recipient ${String(job.companyUserId)}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    // Sign the applicant's just-submitted private file refs so their own apply
    // confirmation can play / open them.
    return this.decorateApplication(application);
  }

  /** The company's view of all applications on their job (owner-only). */
  async listApplicationsForMyJob(companyUserId: string, jobId: string): Promise<JobApplication[]> {
    await this.loadOwnedJob(companyUserId, jobId);
    const jid = new Types.ObjectId(jobId);
    // Stamp viewedAt on first sight: the employer is opening their applicant list,
    // so any not-yet-seen application is now "Viewed" by them. This is the REAL
    // signal the applicant's "Viewed" badge reads (listMyApplications surfaces it).
    // Fire-and-forget-safe but awaited so a same-request re-read is consistent.
    await this.applicationModel
      .updateMany({ jobId: jid, viewedAt: null }, { $set: { viewedAt: new Date() } })
      .exec();
    const rows = await this.applicationModel
      .find({ jobId: jid })
      .sort({ createdAt: -1 })
      // DoS backstop: a job's applicant list grows with other users' applications.
      // The cap is far above any realistic applicant count (the FE hiring funnel
      // reads this set); a job that ever hits it should move to keyset paging.
      .limit(LIST_HARD_CAP)
      .lean<JobApplication[]>()
      .exec();
    // Sign each applicant's private resume / voice refs (batched) for the employer.
    return this.decorateApplications(rows as unknown as Array<Record<string, unknown>>) as Promise<
      JobApplication[]
    >;
  }

  /** A worker's own applications, newest first, ENRICHED with the job snapshot
   *  (title, role for the icon, location) + the employer display name (company-page
   *  name when posted as a page, else the poster's person name) so the My
   *  applications list can render job-centric cards without an N+1 from the web.
   *  viewedAt rides along (employer-seen signal). Cross-module: web JobBoard My
   *  applications tab + MyApplicationCard. */
  async listMyApplications(applicantUserId: string): Promise<MyApplicationView[]> {
    const apps = await this.applicationModel
      .find({ applicantUserId: new Types.ObjectId(applicantUserId) })
      .sort({ createdAt: -1 })
      .lean<JobApplication[]>()
      .exec();
    if (apps.length === 0) return [];

    const jobIds = [...new Set(apps.map((a) => String(a.jobId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const jobs = await this.jobModel
      .find({ _id: { $in: jobIds } })
      .select('title role location companyUserId companyPageId')
      .lean<
        Array<{
          _id: Types.ObjectId;
          title: string;
          role?: string | null;
          location?: { district?: string; state?: string } | null;
          companyUserId: Types.ObjectId;
          companyPageId?: Types.ObjectId | null;
        }>
      >()
      .exec();
    const jobById = new Map(jobs.map((j) => [String(j._id), j]));

    // Resolve employer display names: page name (companyPageId) or person name.
    const pageIds = [
      ...new Set(jobs.filter((j) => j.companyPageId).map((j) => String(j.companyPageId))),
    ];
    const personIds = [
      ...new Set(jobs.filter((j) => !j.companyPageId).map((j) => String(j.companyUserId))),
    ].map((id) => new Types.ObjectId(id));
    const pageRefs = pageIds.length ? await this.companyPages.getRefs(pageIds) : [];
    const pageNameById = new Map(pageRefs.map((r) => [r.id, r.name]));
    const persons = personIds.length
      ? await this.userModel
          .find({ _id: { $in: personIds } })
          .select('name')
          .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
          .exec()
      : [];
    const personNameById = new Map(persons.map((p) => [String(p._id), p.name ?? '']));

    const views = apps.map((a) => {
      const job = jobById.get(String(a.jobId)) ?? null;
      const employerName = job
        ? job.companyPageId
          ? (pageNameById.get(String(job.companyPageId)) ?? '')
          : (personNameById.get(String(job.companyUserId)) ?? '')
        : '';
      return {
        ...a,
        job: job
          ? {
              id: String(job._id),
              title: job.title,
              role: job.role ?? null,
              location: job.location ?? null,
            }
          : null,
        employer: { name: employerName },
      };
    });
    // Sign the applicant's own private resume / voice refs (batched).
    return this.decorateApplications(views as unknown as Array<Record<string, unknown>>) as Promise<
      MyApplicationView[]
    >;
  }

  // ── Saved (bookmarked) jobs ─────────────────────────────────────────────
  // Private per-user bookmarks (mirrors the feed SavedPost pattern). Web: the
  // bookmark control on the job detail hero + the board's "Saved" filter.

  /** Save (bookmark) a job for the caller. Idempotent (unique {userId, jobId}
   *  index dedups a double-tap). 404s on a missing job so Saved never dangles. */
  async saveJob(userId: string, jobId: string): Promise<{ saved: boolean }> {
    if (!Types.ObjectId.isValid(jobId)) throw new NotFoundException('Job not found');
    const exists = await this.jobModel.exists({ _id: new Types.ObjectId(jobId) });
    if (!exists) throw new NotFoundException('Job not found');
    await this.savedJobModel
      .updateOne(
        { userId: new Types.ObjectId(userId), jobId: new Types.ObjectId(jobId) },
        { $setOnInsert: { userId: new Types.ObjectId(userId), jobId: new Types.ObjectId(jobId) } },
        { upsert: true },
      )
      .exec();
    return { saved: true };
  }

  /** Un-save a job for the caller. Tolerates a missing bookmark (a no-op). */
  async unsaveJob(userId: string, jobId: string): Promise<{ saved: boolean }> {
    if (!Types.ObjectId.isValid(jobId)) throw new NotFoundException('Job not found');
    await this.savedJobModel
      .deleteOne({ userId: new Types.ObjectId(userId), jobId: new Types.ObjectId(jobId) })
      .exec();
    return { saved: false };
  }

  /** The caller's saved jobs, newest-saved first. Drops bookmarks whose job was
   *  since deleted (Saved never holds a dangling row). */
  async listSavedJobs(userId: string): Promise<Job[]> {
    const rows = await this.savedJobModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<{ jobId: Types.ObjectId }[]>()
      .exec();
    const ids = rows.map((r) => r.jobId);
    if (ids.length === 0) return [];
    const jobs = await this.jobModel
      .find({ _id: { $in: ids } })
      .lean<Job[]>()
      .exec();
    // Preserve the save-order (newest-saved first); jobModel.find ignores it.
    const byId = new Map(jobs.map((j) => [String(j._id), j]));
    return ids.map((id) => byId.get(String(id))).filter((j): j is Job => Boolean(j));
  }

  /** Company shortlists or declines an application (owner-only). */
  async setApplicationStatus(
    companyUserId: string,
    applicationId: string,
    status: 'shortlisted' | 'declined',
  ): Promise<JobApplicationDocument> {
    const { application } = await this.loadOwnedApplication(companyUserId, applicationId);
    application.status = status;
    await application.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'JobApplication',
      entityId: applicationId,
      action: status === 'declined' ? 'job_application_declined' : 'job_application_shortlisted',
      actorId: companyUserId,
    });
    this.posthog?.capture({
      distinctId: companyUserId,
      event:
        status === 'declined'
          ? 'connect.job_application_declined'
          : 'connect.job_application_shortlisted',
      properties: { jobId: String(application.jobId), applicationId },
    });
    if (status === 'declined') {
      void this.notifyApplicant(
        application,
        'connect.job_application_declined',
        'Application update',
      );
    }
    return this.decorateApplication(application);
  }

  /** Company accepts an application -> applicant accepted + the job is filled. */
  async acceptApplication(
    companyUserId: string,
    applicationId: string,
  ): Promise<JobApplicationDocument> {
    const { application, job } = await this.loadOwnedApplication(companyUserId, applicationId);
    application.status = 'accepted';
    await application.save();
    await this.jobModel.updateOne({ _id: job._id }, { $set: { status: 'filled' } });
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'JobApplication',
      entityId: applicationId,
      action: 'job_application_accepted',
      actorId: companyUserId,
    });
    this.posthog?.capture({
      distinctId: companyUserId,
      event: 'connect.job_application_accepted',
      properties: { jobId: String(job._id), applicationId },
    });
    void this.notifyApplicant(
      application,
      'connect.job_application_accepted',
      'Application accepted',
    );
    // The job is now filled -> drop it from the open-jobs search index.
    this.emitJobChanged(job._id, 'closed');
    return this.decorateApplication(application);
  }

  /** Applicant withdraws their own application. */
  async withdrawApplication(
    applicantUserId: string,
    applicationId: string,
  ): Promise<JobApplicationDocument> {
    const application = Types.ObjectId.isValid(applicationId)
      ? await this.applicationModel.findById(applicationId)
      : null;
    if (!application || String(application.applicantUserId) !== applicantUserId) {
      throw new NotFoundException('Application not found');
    }
    const wasActive = application.status !== 'withdrawn';
    application.status = 'withdrawn';
    await application.save();
    // Keep the employer-facing applicant count honest (apply does +1). Guarded
    // so a repeat withdraw can't double-decrement and the count never goes < 0.
    if (wasActive) {
      await this.jobModel.updateOne(
        { _id: application.jobId, applicationsCount: { $gt: 0 } },
        { $inc: { applicationsCount: -1 } },
      );
    }
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'JobApplication',
      entityId: applicationId,
      action: 'job_application_withdrawn',
      actorId: applicantUserId,
    });
    this.posthog?.capture({
      distinctId: applicantUserId,
      event: 'connect.job_application_withdrawn',
      properties: { jobId: String(application.jobId), applicationId },
    });
    return this.decorateApplication(application);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Resolve the job's video(s) to the persisted shape, ownership-checked + with a
   * SERVER-derived `durationSec` stamped on each clip. Copied verbatim from
   * marketplace ListingService.buildOwnedVideos: each submitted url/posterUrl must
   * be a file THIS user uploaded (shared media-ownership guard), then each clip's
   * `durationSec` comes from the SERVER-parsed duration on the owned upload record
   * (never a client claim; the 60s cap is enforced in the upload media-probe, NOT
   * here). Empty input -> empty result (clears the video on an explicit `videos: []`
   * patch).
   *
   * `grandfatheredVideos` (update path) exempts a clip already on the job from the
   * ownership-RECORD check (its url/posterUrl were accepted before this edit);
   * format/host checks still apply to every url.
   *
   * Cross-module link: mirrors marketplace/services/listing.service.ts. Gotcha:
   * `this.media` is an @Optional() ctor param (positional unit tests), so the
   * video paths are only reachable when MediaOwnershipModule is wired (it is).
   */
  private async buildOwnedVideos(
    videos: Array<{ url: string; posterUrl?: string }> | undefined,
    ownerUserId: string,
    grandfatheredVideos?: Array<{ url: string; posterUrl?: string }>,
  ): Promise<Array<{ url: string; posterUrl?: string; durationSec?: number }>> {
    if (!videos || videos.length === 0) return [];
    // Flatten clip url + poster url for the batched ownership check (the guard
    // skips empty/undefined slots, so a posterless clip is fine).
    const grandfatheredUrls = (grandfatheredVideos ?? []).flatMap((v) => [v.url, v.posterUrl]);
    const submittedUrls = videos.flatMap((v) => [v.url, v.posterUrl]);
    await this.media.assertOwnedMedia(submittedUrls, ownerUserId, { grandfatheredUrls });
    return Promise.all(
      videos.map(async (v) => {
        const durationSec = await this.media.getServerVideoDurationByUrl(v.url, ownerUserId);
        return {
          url: v.url,
          ...(v.posterUrl ? { posterUrl: v.posterUrl } : {}),
          ...(durationSec != null ? { durationSec } : {}),
        };
      }),
    );
  }

  private async loadOwnedJob(companyUserId: string, jobId: string): Promise<JobDocument> {
    const job = Types.ObjectId.isValid(jobId) ? await this.jobModel.findById(jobId) : null;
    if (!job || String(job.companyUserId) !== companyUserId) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  /** Load an application + its job, asserting the caller owns the job. */
  private async loadOwnedApplication(
    companyUserId: string,
    applicationId: string,
  ): Promise<{ application: JobApplicationDocument; job: JobDocument }> {
    const application = Types.ObjectId.isValid(applicationId)
      ? await this.applicationModel.findById(applicationId)
      : null;
    if (!application) throw new NotFoundException('Application not found');
    const job = await this.loadOwnedJob(companyUserId, String(application.jobId));
    return { application, job };
  }

  private async notifyApplicant(
    application: JobApplicationDocument,
    category: 'connect.job_application_accepted' | 'connect.job_application_declined',
    title: string,
  ): Promise<void> {
    const job = await this.jobModel
      .findById(application.jobId)
      .select('title')
      .lean<{ title?: string }>()
      .exec();
    const jobTitle = job?.title ?? 'the job';
    const message =
      category === 'connect.job_application_accepted'
        ? `Your application for "${jobTitle}" was accepted.`
        : `Your application for "${jobTitle}" was not selected.`;
    await this.notifications
      .dispatch({
        recipientId: application.applicantUserId,
        category,
        entityType: 'JobApplication',
        entityId: String(application._id),
        title,
        message,
      })
      .catch(() => undefined);
  }
}
