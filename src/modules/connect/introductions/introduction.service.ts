import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  Introduction,
  type IntroductionRole,
  type IntroductionStatus,
} from './schemas/introduction.schema';
import { ConnectProfile } from '../profile/schemas/connect-profile.schema';
import { User } from '../../users/schemas/user.schema';
import { NotificationsService } from '../../notifications/notifications.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import type { CreateIntroductionDto } from './dto/introduction.dto';

/** Upper bound on a single list read — DoS backstop (mirrors LIST_HARD_CAP use). */
const LIST_HARD_CAP = 200;

/**
 * Normalize a phone to its last 10 digits — the India-mobile match key. Copied
 * verbatim from `SuggestionService.phoneKey` so the distinct-phone check uses
 * the identical normalization (a broker can't introduce one person to their own
 * second account by phone). Returns `null` when fewer than 10 digits are present.
 */
function phoneKey(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * `IntroductionService` — broker-mediated introductions (anti-gaming core).
 *
 * A broker introduces a buyer + a seller; the introduction is `pending` until
 * BOTH introduced parties independently confirm, then `confirmed`. Mirrors:
 *   - `NetworkService.sendRequest` — the anti-self guard stack, `withSpan`,
 *     best-effort `notify`, `sortedPair`/`toObjectId` helpers, canonical pair.
 *   - `SuggestionService` — the live-account guard query + `phoneKey` normalizer.
 *   - `ConnectProfileService.decideCredential` — the two-sided confirm pattern
 *     (actor is ALWAYS the caller; only the correct party confirms their own
 *     side; audit + posthog + best-effort notify after the write).
 *
 * Like `NetworkService`, writes throw typed Nest exceptions on a guard
 * violation — introductions are core trust data, a bad write must surface.
 */
@Injectable()
export class IntroductionService {
  private readonly tracer = trace.getTracer('connect.introductions');

  constructor(
    @InjectModel(Introduction.name)
    private readonly introductionModel: Model<Introduction>,
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly notificationsService: NotificationsService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /**
   * Best-effort notification dispatch — copied from `NetworkService.notify`.
   * Introduction writes succeed independently; a notification failure is
   * swallowed (logged + Sentry-captured inside `dispatch`) and never blocks the
   * primary write.
   */
  private async notify(
    category:
      | 'connect.introduction_created'
      | 'connect.introduction_confirmed'
      | 'connect.introduction_declined',
    recipientId: Types.ObjectId | string,
    actorId: Types.ObjectId | string,
    entityId: string,
    title: string,
    message: string,
  ): Promise<void> {
    await this.notificationsService
      .dispatch({
        recipientId,
        actorId,
        category,
        entityType: 'Introduction',
        entityId,
        title,
        message,
      })
      .catch(() => undefined);
  }

  // ── Create ───────────────────────────────────────────────────────────────

  /**
   * Create a `pending` introduction. Guards (mirroring `sendRequest`'s stack):
   *   1. The creator must be a self-declared broker (`ConnectProfile.isBroker`).
   *   2. No self-introduction / broker-as-a-party (anti-self).
   *   3. Both introduced parties must be LIVE, active, mobile-verified members.
   *   4. The two parties must have distinct phones (anti same-person gaming).
   *   5. Dedup: one introduction per (broker, ordered pair).
   */
  async create(
    brokerUserId: string | Types.ObjectId,
    dto: CreateIntroductionDto,
  ): Promise<Introduction> {
    return this.withSpan('connect.introductions.create', {}, async () => {
      const broker = this.toObjectId(brokerUserId);
      const partyA = this.toObjectId(dto.partyAUserId);
      const partyB = this.toObjectId(dto.partyBUserId);

      // (1) Broker gate — only a self-declared broker can introduce. Read the
      // ConnectProfile.isBroker flag (the same flag the Broker badge renders).
      const brokerProfile = await this.profileModel
        .findOne({ userId: broker })
        .select('isBroker')
        .lean<{ isBroker?: boolean } | null>()
        .exec();
      if (!brokerProfile?.isBroker) {
        throw new ForbiddenException(
          'Only a broker can introduce two people. Turn on the broker option on your profile first.',
        );
      }

      // (2) Anti-self — distinct parties, broker not a party (mirrors the
      // `from.equals(to)` self-guard in NetworkService.sendRequest).
      if (partyA.equals(partyB)) {
        throw new BadRequestException('You must introduce two different people.');
      }
      if (broker.equals(partyA) || broker.equals(partyB)) {
        throw new BadRequestException('You cannot introduce yourself.');
      }

      // (3) Both parties must be LIVE, active, mobile-verified members. Reuses
      // the SuggestionService live-account guard query + isMobileVerified:true.
      const liveUsers = await this.userModel
        .find({
          _id: { $in: [partyA, partyB] },
          isActive: { $ne: false },
          deletedAt: { $in: [null, undefined] },
          connectEnabled: { $ne: false },
          isMobileVerified: true,
        })
        .select('mobile')
        .lean<Array<{ _id: Types.ObjectId; mobile?: string }>>()
        .exec();
      if (liveUsers.length !== 2) {
        throw new BadRequestException('Both parties must be verified, active members.');
      }

      // (4) Distinct phones — a broker can't introduce a person to their own
      // second account. Uses the identical `phoneKey` normalizer as Suggestions.
      const keyA = phoneKey(liveUsers[0].mobile);
      const keyB = phoneKey(liveUsers[1].mobile);
      if (keyA !== null && keyB !== null && keyA === keyB) {
        throw new BadRequestException('Both parties must be verified, active members.');
      }

      // Canonical ordered pair + derive roleOfLow (copied from Connection's
      // sortedPair ordering technique). If partyA is the low party, roleOfLow is
      // partyA's role; otherwise it is the opposite.
      const { userLow, userHigh } = this.sortedPair(partyA, partyB);
      const aIsLow = userLow.equals(partyA);
      const roleOfLow: IntroductionRole = aIsLow ? dto.roleOfA : this.oppositeRole(dto.roleOfA);

      // (5) Dedup — one non-deleted introduction per (broker, ordered pair).
      const existing = await this.introductionModel
        .findOne({ brokerUserId: broker, userLow, userHigh, deletedAt: { $in: [null, undefined] } })
        .lean()
        .exec();
      if (existing) {
        throw new ConflictException('You have already introduced these two.');
      }

      const trimmed = dto.note?.trim();
      let created: Introduction;
      try {
        created = await this.introductionModel.create({
          brokerUserId: broker,
          userLow,
          userHigh,
          roleOfLow,
          note: trimmed ? trimmed : undefined,
          status: 'pending',
          confirmedByLowAt: null,
          confirmedByHighAt: null,
          deletedAt: null,
        });
      } catch (err) {
        // The unique index is the race backstop — translate E11000 to the same
        // friendly conflict (mirrors how NetworkService relies on the unique
        // pair index, here surfaced explicitly because a soft-deleted prior row
        // can still collide on the unique key).
        if (this.isDuplicateKeyError(err)) {
          throw new ConflictException('You have already introduced these two.');
        }
        throw err;
      }

      const introId = String(created._id);
      // Best-effort fan-out to BOTH introduced parties — "confirm?" prompt.
      void this.notify(
        'connect.introduction_created',
        userLow,
        broker,
        introId,
        'You were introduced',
        'Someone introduced you to a contact. Confirm to connect.',
      );
      void this.notify(
        'connect.introduction_created',
        userHigh,
        broker,
        introId,
        'You were introduced',
        'Someone introduced you to a contact. Confirm to connect.',
      );

      this.posthog?.capture({
        distinctId: String(broker),
        event: 'connect.introduction_created',
        properties: { introductionId: introId, roleOfLow },
      });
      return created;
    });
  }

  // ── Confirm / decline ──────────────────────────────────────────────────────

  /**
   * Confirm the caller's OWN side of an introduction (two-sided confirm pattern
   * from `decideCredential`). The actor must be `userLow` or `userHigh` (a
   * party) — never the broker, never the other side. When BOTH sides have
   * confirmed, the status flips to `confirmed`. Idempotent: re-confirming a side
   * already confirmed (or the whole introduction) is a no-op success.
   */
  async confirm(
    introductionId: string,
    actorUserId: string | Types.ObjectId,
  ): Promise<Introduction> {
    return this.withSpan('connect.introductions.confirm', {}, async () => {
      const actor = this.toObjectId(actorUserId);
      const intro = await this.loadLive(introductionId);

      const isLow = (intro.userLow as Types.ObjectId).equals(actor);
      const isHigh = (intro.userHigh as Types.ObjectId).equals(actor);
      if (!isLow && !isHigh) {
        // Only an introduced party may confirm — the broker is explicitly barred.
        throw new ForbiddenException('Only an introduced party can confirm this introduction.');
      }

      // Set ONLY the actor's own side — never the other party's, never via broker.
      if (isLow && !intro.confirmedByLowAt) intro.confirmedByLowAt = new Date();
      if (isHigh && !intro.confirmedByHighAt) intro.confirmedByHighAt = new Date();

      const bothConfirmed = !!intro.confirmedByLowAt && !!intro.confirmedByHighAt;
      const justConfirmed = bothConfirmed && intro.status !== 'confirmed';
      if (justConfirmed) intro.status = 'confirmed';
      await intro.save();

      const introId = String(intro._id);
      if (justConfirmed) {
        // Notify the broker + the OTHER party that the introduction is now live.
        const other = isLow
          ? (intro.userHigh as Types.ObjectId)
          : (intro.userLow as Types.ObjectId);
        void this.notify(
          'connect.introduction_confirmed',
          intro.brokerUserId as Types.ObjectId,
          actor,
          introId,
          'Introduction confirmed',
          'Both parties confirmed your introduction.',
        );
        void this.notify(
          'connect.introduction_confirmed',
          other,
          actor,
          introId,
          'Introduction confirmed',
          'Your introduction is now confirmed.',
        );
      }

      this.posthog?.capture({
        distinctId: String(actor),
        event: 'connect.introduction_confirmed',
        properties: { introductionId: introId, fullyConfirmed: justConfirmed },
      });
      return intro;
    });
  }

  /**
   * Decline the caller's participation. The actor must be a party (broker barred,
   * like `confirm`). Sets `status='declined'` + `deletedAt=now` (soft delete,
   * never a hard delete — mirrors the retained-record discipline).
   */
  async decline(
    introductionId: string,
    actorUserId: string | Types.ObjectId,
  ): Promise<Introduction> {
    return this.withSpan('connect.introductions.decline', {}, async () => {
      const actor = this.toObjectId(actorUserId);
      const intro = await this.loadLive(introductionId);

      const isLow = (intro.userLow as Types.ObjectId).equals(actor);
      const isHigh = (intro.userHigh as Types.ObjectId).equals(actor);
      if (!isLow && !isHigh) {
        throw new ForbiddenException('Only an introduced party can decline this introduction.');
      }

      intro.status = 'declined';
      intro.deletedAt = new Date();
      await intro.save();

      const introId = String(intro._id);
      this.posthog?.capture({
        distinctId: String(actor),
        event: 'connect.introduction_declined',
        properties: { introductionId: introId },
      });
      return intro;
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The caller's pending-to-confirm queue: introductions where the caller is a
   * party, their OWN side is not yet confirmed, and the row is neither
   * soft-deleted nor declined. Populates the broker + the OTHER party for the card.
   */
  async listPendingForUser(userId: string | Types.ObjectId): Promise<Introduction[]> {
    const me = this.toObjectId(userId);
    return this.introductionModel
      .find({
        status: 'pending',
        deletedAt: { $in: [null, undefined] },
        $or: [
          { userLow: me, confirmedByLowAt: { $in: [null, undefined] } },
          { userHigh: me, confirmedByHighAt: { $in: [null, undefined] } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(LIST_HARD_CAP)
      .populate('brokerUserId', 'name profilePicture handle')
      .populate('userLow', 'name profilePicture handle')
      .populate('userHigh', 'name profilePicture handle')
      .lean<Introduction[]>()
      .exec();
  }

  /**
   * The broker's introductions (their auto contact book), newest first,
   * excluding soft-deleted rows. Optional `status` filter. Populates both
   * introduced parties for the list card.
   */
  async listForBroker(
    brokerUserId: string | Types.ObjectId,
    status?: IntroductionStatus,
  ): Promise<Introduction[]> {
    const broker = this.toObjectId(brokerUserId);
    const filter: Record<string, unknown> = {
      brokerUserId: broker,
      deletedAt: { $in: [null, undefined] },
    };
    if (status) filter.status = status;
    return this.introductionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(LIST_HARD_CAP)
      .populate('userLow', 'name profilePicture handle')
      .populate('userHigh', 'name profilePicture handle')
      .lean<Introduction[]>()
      .exec();
  }

  /**
   * The introductions the caller RECEIVED — rows where the caller is a PARTY
   * (`userLow` OR `userHigh`), never where they are only the broker, excluding
   * soft-deleted rows. Defaults to `'confirmed'` so a party can review the
   * broker who made a confirmed introduction; pass `status` to widen. Populates
   * the broker + the OTHER party (mirrors `listPendingForUser`'s populate set).
   *
   * Each item is enriched (on the lean object) with the caller's own role
   * (`myRole`) and the broker's id (`brokerId`) so the web can open a review of
   * that broker without re-deriving the canonical pair on the client.
   */
  async listReceivedForUser(
    userId: string | Types.ObjectId,
    status: IntroductionStatus = 'confirmed',
  ): Promise<Array<Introduction & { myRole: IntroductionRole; brokerId: string }>> {
    const me = this.toObjectId(userId);
    const rows = await this.introductionModel
      .find({
        status,
        deletedAt: { $in: [null, undefined] },
        $or: [{ userLow: me }, { userHigh: me }],
      })
      .sort({ createdAt: -1 })
      .limit(LIST_HARD_CAP)
      .populate('brokerUserId', 'name profilePicture handle')
      .populate('userLow', 'name profilePicture handle')
      .populate('userHigh', 'name profilePicture handle')
      .lean<Introduction[]>()
      .exec();

    // Enrich each row with the caller's own role + the broker id. `userLow` /
    // `brokerUserId` may be populated docs (post-populate) or raw ObjectIds, so
    // resolve the id off `_id` when present.
    return rows.map((row) => {
      const lowId = this.refId(row.userLow);
      const iAmLow = lowId === me.toHexString();
      const myRole: IntroductionRole = iAmLow ? row.roleOfLow : this.oppositeRole(row.roleOfLow);
      return { ...row, myRole, brokerId: this.refId(row.brokerUserId) };
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Load a non-deleted introduction doc (not lean — for mutate + save), or 404. */
  private async loadLive(introductionId: string): Promise<Introduction> {
    if (!Types.ObjectId.isValid(introductionId)) {
      throw new NotFoundException('Introduction not found.');
    }
    const intro = await this.introductionModel
      .findOne({
        _id: new Types.ObjectId(introductionId),
        deletedAt: { $in: [null, undefined] },
      })
      .exec();
    if (!intro) throw new NotFoundException('Introduction not found.');
    return intro;
  }

  /** The opposite buyer/seller role. */
  private oppositeRole(role: IntroductionRole): IntroductionRole {
    return role === 'buyer' ? 'seller' : 'buyer';
  }

  /**
   * The hex id of a `User` ref that may be a raw `ObjectId` or a populated doc.
   * Reads `_id` when the ref was populated, otherwise treats it as the id itself.
   */
  private refId(ref: User | Types.ObjectId | { _id?: Types.ObjectId }): string {
    const maybeDoc = ref as { _id?: Types.ObjectId };
    const id = maybeDoc?._id ?? ref;
    return String(id);
  }

  /** A Mongo duplicate-key error (E11000) on the unique pair index. */
  private isDuplicateKeyError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
  }

  /**
   * Canonical ordered pair — `userLow` is the lexicographically-smaller id.
   * Copied from `NetworkService.sortedPair` so the introduced pair is stored
   * once and the unique index dedups it.
   */
  private sortedPair(
    a: Types.ObjectId,
    b: Types.ObjectId,
  ): { userLow: Types.ObjectId; userHigh: Types.ObjectId } {
    return a.toHexString() <= b.toHexString()
      ? { userLow: a, userHigh: b }
      : { userLow: b, userHigh: a };
  }

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    if (id instanceof Types.ObjectId) return id;
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid id.');
    }
    return new Types.ObjectId(id);
  }

  /**
   * OpenTelemetry span wrapper — copied from `NetworkService.withSpan`. Span
   * attributes carry only ids / counts / enums, never raw PII.
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
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
