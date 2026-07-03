import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { ConnectionRequest } from './schemas/connection-request.schema';
import { Connection } from './schemas/connection.schema';
import { ConnectProfile } from '../profile/schemas/connect-profile.schema';
import { WorkspaceMember } from '../../workspaces/schemas/workspace-member.schema';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';
import { Party } from '../../finance/parties/party.schema';
// Demo down-rank — shared Connect helper so the "Sample" badge and the ranking
// penalty read ONE source (the denormalized isDemo). Cross-module: pairs with
// crewroster-web SampleBadge.tsx. Watch: keep it the LAST score multiplier.
import { applyDemoPenalty } from '../common/demo-rank';

/** A ranked "people you may know" suggestion. */
export interface PersonSuggestion {
  /** The suggested person's `User` id. */
  userId: string;
  /** Weighted relevance score — higher first. */
  score: number;
  /** Connections the viewer and this person share. */
  mutualConnections: number;
  /** Skills both the viewer and this person list. */
  sharedSkills: string[];
  /** True when the viewer and this person are active in the same ERP workspace. */
  sharedWorkspace: boolean;
  /**
   * True when this person is a contact in the viewer's OWN ERP party book
   * (a customer / vendor / broker of a workspace the viewer owns), matched by
   * phone. The cold-start asset competitors lack — your real supply chain is
   * already on the graph. Privacy-safe: this is a *suggestion* (opt-in follow),
   * never a silent auto-follow, and no ERP data (balance, party type, name)
   * ever crosses to the public surface — only the existence of a phone match.
   */
  sharedErpParty: boolean;
}

/**
 * Suggestion scoring weights. An ERP party-book match is the strongest signal —
 * a real customer / vendor relationship the viewer has transacted with; a
 * shared active employer comes next (they literally work together); mutual
 * connections next; skill overlap is a softer nudge.
 *
 * The ranking is NEVER influenced by community or religion (PRD §3
 * anti-pattern). This is structurally guaranteed: no such field exists on any
 * Connect or ERP collection the scorer reads.
 */
const WEIGHTS = {
  sharedErpParty: 6,
  sharedWorkspace: 5,
  mutualConnection: 2,
  skillOverlap: 3,
} as const;

/** Upper bound on candidate profiles scored per request — bounds the fan-out. */
const CANDIDATE_CAP = 200;

/** Upper bound on ERP parties scanned per request for phone resolution. */
const ERP_PARTY_SCAN_CAP = 300;

/**
 * Normalize a phone to its last 10 digits — the India-mobile match key. Strips
 * country code / spaces / punctuation so an ERP party phone stored as
 * `+91 98765 43210` matches a `User.mobile` of `9876543210`. Returns `null`
 * when fewer than 10 digits are present.
 */
function phoneKey(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** The common stored variants of an India mobile for a `User.mobile` `$in` match. */
function mobileVariants(key: string): string[] {
  return [key, `0${key}`, `91${key}`, `+91${key}`];
}

/**
 * `SuggestionService` — the Connect "people you may know" engine (Phase 2).
 *
 * Ranks public `ConnectProfile`s for a viewer by a weighted blend of shared
 * active employment, mutual connections, and skill overlap. Excludes the
 * viewer, anyone already connected, and anyone with a pending request in
 * either direction. A zero-score candidate (no signal at all) is dropped — a
 * suggestion must have a reason to show.
 */
@Injectable()
export class SuggestionService {
  private readonly tracer = trace.getTracer('connect.network');

  constructor(
    @InjectModel(ConnectionRequest.name)
    private readonly requestModel: Model<ConnectionRequest>,
    @InjectModel(Connection.name)
    private readonly connectionModel: Model<Connection>,
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(WorkspaceMember.name)
    private readonly memberModel: Model<WorkspaceMember>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(Party.name)
    private readonly partyModel: Model<Party>,
  ) {}

  /** Ranked "people you may know" for the viewer, best first. */
  async getSuggestions(userId: string | Types.ObjectId, limit = 12): Promise<PersonSuggestion[]> {
    return this.withSpan('connect.network.getSuggestions', {}, async (span) => {
      const me = this.toObjectId(userId);

      // ── Exclusion set — self, connections, in-flight requests ────────────
      const myConnections = await this.connectionModel
        .find({ $or: [{ userA: me }, { userB: me }] })
        .select('userA userB')
        .lean<Array<{ userA: Types.ObjectId; userB: Types.ObjectId }>>()
        .exec();
      const myConnectionIds = new Set(
        myConnections.map((c) => String(c.userA.equals(me) ? c.userB : c.userA)),
      );

      const myRequests = await this.requestModel
        .find({ status: 'pending', $or: [{ fromUserId: me }, { toUserId: me }] })
        .select('fromUserId toUserId')
        .lean<Array<{ fromUserId: Types.ObjectId; toUserId: Types.ObjectId }>>()
        .exec();
      const pendingIds = new Set(
        myRequests.flatMap((r) => [String(r.fromUserId), String(r.toUserId)]),
      );

      const exclude = new Set<string>([String(me), ...myConnectionIds, ...pendingIds]);

      // ── Viewer's own signal — skills + active employment ─────────────────
      const [myProfile, myMemberships] = await Promise.all([
        this.profileModel
          .findOne({ userId: me })
          .select('skills')
          .lean<{ skills?: string[] }>()
          .exec(),
        this.memberModel
          .find({ userId: me, status: 'active' })
          .select('workspaceId')
          .lean<Array<{ workspaceId: Types.ObjectId }>>()
          .exec(),
      ]);
      const mySkills = new Set((myProfile?.skills ?? []).map((s) => s.toLowerCase()));
      const myWorkspaceIds = myMemberships.map((m) => m.workspaceId);

      // ── Candidate pool — public profiles, not excluded ───────────────────
      // `let` (not `const`): the live-owner guard below filters this in place.
      let candidates = await this.profileModel
        .find({
          visibility: 'public',
          userId: { $nin: [...exclude].map((id) => new Types.ObjectId(id)) },
        })
        .select('userId skills')
        .limit(CANDIDATE_CAP)
        .lean<Array<{ userId: Types.ObjectId; skills?: string[] }>>()
        .exec();

      // ── ERP party-book signal — the viewer's own customers / vendors ─────
      // Resolve the people in the viewer's owned-workspace party book to Connect
      // users (by phone), then ensure they are scored even if they fell outside
      // the public-profile scan cap above. Privacy-safe: a suggestion only.
      const erpPartyUserIds = await this.resolveErpPartyUserIds(me, exclude);
      const haveIds = new Set(candidates.map((c) => String(c.userId)));
      const missingErpIds = [...erpPartyUserIds].filter((id) => !haveIds.has(id));
      if (missingErpIds.length > 0) {
        const extra = await this.profileModel
          .find({
            visibility: 'public',
            userId: { $in: missingErpIds.map((id) => new Types.ObjectId(id)) },
          })
          .select('userId skills')
          .lean<Array<{ userId: Types.ObjectId; skills?: string[] }>>()
          .exec();
        candidates.push(...extra);
      }

      span.setAttribute('candidateCount', candidates.length);
      span.setAttribute('erpPartyMatchCount', erpPartyUserIds.size);
      if (candidates.length === 0) return [];

      // ── Live-owner guard — drop candidates with no reachable account ─────
      // The candidate pool is built from ConnectProfile alone (visibility:
      // 'public'); it NEVER joins User. A profile row can outlive its owner: a
      // hard-deleted account, or leftover seeded-demo data, leaves an ORPHAN
      // profile whose userId resolves to no live User. Such an id would surface
      // as a suggestion and then render on the web as an empty "Connect member"
      // ghost row (people-card hydration via `getPeopleByIds` finds no User, so
      // the FE falls back to a placeholder name). A suggestion must point at a
      // reachable account, so require the owning User to EXIST, be active, not
      // erased, and Connect-enabled — the same live-account contract the public
      // profile read enforces (ConnectProfileService.getPublicByUserId orphan
      // guard). Cross-module: ConnectProfile.userId -> User. Keep the field set
      // in sync with AccountErasureService (erasure sets isActive:false /
      // deletedAt / connectEnabled:false). A properly erased user is already
      // excluded above by visibility:'public' (erasure flips it to 'hidden');
      // this additionally covers deactivated and fully orphaned ids.
      const liveOwnerRows = await this.userModel
        .find({
          _id: { $in: candidates.map((c) => c.userId) },
          isActive: { $ne: false },
          deletedAt: { $in: [null, undefined] },
          connectEnabled: { $ne: false },
        })
        // isDemo rides along on this existing live-owner join (no extra query) so
        // the scorer can down-rank seeded demo people below real ones via
        // applyDemoPenalty — they still surface when real candidates are scarce.
        .select('_id isDemo')
        .lean<Array<{ _id: Types.ObjectId; isDemo?: boolean }>>()
        .exec();
      const liveOwnerIds = new Set(liveOwnerRows.map((u) => String(u._id)));
      const demoOwnerIds = new Set(
        liveOwnerRows.filter((u) => u.isDemo === true).map((u) => String(u._id)),
      );
      candidates = candidates.filter((c) => liveOwnerIds.has(String(c.userId)));
      span.setAttribute('liveCandidateCount', candidates.length);
      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((c) => c.userId);
      const candidateIdSet = new Set(candidateIds.map((id) => String(id)));

      // ── Mutual connections — one batched query over the candidates' edges ─
      const candidateEdges = await this.connectionModel
        .find({ $or: [{ userA: { $in: candidateIds } }, { userB: { $in: candidateIds } }] })
        .select('userA userB')
        .lean<Array<{ userA: Types.ObjectId; userB: Types.ObjectId }>>()
        .exec();
      const connsByCandidate = new Map<string, Set<string>>();
      const link = (candidate: string, other: string): void => {
        let set = connsByCandidate.get(candidate);
        if (!set) {
          set = new Set<string>();
          connsByCandidate.set(candidate, set);
        }
        set.add(other);
      };
      for (const edge of candidateEdges) {
        const a = String(edge.userA);
        const b = String(edge.userB);
        if (candidateIdSet.has(a)) link(a, b);
        if (candidateIdSet.has(b)) link(b, a);
      }

      // ── Shared employment — candidates active in one of my workspaces ────
      const sharedRows =
        myWorkspaceIds.length > 0
          ? await this.memberModel
              .find({
                userId: { $in: candidateIds },
                workspaceId: { $in: myWorkspaceIds },
                status: 'active',
              })
              .select('userId')
              .lean<Array<{ userId: Types.ObjectId }>>()
              .exec()
          : [];
      const sharedWorkspaceIds = new Set(sharedRows.map((r) => String(r.userId)));

      // ── Score, drop zero-signal candidates, rank ─────────────────────────
      const scored = candidates.map<PersonSuggestion>((c) => {
        const cid = String(c.userId);
        const sharedSkills = (c.skills ?? []).filter((s) => mySkills.has(s.toLowerCase()));
        const candidateConns = connsByCandidate.get(cid);
        let mutual = 0;
        if (candidateConns) {
          for (const id of candidateConns) if (myConnectionIds.has(id)) mutual += 1;
        }
        const sharedWorkspace = sharedWorkspaceIds.has(cid);
        const sharedErpParty = erpPartyUserIds.has(cid);
        const baseScore =
          sharedSkills.length * WEIGHTS.skillOverlap +
          mutual * WEIGHTS.mutualConnection +
          (sharedWorkspace ? WEIGHTS.sharedWorkspace : 0) +
          (sharedErpParty ? WEIGHTS.sharedErpParty : 0);
        // LAST multiplier — demo/sample people rank below real ones but still
        // show when real candidates are scarce (down-rank, not exclusion).
        const score = applyDemoPenalty(baseScore, demoOwnerIds.has(cid));
        return {
          userId: cid,
          score,
          mutualConnections: mutual,
          sharedSkills,
          sharedWorkspace,
          sharedErpParty,
        };
      });

      const ranked = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      span.setAttribute('suggestionCount', ranked.length);
      return ranked;
    });
  }

  /**
   * Resolve the Connect users who are contacts in the viewer's OWN ERP party
   * book (parties of workspaces the viewer owns), matched by phone. Returns
   * their `User` ids, minus anyone already excluded (self / connected /
   * pending). Owner-scoped on purpose: a workshop's customers / vendors are the
   * OWNER's relationships — a worker employed there does not inherit them.
   *
   * Reads phones only — never party type, name, balance, or any operational
   * field — so nothing crosses the ERP↔Connect privacy wall beyond a phone
   * match that drives an opt-in suggestion (the same shape as a contacts import).
   */
  private async resolveErpPartyUserIds(
    viewer: Types.ObjectId,
    exclude: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const owned = await this.workspaceModel
      .find({ ownerId: viewer })
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    if (owned.length === 0) return new Set();

    const parties = await this.partyModel
      .find({ workspaceId: { $in: owned.map((w) => w._id) }, isDeleted: { $ne: true } })
      .select('phone contacts')
      .limit(ERP_PARTY_SCAN_CAP)
      .lean<Array<{ phone?: string; contacts?: Array<{ phone?: string }> }>>()
      .exec();

    const partyKeys = new Set<string>();
    for (const party of parties) {
      const k = phoneKey(party.phone);
      if (k) partyKeys.add(k);
      for (const contact of party.contacts ?? []) {
        const ck = phoneKey(contact.phone);
        if (ck) partyKeys.add(ck);
      }
    }
    if (partyKeys.size === 0) return new Set();

    const variants = [...partyKeys].flatMap(mobileVariants);
    const users = await this.userModel
      .find({ mobile: { $in: variants } })
      .select('mobile')
      .lean<Array<{ _id: Types.ObjectId; mobile?: string }>>()
      .exec();

    const matched = new Set<string>();
    for (const user of users) {
      const k = phoneKey(user.mobile);
      const id = String(user._id);
      if (k && partyKeys.has(k) && !exclude.has(id)) matched.add(id);
    }
    return matched;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
  }

  /** OpenTelemetry span wrapper — mirrors `NetworkService.withSpan`. */
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
