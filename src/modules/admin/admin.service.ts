import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as nodemailer from 'nodemailer';
import { encryptSmtpPassword, decryptSmtpPassword } from '../../common/utils/crypto-utils';
import { User } from '../users/schemas/user.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { WorkspaceMember } from '../workspaces/schemas/workspace-member.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { Plan, PlanEntitlements } from '../subscriptions/schemas/plan.schema';
import { ConnectProfile } from '../connect/profile/schemas/connect-profile.schema';
import { AppSettings } from '../subscriptions/schemas/app-settings.schema';
import { Tier } from '../subscriptions/schemas/tier.schema';
import { PlanTier } from '../../common/enums/plan-tier.enum';
import { PlatformAccess } from '../../common/enums/platform-access.enum';
import { AddOnsService } from '../add-ons/add-ons.service';
import {
  AdminPaginationDto,
  UpdateUserStatusDto,
  AdminAssignPlanDto,
  AdminCustomAssignDto,
  AdminUpdateSubscriptionDto,
  CreateUserDto,
  UpdateSettingsDto,
  DefaultBrandingDto,
} from './dto/admin.dto';
import { CreatePlanDto, validateModuleAccess } from '../subscriptions/dto/subscription.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateTierDto, UpdateTierDto } from './dto/tier.dto';
import { PtSlabConfig } from '../salary/schemas/pt-slab.schema';
import { CreatePtSlabDto, UpdatePtSlabDto } from './dto/pt-slab.dto';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { UserClaimsCacheService } from '../users/user-claims-cache.service';
import { CONNECT_PROFILE_CHANGED } from '../connect/profile/events/connect-profile.events';

interface AdminUserContext {
  _id: string | Types.ObjectId;
}

/**
 * Which existing product subscriptions a newly-assigned plan supersedes.
 * Assigning erp/connect replaces that product AND any bundle (a bundle already
 * covers it); assigning a bundle replaces erp + connect + bundle (it stands in
 * for both). This product-scoping is what lets a Connect grant leave an ERP
 * subscription untouched — and vice versa — instead of wiping every product.
 */
export function supersededProducts(product: string): string[] {
  return product === 'bundle' ? ['erp', 'connect', 'bundle'] : [product, 'bundle'];
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private workspaceMemberModel: Model<WorkspaceMember>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private planModel: Model<Plan>,
    @InjectModel(AppSettings.name)
    private appSettingsModel: Model<AppSettings>,
    @InjectModel(Tier.name) private tierModel: Model<Tier>,
    @InjectModel(PtSlabConfig.name)
    private ptSlabConfigModel: Model<PtSlabConfig>,
    private subscriptionsService: SubscriptionsService,
    private addOnsService: AddOnsService,
    private auditService: AuditService,
    // OQ-2: invalidate the JWT hot-path claims cache whenever an admin write
    // flips a cached field (isActive on status change / soft-delete / restore;
    // isAdmin via the grant path elsewhere) so a deactivated user's still-valid
    // access token is rejected by JwtStrategy on the very next request.
    private readonly userClaimsCache: UserClaimsCacheService,
    // Connect footprint signal for the unified users console: a ConnectProfile is
    // created the moment a person first enters Connect (person-centric, unique
    // userId), so its existence — independent of any paid Connect subscription —
    // is the canonical "is a Connect user" marker.
    @InjectModel(ConnectProfile.name)
    private connectProfileModel: Model<ConnectProfile>,
    // CN-SRCH-2 (feed harden Bucket 5): emit CONNECT_PROFILE_CHANGED on
    // suspend/restore so the Connect people search index refreshes promptly
    // (the query-time gate is the actual security boundary; this is a freshness
    // improvement). Globally available via EventEmitterModule.forRoot(), so no
    // module import change is needed.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // NOTE: PT-slab default seeding moved off boot — it now runs via the ledgered
  // migration runner (ADR-0001), unit `0037_admin_seed_pt_slabs`
  // (src/migrations/seed-pt-slabs.ts). Do NOT re-add a boot hook here on merge.
  // The PtSlabConfig model injection stays — it's used by the CRUD methods below.

  async getSettings(): Promise<AppSettings> {
    const settings = await this.appSettingsModel.findOne().exec();
    if (!settings) {
      return this.appSettingsModel.create({ freeTierEnabled: true });
    }
    return settings;
  }

  async updateSettings(dto: UpdateSettingsDto): Promise<AppSettings> {
    const settings = await this.appSettingsModel.findOne().exec();
    if (!settings) {
      // Fresh DB, no settings doc yet. Keep any provided fields (e.g. a
      // trialBanner-only save) and default freeTierEnabled to true when the
      // partial patch omits it, so the first save never persists undefined.
      return this.appSettingsModel.create({
        ...dto,
        freeTierEnabled: dto.freeTierEnabled ?? true,
      });
    }
    return this.appSettingsModel.findOneAndUpdate({}, { $set: dto }, { new: true }).exec();
  }

  async getDefaultBranding(): Promise<AppSettings['defaultBranding']> {
    const settings = await this.appSettingsModel.findOne().exec();
    return settings?.defaultBranding;
  }

  async updateDefaultBranding(dto: DefaultBrandingDto): Promise<AppSettings> {
    const settings = await this.appSettingsModel.findOne().exec();
    if (!settings) {
      return this.appSettingsModel.create({
        freeTierEnabled: true,
        defaultBranding: dto,
      });
    }
    return this.appSettingsModel
      .findOneAndUpdate({}, { $set: { defaultBranding: dto } }, { new: true })
      .exec();
  }

  // seedDefaultPtSlabs() moved to the ledgered migration runner
  // (src/migrations/seed-pt-slabs.ts, unit 0037) — see the NOTE above.

  async getPtSlabs() {
    return this.ptSlabConfigModel.find().sort({ state: 1 }).lean().exec();
  }

  async getPtSlab(state: string) {
    const ptSlab = await this.ptSlabConfigModel.findOne({ state: state.trim() }).lean().exec();

    if (!ptSlab) {
      throw new NotFoundException('PT slab config not found');
    }

    return ptSlab;
  }

  async createPtSlab(dto: CreatePtSlabDto) {
    const state = dto.state.trim();
    const existing = await this.ptSlabConfigModel.findOne({ state }).lean().exec();
    if (existing) {
      throw new ConflictException('PT slab config for this state already exists');
    }

    return this.ptSlabConfigModel.create({
      state,
      frequency: dto.frequency,
      slabs: dto.slabs,
      isActive: true,
    });
  }

  async updatePtSlab(state: string, dto: UpdatePtSlabDto) {
    const updated = await this.ptSlabConfigModel
      .findOneAndUpdate(
        { state: state.trim() },
        {
          $set: {
            ...(dto.frequency !== undefined ? { frequency: dto.frequency } : {}),
            ...(dto.slabs !== undefined ? { slabs: dto.slabs } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException('PT slab config not found');
    }

    return updated;
  }

  async deletePtSlab(state: string) {
    const deleted = await this.ptSlabConfigModel
      .findOneAndDelete({ state: state.trim() })
      .lean()
      .exec();

    if (!deleted) {
      throw new NotFoundException('PT slab config not found');
    }

    return { message: 'PT slab config deleted successfully' };
  }

  async getStats() {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers,
      totalWorkspaces,
      activeWorkspaces,
      newUsersLast7Days,
      proSubscriptions,
      recentUsers,
      planBreakdown,
      monthlyRevenueResult,
    ] = await Promise.all([
      this.userModel.countDocuments(),
      this.workspaceModel.countDocuments(),
      this.workspaceModel.countDocuments({ isActive: true }),
      this.userModel.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      this.subscriptionModel.countDocuments({ status: 'active' }),
      this.userModel
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select('-passwordHash -emailVerificationToken')
        .lean(),
      this.subscriptionModel.aggregate([
        { $match: { status: 'active' } },
        {
          $lookup: {
            from: 'plans',
            localField: 'planId',
            foreignField: '_id',
            as: 'plan',
          },
        },
        { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$plan.name',
            count: { $sum: 1 },
          },
        },
      ]),
      this.subscriptionModel.aggregate<{ total: number }>([
        {
          $match: {
            status: 'active',
            currentPeriodStart: { $gte: startOfMonth },
          },
        },
        {
          $lookup: {
            from: 'plans',
            localField: 'planId',
            foreignField: '_id',
            as: 'plan',
          },
        },
        { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [
                  { $eq: ['$billingCycle', 'yearly'] },
                  { $divide: ['$plan.yearlyPrice', 12] },
                  '$plan.monthlyPrice',
                ],
              },
            },
          },
        },
      ]),
    ]);

    return {
      totalUsers,
      totalWorkspaces,
      activeWorkspaces,
      newUsersLast7Days,
      proSubscriptions,
      monthlyRevenue: monthlyRevenueResult[0]?.total ?? 0,
      recentUsers,
      planBreakdown: Object.fromEntries(
        planBreakdown.map((item: { _id: string | null; count: number }) => [
          item._id || 'Unknown',
          item.count,
        ]),
      ),
    };
  }

  async getUserDetails(id: string) {
    const user = await this.userModel
      .findById(id)
      .select('-passwordHash -emailVerificationToken')
      .lean();
    if (!user) throw new NotFoundException('User not found');

    // Get owned workspaces
    const ownedWorkspaces = await this.workspaceModel
      .find({ ownerId: new Types.ObjectId(id) })
      .select('name isActive createdAt')
      .lean();

    // Get workspace memberships
    const memberships = await this.workspaceMemberModel
      .find({ userId: new Types.ObjectId(id) })
      .populate<{
        workspaceId: {
          _id: Types.ObjectId;
          name: string;
          isActive: boolean;
        } | null;
      }>('workspaceId', 'name isActive')
      .populate<{ roleId: { name: string } | null }>('roleId', 'name')
      .lean();

    // Get subscription
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(id),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan | null }>('planId', 'name tier monthlyPrice yearlyPrice')
      .populate<{ assignedBy: User | null }>('assignedBy', 'name email')
      .lean();

    // Create a map to track workspaces and avoid duplicates
    const workspaceMap = new Map<
      string,
      {
        _id: string;
        name: string | undefined;
        role: string;
        isActive: boolean | undefined;
        joinedAt: Date | undefined;
      }
    >();

    // Add owned workspaces first (owner role takes priority)
    ownedWorkspaces.forEach((ws) => {
      workspaceMap.set(ws._id.toString(), {
        _id: ws._id.toString(),
        name: ws.name,
        role: 'owner',
        isActive: ws.isActive,
        joinedAt: (ws as unknown as { createdAt?: Date }).createdAt,
      });
    });

    // Add memberships (skip if already exists as owner)
    memberships.forEach((m) => {
      const wsId = m.workspaceId?._id?.toString();
      if (wsId && !workspaceMap.has(wsId)) {
        workspaceMap.set(wsId, {
          _id: wsId,
          name: m.workspaceId?.name,
          role: m.roleId?.name ?? 'member',
          isActive: m.workspaceId?.isActive,
          joinedAt: m.joinedAt ?? (m as unknown as { createdAt?: Date }).createdAt,
        });
      }
    });

    const workspaces = Array.from(workspaceMap.values());

    return {
      user: {
        ...user,
        sessionLimitOverride: user.sessionLimitOverride ?? null,
      },
      workspaces,
      workspaceCount: workspaces.length,
      subscription: subscription
        ? {
            _id: subscription._id,
            planName: subscription.planId?.name ?? 'Unknown',
            planTier: subscription.planId?.tier ?? 'free',
            status: subscription.status,
            billingCycle: subscription.billingCycle,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            source: subscription.source,
            assignedBy: subscription.assignedBy
              ? {
                  name: subscription.assignedBy?.name,
                  email: subscription.assignedBy?.email,
                }
              : null,
            assignedAt: subscription.assignedAt,
            assignmentNote: subscription.assignmentNote,
            appliedEntitlements: subscription.appliedEntitlements,
            purchasedEntitlements: subscription.purchasedEntitlements,
          }
        : null,
    };
  }

  async getUsers(params: AdminPaginationDto) {
    const { page = 1, limit = 20, search, includeDeleted, includeDemo, product = 'all' } = params;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = { isAdmin: { $ne: true } };

    if (!includeDeleted) {
      filter['deletedAt'] = { $exists: false };
    }

    // Mirror the deleted filter: hide seeded demo/sample accounts (isDemo:true)
    // by default so they never pollute the real-user view. `$ne: true` also
    // matches rows where the field is absent (legacy/real users).
    if (!includeDemo) {
      filter['isDemo'] = { $ne: true };
    }

    if (search) {
      filter['$or'] = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { mobile: { $regex: search, $options: 'i' } },
      ];
    }

    // Product facet: constrain the candidate user set BEFORE pagination so page
    // counts stay correct. 'all'/absent adds no constraint. A bundle user holds
    // BOTH footprints, so it appears under erp, connect, and both.
    // NOTE: this materializes an id set; the documented scale-up path is a single
    // $lookup aggregation. Fine at current data size.
    if (product && product !== 'all') {
      let allow: Set<string>;
      if (product === 'connect') {
        allow = await this.connectFootprintUserIds();
      } else if (product === 'erp') {
        allow = await this.erpFootprintUserIds();
      } else {
        const [c, e] = await Promise.all([
          this.connectFootprintUserIds(),
          this.erpFootprintUserIds(),
        ]);
        allow = new Set([...c].filter((id) => e.has(id)));
      }
      filter['_id'] = { $in: Array.from(allow, (id) => new Types.ObjectId(id)) };
    }

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -emailVerificationToken')
        .lean(),
      this.userModel.countDocuments(filter),
    ]);

    const userIds = users.map((u) => u._id);

    // Early return if no users
    if (userIds.length === 0) {
      return { data: [], total, page, limit };
    }

    // Active/trial subscriptions for this page, split per product. A bundle sub
    // satisfies BOTH summaries (it grants ERP and Connect at once) — this is what
    // fixes the old conflation where a single "subscription" field could show the
    // wrong product.
    const subscriptions = await this.subscriptionModel
      .find({ userId: { $in: userIds }, status: { $in: ['active', 'trial'] } })
      .populate<{ planId: Plan | null }>('planId', 'name tier')
      .lean();

    type ProductSubSummary = {
      planName: string;
      planTier: string;
      status: string;
      product: string;
      // Trial end date when status is 'trial' (opt-in trials sit on the Free
      // plan with status:'trial'), else null. Read by admin/users/page.tsx to
      // render a "Trial" badge + end date. null, never undefined.
      trialEndsAt: Date | null;
    };
    const erpSubMap = new Map<string, ProductSubSummary>();
    const connectSubMap = new Map<string, ProductSubSummary>();
    for (const s of subscriptions) {
      const uid = (s.userId as Types.ObjectId).toHexString();
      const prod = s.product ?? 'erp';
      const summary: ProductSubSummary = {
        planName: s.planId?.name ?? 'Unknown',
        planTier: s.planId?.tier ?? 'free',
        status: s.status,
        product: prod,
        trialEndsAt: s.trialEndsAt ?? null,
      };
      if (prod === 'erp' || prod === 'bundle') erpSubMap.set(uid, summary);
      if (prod === 'connect' || prod === 'bundle') connectSubMap.set(uid, summary);
    }

    // Workspace counts — each user's unique workspace count via WorkspaceMember
    // records. Owners are also stored as WorkspaceMember entries, so a single
    // $addToSet on workspaceId deduplicates without double-counting.
    const workspaceCountMap = new Map<string, number>();
    try {
      const userObjectIds = userIds.map((id) => new Types.ObjectId(id));
      const workspaceStats = await this.workspaceMemberModel.aggregate<{
        _id: Types.ObjectId;
        count: number;
      }>([
        { $match: { userId: { $in: userObjectIds } } },
        { $group: { _id: '$userId', workspaceIds: { $addToSet: '$workspaceId' } } },
        { $project: { _id: 1, count: { $size: '$workspaceIds' } } },
      ]);
      workspaceStats.forEach((stat) => {
        workspaceCountMap.set(stat._id.toString(), stat.count);
      });
    } catch (countError: unknown) {
      console.error('[AdminService] Workspace count error:', countError);
    }

    // Connect footprint for this page: a ConnectProfile makes someone a Connect
    // user even with no paid Connect subscription (the free-fallback majority).
    const profileRows = await this.connectProfileModel
      .find({ userId: { $in: userIds } })
      .select('userId')
      .lean();
    const connectProfileSet = new Set(profileRows.map((p) => String(p.userId)));

    const enrichedUsers = users.map((user) => {
      const uid: string = user._id.toString();
      const workspaceCount: number = workspaceCountMap.get(uid) || 0;
      const erpSubscription = erpSubMap.get(uid) ?? null;
      const connectSubscription = connectSubMap.get(uid) ?? null;
      return {
        ...user,
        workspaceCount,
        // A person can be ERP-only, Connect-only, or both; a bundle user is both.
        isErpUser: workspaceCount > 0 || erpSubscription !== null,
        isConnectUser: connectProfileSet.has(uid) || connectSubscription !== null,
        erpSubscription,
        connectSubscription,
      };
    });

    return { data: enrichedUsers, total, page, limit };
  }

  /**
   * UserIds (as strings) of everyone with a CONNECT footprint: a ConnectProfile
   * (created on first Connect entry) OR an active/trial connect|bundle
   * subscription. Backs the `product=connect|both` users filter.
   */
  private async connectFootprintUserIds(): Promise<Set<string>> {
    const [profileIds, subIds] = await Promise.all([
      this.connectProfileModel.distinct('userId'),
      this.subscriptionModel.distinct('userId', {
        product: { $in: ['connect', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      }),
    ]);
    const set = new Set<string>();
    profileIds.forEach((id) => set.add(String(id)));
    subIds.forEach((id) => set.add(String(id)));
    return set;
  }

  /**
   * UserIds (as strings) of everyone with an ERP footprint: a workspace
   * membership OR an active/trial erp|bundle subscription. Backs the
   * `product=erp|both` users filter.
   */
  private async erpFootprintUserIds(): Promise<Set<string>> {
    const [memberIds, subIds] = await Promise.all([
      this.workspaceMemberModel.distinct('userId'),
      this.subscriptionModel.distinct('userId', {
        product: { $in: ['erp', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      }),
    ]);
    const set = new Set<string>();
    memberIds.forEach((id) => set.add(String(id)));
    subIds.forEach((id) => set.add(String(id)));
    return set;
  }

  async updateUserStatus(id: string, dto: UpdateUserStatusDto) {
    const updateData: Record<string, unknown> = { isActive: dto.isActive };

    if (dto.isActive === false) {
      updateData.deactivatedAt = new Date();
      updateData.deactivationNote = dto.note || undefined;
    } else {
      updateData.deactivationNote = undefined;
      updateData.deactivatedAt = undefined;
    }

    const user = await this.userModel
      .findByIdAndUpdate(id, { $set: updateData }, { returnDocument: 'after' })
      .select('-passwordHash -emailVerificationToken')
      .lean();
    if (!user) throw new NotFoundException('User not found');
    // OQ-2: isActive changed -> drop the JWT hot-path cache so a deactivation
    // takes effect on the next request, not after the access token expires.
    await this.userClaimsCache.invalidate(id);
    // CN-SRCH-2: refresh the Connect people index (suspend removes the person
    // from search; restore re-indexes them). Best-effort, fire-and-forget.
    this.eventEmitter.emit(CONNECT_PROFILE_CHANGED, { userId: id });
    return user;
  }

  async createUser(dto: CreateUserDto) {
    const email: string | undefined = dto.email;
    const mobile: string | undefined = dto.mobile;
    const createWorkspace: boolean | undefined = dto.createWorkspace;
    const workspaceName: string | undefined = dto.workspaceName;

    if (!email && !mobile) {
      throw new BadRequestException('Either email or mobile must be provided');
    }

    if (createWorkspace && !workspaceName) {
      throw new BadRequestException('Workspace name is required when creating workspace');
    }

    // Check for existing user
    if (email) {
      const existingEmail = await this.userModel.findOne({ email });
      if (existingEmail) {
        throw new ConflictException('User with this email already exists');
      }
    }
    if (dto.mobile) {
      const existingMobile = await this.userModel.findOne({
        mobile: dto.mobile,
      });
      if (existingMobile) {
        throw new ConflictException('User with this mobile already exists');
      }
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    const user = await this.userModel.create({
      name: dto.name,
      email: dto.email,
      mobile: dto.mobile,
      passwordHash,
      isActive: dto.isActive ?? true,
      isAdmin: dto.isAdmin ?? false,
      isEmailVerified: dto.isEmailVerified ?? false,
      deletedAt: undefined,
      hasWorkspace: dto.createWorkspace ?? false,
    });

    // Create workspace for the user if requested
    if (dto.createWorkspace && dto.workspaceName) {
      const workspace = new this.workspaceModel({
        name: dto.workspaceName,
        businessType: dto.workspaceBusinessType || 'General',
        ownerId: user._id,
        designations: ['Manager', 'Supervisor', 'Staff', 'Cashier'],
      });
      await workspace.save();

      const member = new this.workspaceMemberModel({
        workspaceId: workspace._id,
        userId: user._id,
        status: 'active',
        joinedAt: new Date(),
      });
      await member.save();

      await this.userModel.findByIdAndUpdate(user._id, { hasWorkspace: true });
    }

    const {
      passwordHash: _passwordHash,
      emailVerificationToken: _emailVerificationToken,
      ...safeUser
    } = user.toObject();
    return safeUser;
  }

  async deleteUser(id: string, permanent: boolean = false) {
    const user = await this.userModel.findById(id);
    if (!user) throw new NotFoundException('User not found');

    if (permanent) {
      // Find workspaces owned by this user
      const ownedWorkspaces = await this.workspaceModel.find({
        ownerId: new Types.ObjectId(id),
      });

      for (const ws of ownedWorkspaces) {
        const memberCount = await this.workspaceMemberModel.countDocuments({
          workspaceId: ws._id,
        });
        // If user is the only member (or sole owner), delete the workspace
        if (memberCount <= 1) {
          await this.workspaceMemberModel.deleteMany({ workspaceId: ws._id });
          await this.workspaceModel.findByIdAndDelete(ws._id);
        }
      }

      // Clean up memberships in other workspaces
      await this.workspaceMemberModel.deleteMany({
        userId: new Types.ObjectId(id),
      });

      // Delete user's subscriptions
      await this.subscriptionModel.deleteMany({
        userId: new Types.ObjectId(id),
      });

      await this.userModel.findByIdAndDelete(id);
      return { message: 'User permanently deleted' };
    } else {
      // Soft delete - set deletedAt and deactivate user
      user.deletedAt = new Date();
      user.isActive = false;
      await user.save();
      // OQ-2: isActive flipped to false -> drop the JWT hot-path cache.
      await this.userClaimsCache.invalidate(id);
      return { message: 'User soft deleted' };
    }
  }

  async restoreUser(id: string) {
    const user = await this.userModel.findById(id);
    if (!user) throw new NotFoundException('User not found');

    user.deletedAt = undefined;
    user.isActive = true;
    await user.save();
    // OQ-2: isActive flipped back to true -> drop the JWT hot-path cache.
    await this.userClaimsCache.invalidate(id);
    // CN-SRCH-2: re-index the restored user's Connect profile so they become
    // searchable again promptly. Best-effort, fire-and-forget.
    this.eventEmitter.emit(CONNECT_PROFILE_CHANGED, { userId: id });

    return user;
  }

  async getWorkspaces(params: AdminPaginationDto) {
    const { page = 1, limit = 20, search } = params;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (search) {
      filter['$or'] = [
        { name: { $regex: search, $options: 'i' } },
        { businessType: { $regex: search, $options: 'i' } },
      ];
    }

    const [workspaces, total] = await Promise.all([
      this.workspaceModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('ownerId', 'name email')
        .lean(),
      this.workspaceModel.countDocuments(filter),
    ]);

    return { data: workspaces, total, page, limit };
  }

  async getSubscriptions(params: AdminPaginationDto) {
    const { page = 1, limit = 20 } = params;
    const skip = (page - 1) * limit;

    // INTENTIONAL: side-effect cleanup - mark expired subscriptions
    const now = new Date();
    await this.subscriptionModel.updateMany(
      {
        status: { $in: ['active', 'trial'] },
        currentPeriodEnd: { $lt: now },
      },
      { $set: { status: 'expired' } },
    );

    const [subscriptions, total] = await Promise.all([
      this.subscriptionModel
        .find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('planId', 'name tier monthlyPrice yearlyPrice')
        .populate('userId', 'name email')
        .lean(),
      this.subscriptionModel.countDocuments(),
    ]);

    return { data: subscriptions, total, page, limit };
  }

  async getPlans(product?: string) {
    // Optional product-line filter (erp | connect | bundle). No product = all,
    // so existing ERP admin callers are unchanged.
    const plans = await this.planModel.find(product ? { product } : {}).lean();

    const plansWithCounts = await Promise.all(
      plans.map(async (plan) => {
        const subscriberCount = await this.subscriptionModel.countDocuments({
          planId: plan._id,
          status: { $in: ['active', 'trial', 'cancelled'] },
        });
        return {
          ...plan,
          activeSubscriberCount: subscriberCount,
        };
      }),
    );

    return plansWithCounts;
  }

  async createPlan(dto: CreatePlanDto) {
    const plan = new this.planModel(dto);
    // Trial plan = system plan, not buyable. Force it hidden from the public
    // pricing page on the saved doc (server-side, not from the DTO — the field
    // isn't whitelisted there). Done before save so the persisted doc is correct.
    if (dto.isTrialPlan === true) {
      (plan as { isPubliclyVisible?: boolean }).isPubliclyVisible = false;
    }
    const saved = await plan.save();

    // Phase 2: exactly ONE default plan per product. If this plan is being made
    // the default, atomically clear `isDefault` on every OTHER plan of the SAME
    // product (so a future Connect default stays independent from the ERP one).
    // `trialDurationDays` + `isDefault` flow in via the full `dto` above.
    if (dto.isDefault === true) {
      await this.planModel.updateMany(
        {
          _id: { $ne: saved._id },
          // saved.product is the persisted value (schema default 'erp' applied).
          product: (saved as { product?: string }).product ?? 'erp',
          isDefault: true,
        },
        { $set: { isDefault: false } },
      );
    }

    // Exactly ONE trial plan per product (mirrors isDefault). If this plan is
    // the trial plan, atomically clear `isTrialPlan` on every OTHER plan of the
    // SAME product (scoped so ERP/Connect trial plans stay independent).
    if (dto.isTrialPlan === true) {
      await this.planModel.updateMany(
        {
          _id: { $ne: saved._id },
          product: (saved as { product?: string }).product ?? 'erp',
          isTrialPlan: true,
        },
        { $set: { isTrialPlan: false } },
      );
    }

    return saved;
  }

  async updatePlan(id: string, dto: Partial<CreatePlanDto>) {
    const affectedSubscriberCount =
      dto.isActive === false
        ? await this.subscriptionModel.countDocuments({
            planId: new Types.ObjectId(id),
            status: { $in: ['active', 'trial', 'cancelled'] },
          })
        : 0;

    // Trial plan = system plan, not buyable. When this update flags the plan as
    // the trial plan, also force isPubliclyVisible:false in the SAME write (the
    // field isn't whitelisted on the DTO, so we set it server-side here).
    const setUpdate: Record<string, unknown> = { ...dto };
    if (dto.isTrialPlan === true) {
      setUpdate.isPubliclyVisible = false;
    }

    const plan = await this.planModel
      .findByIdAndUpdate(id, { $set: setUpdate }, { returnDocument: 'after' })
      .lean();
    if (!plan) throw new NotFoundException('Plan not found');

    // Phase 2: exactly ONE default plan per product. If this update sets the plan
    // as the default, atomically clear `isDefault` on every OTHER plan of the SAME
    // product (scoped so the ERP + Connect defaults stay independent). `dto` is
    // spread into `$set` above, so `trialDurationDays` + `isDefault` already persist.
    if (dto.isDefault === true) {
      await this.planModel.updateMany(
        {
          _id: { $ne: (plan as { _id: unknown })._id },
          product: (plan as { product?: string }).product ?? 'erp',
          isDefault: true,
        },
        { $set: { isDefault: false } },
      );
    }

    // Exactly ONE trial plan per product (mirrors isDefault). If this update
    // flags the plan as the trial plan, atomically clear `isTrialPlan` on every
    // OTHER plan of the SAME product (scoped so ERP/Connect stay independent).
    if (dto.isTrialPlan === true) {
      await this.planModel.updateMany(
        {
          _id: { $ne: (plan as { _id: unknown })._id },
          product: (plan as { product?: string }).product ?? 'erp',
          isTrialPlan: true,
        },
        { $set: { isTrialPlan: false } },
      );
    }

    const newPlatformAccess = dto.entitlements?.platformAccess;
    const currentPlatformAccess = (plan as { entitlements?: PlanEntitlements }).entitlements
      ?.platformAccess;

    let lockoutWarning: { message: string; affectedCount: number } | null = null;

    if (
      newPlatformAccess &&
      newPlatformAccess !== PlatformAccess.BOTH &&
      currentPlatformAccess === PlatformAccess.BOTH
    ) {
      const affectedSubs = await this.subscriptionModel
        .find({
          planId: new Types.ObjectId(id),
          status: { $in: ['active', 'trial'] },
        })
        .lean();

      const affectedUserIds = affectedSubs.map((s) => s.userId);

      const ownerAdmins = await this.workspaceMemberModel.countDocuments({
        userId: { $in: affectedUserIds },
        role: { $in: ['owner', 'admin'] },
      });

      if (ownerAdmins > 0) {
        lockoutWarning = {
          message: `This will restrict platform access for ${ownerAdmins} workspace ${ownerAdmins === 1 ? 'owner/admin' : 'owners/admins'}.`,
          affectedCount: ownerAdmins,
        };
      }
    }

    return {
      plan,
      affectedSubscriberCount,
      lockoutWarning,
    };
  }

  async deletePlan(id: string) {
    const subscriberCount = await this.subscriptionModel.countDocuments({
      planId: new Types.ObjectId(id),
      status: { $in: ['active', 'trial', 'cancelled'] },
    });

    if (subscriberCount > 0) {
      throw new BadRequestException(
        `Cannot delete plan with ${subscriberCount} active subscribers. Deactivate the plan instead.`,
      );
    }

    const plan = await this.planModel.findByIdAndDelete(id);
    if (!plan) throw new NotFoundException('Plan not found');
    return { message: 'Plan deleted successfully' };
  }

  async getUserSubscription(userId: string) {
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .populate<{ planId: Plan }>('planId', 'name tier monthlyPrice yearlyPrice entitlements')
      .populate<{ assignedBy: User }>('assignedBy', 'name email')
      .lean();
    if (!subscription) return null;
    return subscription;
  }

  async assignPlan(dto: AdminAssignPlanDto, adminUser: AdminUserContext) {
    // Validate ObjectId format
    if (!Types.ObjectId.isValid(dto.userId)) {
      throw new BadRequestException('Invalid user ID format');
    }
    if (!Types.ObjectId.isValid(dto.planId)) {
      throw new BadRequestException('Invalid plan ID format');
    }

    const [user, plan] = await Promise.all([
      this.userModel.findById(dto.userId).lean(),
      this.planModel.findById(dto.planId).lean(),
    ]);
    if (!user) throw new NotFoundException('User not found');
    if (!plan) throw new NotFoundException('Plan not found');
    if (!plan.isActive) throw new BadRequestException('Plan is not active');

    const userObjectId = new Types.ObjectId(dto.userId);

    // Denormalize the product from the plan (schema default 'erp') and supersede
    // ONLY the same product group — a Connect/bundle grant must never wipe the
    // user's ERP subscription, and vice versa.
    const product = plan.product ?? 'erp';
    const productGroup = supersededProducts(product);

    // Supersede active/trial subscriptions first (matching the unique partial index)
    const supersedeActiveResult = await this.subscriptionModel.updateMany(
      {
        userId: userObjectId,
        product: { $in: productGroup },
        status: { $in: ['active', 'trial'] },
      },
      { $set: { status: 'superseded' } },
    );
    this.logger.log(
      `assignPlan: superseded ${supersedeActiveResult.modifiedCount} active/trial ${product} subscriptions for user ${dto.userId}`,
    );

    // Then supersede other non-superseded statuses
    const supersedeOthersResult = await this.subscriptionModel.updateMany(
      {
        userId: userObjectId,
        product: { $in: productGroup },
        status: { $in: ['cancelled', 'expired', 'scheduled'] },
      },
      { $set: { status: 'superseded' } },
    );
    this.logger.log(
      `assignPlan: superseded ${supersedeOthersResult.modifiedCount} other ${product} subscriptions for user ${dto.userId}`,
    );

    const now = new Date();
    const periodEnd = new Date(now);
    if (dto.billingCycle === 'lifetime') {
      periodEnd.setFullYear(2099, 11, 31);
    } else if (dto.billingCycle === 'yearly') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    // ERP entitlements are normalized against the plan's tier; connect/bundle
    // entitlements are applied as authored so the `.connect` allowance block
    // (maxCompanyPages / maxStorefronts / maxJobs / …) survives intact — the ERP
    // tier normalizer knows nothing about Connect caps and would drop them.
    let entitlements = dto.entitlements as unknown as PlanEntitlements;
    if (product === 'erp') {
      const normalized = this.subscriptionsService.normalizeEntitlementsForTier(
        dto.entitlements as unknown as PlanEntitlements,
        plan.tier,
      );
      entitlements = normalized.entitlements;
      if (normalized.changed) {
        this.logger.warn(
          `assignPlan: normalized entitlements for user ${dto.userId} using tier ${plan.tier}`,
        );
      }
    }
    const subscription = new this.subscriptionModel({
      userId: userObjectId,
      planId: plan._id,
      product,
      status: 'active',
      billingCycle: dto.billingCycle,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      purchasedEntitlements: entitlements,
      appliedEntitlements: entitlements,
      source: 'admin',
      assignedBy: new Types.ObjectId(String(adminUser._id)),
      assignedAt: now,
      assignmentNote: dto.note,
    });

    try {
      return await subscription.save();
    } catch (error: unknown) {
      // Handle duplicate key error (E11000) - retry supersede once
      if ((error as { code?: number })?.code === 11000) {
        this.logger.warn(
          `assignPlan: Duplicate key error, retrying supersede for user ${dto.userId}`,
        );

        // Force supersede the same product group again (keeps other products safe)
        await this.subscriptionModel.updateMany(
          {
            userId: userObjectId,
            product: { $in: productGroup },
            status: { $in: ['active', 'trial'] },
          },
          { $set: { status: 'superseded' } },
        );

        // Retry save
        return await subscription.save();
      }
      throw error;
    }
  }

  async customAssignPlan(dto: AdminCustomAssignDto, adminUser: AdminUserContext) {
    // Validate ObjectId format
    if (!Types.ObjectId.isValid(dto.userId)) {
      throw new BadRequestException('Invalid user ID format');
    }
    if (dto.planId && !Types.ObjectId.isValid(dto.planId)) {
      throw new BadRequestException('Invalid plan ID format');
    }

    const user = await this.userModel.findById(dto.userId).lean();
    if (!user) throw new NotFoundException('User not found');

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    const now = new Date();
    if (endDate <= startDate) {
      throw new BadRequestException('End date must be after start date');
    }
    if (endDate <= now) {
      throw new BadRequestException('End date must be in the future');
    }

    const moduleAccess = dto.entitlements.moduleAccess || [];
    if (moduleAccess.length > 0) {
      const validation = validateModuleAccess(moduleAccess);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid module access: ${validation.errors.join(', ')}`);
      }
    }

    let planId: Types.ObjectId;
    let normalizationTier = PlanTier.CUSTOM;
    // Product line: explicit DTO value wins; else the base plan's product; else erp.
    let product: string = (dto.product as string | undefined) ?? 'erp';
    if (dto.planId) {
      const plan = await this.planModel.findById(dto.planId).lean();
      if (!plan) throw new NotFoundException('Plan not found');
      planId = plan._id;
      normalizationTier = plan.tier as PlanTier;
      if (!dto.product) product = plan.product ?? 'erp';
    } else {
      let customPlan = await this.planModel
        .findOne({ name: 'Custom (Admin Assigned)', isActive: false })
        .lean();
      if (!customPlan) {
        customPlan = new this.planModel({
          name: 'Custom (Admin Assigned)',
          tier: PlanTier.CUSTOM,
          isActive: false,
          monthlyPrice: 0,
          yearlyPrice: 0,
          entitlements: {
            maxWorkspaces: 1,
            maxMembersPerWorkspace: 5,
            maxTotalMembers: 5,
            modules: [],
            features: {},
          },
        });
        await customPlan.save();
      }
      planId = customPlan._id;
      normalizationTier = customPlan.tier as PlanTier;
    }

    const userObjectId = new Types.ObjectId(dto.userId);
    // Supersede only the same product group so a custom Connect/bundle grant
    // never wipes the user's ERP subscription (and vice versa).
    const productGroup = supersededProducts(product);

    // Supersede active/trial subscriptions first (matching the unique partial index)
    const supersedeActiveResult = await this.subscriptionModel.updateMany(
      {
        userId: userObjectId,
        product: { $in: productGroup },
        status: { $in: ['active', 'trial'] },
      },
      { $set: { status: 'superseded' } },
    );
    this.logger.log(
      `customAssignPlan: superseded ${supersedeActiveResult.modifiedCount} active/trial ${product} subscriptions for user ${dto.userId}`,
    );

    // Then supersede other non-superseded statuses
    const supersedeOthersResult = await this.subscriptionModel.updateMany(
      {
        userId: userObjectId,
        product: { $in: productGroup },
        status: { $in: ['cancelled', 'expired', 'scheduled'] },
      },
      { $set: { status: 'superseded' } },
    );
    this.logger.log(
      `customAssignPlan: superseded ${supersedeOthersResult.modifiedCount} other ${product} subscriptions for user ${dto.userId}`,
    );

    // ERP entitlements are tier-normalized; connect/bundle entitlements are
    // applied as authored so the `.connect` allowance block survives intact.
    let entitlements = dto.entitlements as unknown as PlanEntitlements;
    if (product === 'erp') {
      const normalized = this.subscriptionsService.normalizeEntitlementsForTier(
        dto.entitlements as unknown as PlanEntitlements,
        normalizationTier,
      );
      entitlements = normalized.entitlements;
      if (normalized.changed) {
        this.logger.warn(
          `customAssignPlan: normalized entitlements for user ${dto.userId} using tier ${normalizationTier}`,
        );
      }
    }

    const subscription = new this.subscriptionModel({
      userId: userObjectId,
      planId,
      product,
      status: dto.status || 'active',
      billingCycle: dto.billingCycle,
      currentPeriodStart: startDate,
      currentPeriodEnd: endDate,
      purchasedEntitlements: entitlements,
      appliedEntitlements: entitlements,
      source: 'admin',
      assignedBy: new Types.ObjectId(String(adminUser._id)),
      assignedAt: now,
      assignmentNote: dto.note,
    });

    this.logger.log(
      `Creating new subscription with status: ${subscription.status}, planId: ${String(planId)}`,
    );

    try {
      const saved = await subscription.save();
      this.logger.log(`Subscription saved with _id: ${String(saved._id)}, status: ${saved.status}`);
      return saved;
    } catch (error: unknown) {
      // Handle duplicate key error (E11000) - retry supersede once
      if ((error as { code?: number })?.code === 11000) {
        this.logger.warn(
          `customAssignPlan: Duplicate key error, retrying supersede for user ${dto.userId}`,
        );

        // Force supersede the same product group again (keeps other products safe)
        await this.subscriptionModel.updateMany(
          {
            userId: userObjectId,
            product: { $in: productGroup },
            status: { $in: ['active', 'trial'] },
          },
          { $set: { status: 'superseded' } },
        );

        // Retry save
        const saved = await subscription.save();
        this.logger.log(
          `Subscription saved on retry with _id: ${String(saved._id)}, status: ${saved.status}`,
        );
        return saved;
      }
      throw error;
    }
  }

  /**
   * Admin-side counterpart to signup auto-assign: put a user who currently has
   * NO active/trial ERP plan onto the configured DEFAULT ERP plan, ACTIVE.
   *
   * Why NOT just call subscriptionsService.createFreeSubscription here:
   * createFreeSubscription's idempotency guard is `findOne({ userId })` —
   * it returns the EXISTING sub whenever ANY sub exists (active OR a stale
   * expired/cancelled/superseded one). So a user whose only sub is stale would
   * get that stale sub handed back, NOT a fresh active one — the no-active-plan
   * user we are trying to fix would stay without a live plan. Instead we reuse
   * the assignPlan-style supersede+create-active path (resolving the SAME
   * default plan getDefaultPlanId returns), which GUARANTEES the user ends up
   * ACTIVE on the default plan regardless of any stale rows. Signup-time
   * auto-assign is untouched; this is purely the admin-side ability.
   *
   * Idempotent: a user who already holds an active/trial ERP/bundle sub is left
   * alone (returns assigned:false) — never duplicated.
   */
  async assignDefaultPlan(
    userId: string,
    adminUser: AdminUserContext,
    opts?: { note?: string },
  ): Promise<{ assigned: boolean; reason?: string; planName?: string }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    const user = await this.userModel.findById(userId).lean();
    if (!user) throw new NotFoundException('User not found');

    // Resolve the SAME default ERP plan signup uses (isDefault -> free fallback).
    const planId = await this.subscriptionsService.getDefaultPlanId('erp');
    if (!planId) {
      throw new NotFoundException(
        'No default ERP plan configured. Set a default plan in Plans first.',
      );
    }

    const userObjectId = new Types.ObjectId(userId);

    // Skip (don't duplicate) when the user already has a live ERP/bundle plan.
    const existingActive = await this.subscriptionModel
      .findOne({
        userId: userObjectId,
        product: { $in: ['erp', 'bundle'] },
        status: { $in: ['active', 'trial'] },
      })
      .lean();
    if (existingActive) {
      return { assigned: false, reason: 'already-has-plan' };
    }

    const plan = await this.planModel.findById(planId).lean();
    if (!plan) {
      // getDefaultPlanId returned an id but the plan vanished — treat as "none".
      throw new NotFoundException(
        'No default ERP plan configured. Set a default plan in Plans first.',
      );
    }

    const created = await this.assignDefaultPlanInternal(userObjectId, plan, adminUser, opts?.note);

    // Audit the admin write (swallow-on-failure — never block the assignment).
    await this.auditService
      .logEvent({
        module: AppModule.SUBSCRIPTION,
        entityType: 'subscription',
        entityId: created._id,
        action: 'admin_assign_default',
        actorId: String(adminUser._id),
        after: { userId: String(userObjectId), planId: String(plan._id) },
      })
      .catch(() => undefined);

    return { assigned: true, planName: plan.name };
  }

  /**
   * Shared assign path for assignDefaultPlan + the bulk backfill: supersede the
   * user's stale ERP/bundle subs (mirrors assignPlan) then create a fresh ACTIVE
   * sub on the resolved default plan. ERP entitlements are tier-normalized like
   * assignPlan. `now` makes the period maths deterministic for tests. Returns the
   * saved subscription (its _id is the audit entityId).
   */
  private async assignDefaultPlanInternal(
    userObjectId: Types.ObjectId,
    plan: Plan & { _id: unknown },
    adminUser: AdminUserContext,
    note?: string,
    now: Date = new Date(),
  ) {
    const product = plan.product ?? 'erp';
    const productGroup = supersededProducts(product);

    // Supersede any stale same-product subs so the unique partial index is free.
    await this.subscriptionModel.updateMany(
      {
        userId: userObjectId,
        product: { $in: productGroup },
        status: { $in: ['active', 'trial', 'cancelled', 'expired', 'scheduled'] },
      },
      { $set: { status: 'superseded' } },
    );

    // Never-expiring active period (mirrors createFreeSubscription's no-trial arm)
    // — admin backfill lands users straight on the plan's real entitlements.
    // Deliberate: admin backfill always grants the plan directly (ACTIVE), never a
    // trial countdown, even if the default plan defines trialDurationDays > 0 — a
    // backfill of existing no-plan users is not a signup, so no trial applies.
    const periodEnd = new Date(now);
    periodEnd.setFullYear(periodEnd.getFullYear() + 100);

    let entitlements = plan.entitlements;
    if (product === 'erp') {
      entitlements = this.subscriptionsService.normalizeEntitlementsForTier(
        plan.entitlements,
        plan.tier,
      ).entitlements;
    }

    const subscription = new this.subscriptionModel({
      userId: userObjectId,
      planId: plan._id,
      product,
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      purchasedEntitlements: entitlements,
      appliedEntitlements: entitlements,
      source: 'admin',
      assignedBy: new Types.ObjectId(String(adminUser._id)),
      assignedAt: now,
      assignmentNote: note,
    });

    try {
      return await subscription.save();
    } catch (error: unknown) {
      // E11000 retry once — re-supersede the same product group (mirrors assignPlan).
      if ((error as { code?: number })?.code === 11000) {
        await this.subscriptionModel.updateMany(
          {
            userId: userObjectId,
            product: { $in: productGroup },
            status: { $in: ['active', 'trial'] },
          },
          { $set: { status: 'superseded' } },
        );
        return await subscription.save();
      }
      throw error;
    }
  }

  /**
   * Bulk backfill: assign the configured DEFAULT ERP plan to every user who has
   * NO active/trial ERP plan. Candidate set = non-admin, non-soft-deleted users
   * whose userId is NOT in the distinct set of users with an active/trial
   * erp|bundle subscription (the same `distinct` idiom erpFootprintUserIds uses).
   * Each candidate goes through assignDefaultPlan, so the whole pass is idempotent
   * and safe to re-run (a user assigned on an earlier run is excluded next time).
   */
  async assignDefaultPlanToUsersWithoutPlan(
    adminUser: AdminUserContext,
    opts?: { note?: string },
  ): Promise<{ assigned: number; skipped: number; failed: number; total: number }> {
    // Resolve the default plan once up front so we 404 before doing any work.
    const planId = await this.subscriptionsService.getDefaultPlanId('erp');
    if (!planId) {
      throw new NotFoundException(
        'No default ERP plan configured. Set a default plan in Plans first.',
      );
    }

    // UserIds already covered by a live ERP/bundle plan — exclude them.
    const coveredIds = await this.subscriptionModel.distinct('userId', {
      product: { $in: ['erp', 'bundle'] },
      status: { $in: ['active', 'trial'] },
    });
    const coveredObjectIds = coveredIds.map((id) => new Types.ObjectId(String(id)));

    const candidates = await this.userModel
      .find({
        isAdmin: { $ne: true },
        deletedAt: { $exists: false },
        _id: { $nin: coveredObjectIds },
      })
      .select('_id')
      .lean();

    let assigned = 0;
    let skipped = 0;
    let failed = 0;
    // Sequential on purpose: keeps DB load bounded and lets each per-user assign
    // run its own supersede+create safely (the candidate set already excludes
    // active users, but the per-user idempotency guard is a belt-and-braces skip).
    for (const candidate of candidates) {
      // Isolate each row: a single user's failure (a surviving E11000, a
      // transient DB error, or a NotFound from a race) must NOT abort the whole
      // backfill and lose the users already assigned earlier in the pass. Count
      // it as failed, log the offending userId, and continue.
      try {
        const result = await this.assignDefaultPlan(String(candidate._id), adminUser, opts);
        if (result.assigned) assigned += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `assignDefaultPlan failed for user ${String(candidate._id)}`,
          err as Error,
        );
      }
    }

    this.logger.log(
      `assignDefaultPlanToUsersWithoutPlan: assigned=${assigned} skipped=${skipped} failed=${failed} total=${candidates.length}`,
    );
    return { assigned, skipped, failed, total: candidates.length };
  }

  async updateSubscription(id: string, dto: AdminUpdateSubscriptionDto) {
    const subscription = await this.subscriptionModel
      .findById(id)
      .populate<{ planId: Plan }>('planId', 'tier')
      .lean();
    if (!subscription) throw new NotFoundException('Subscription not found');

    const updateData: {
      status?: string;
      currentPeriodEnd?: Date;
      appliedEntitlements?: PlanEntitlements;
      assignmentNote?: string;
    } = {};
    if (dto.status) updateData.status = dto.status;
    if (dto.currentPeriodEnd) updateData.currentPeriodEnd = new Date(dto.currentPeriodEnd);
    if (dto.entitlements) {
      updateData.appliedEntitlements = this.subscriptionsService.normalizeEntitlementsForTier(
        dto.entitlements as unknown as PlanEntitlements,
        subscription.planId?.tier,
      ).entitlements;
    }
    if (dto.note !== undefined) updateData.assignmentNote = dto.note;

    const updated = await this.subscriptionModel
      .findByIdAndUpdate(id, { $set: updateData }, { returnDocument: 'after' })
      .populate<{ planId: Plan }>('planId', 'name tier')
      .populate<{ assignedBy: User }>('assignedBy', 'name email')
      .lean();
    return updated;
  }

  async cancelSubscription(
    id: string,
    dto: { note?: string },
  ): Promise<{ message: string; currentPeriodEnd?: Date }> {
    const subscription = await this.subscriptionModel.findById(id).lean();
    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    if (!['active', 'trial'].includes(subscription.status)) {
      throw new BadRequestException(
        `Cannot cancel subscription with status: ${subscription.status}`,
      );
    }

    this.logger.log(`[cancelSubscription] Gracefully cancelling subscription ${id}`);

    // Just mark as cancelled - user keeps access until currentPeriodEnd
    await this.subscriptionModel.findByIdAndUpdate(id, {
      $set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        ...(dto.note ? { assignmentNote: dto.note } : {}),
      },
    });

    const periodEnd = subscription.currentPeriodEnd?.toLocaleDateString() || 'unknown';
    this.logger.log(
      `[cancelSubscription] Subscription cancelled - user retains access until ${periodEnd}`,
    );

    return {
      message: `Subscription cancelled. User retains access until ${periodEnd}`,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  async revokeSubscription(
    id: string,
    adminUser: AdminUserContext,
    dto: {
      action: 'no-plan' | 'assign-free' | 'assign-plan';
      targetPlanId?: string;
      note?: string;
    },
  ) {
    this.logger.log(
      `[revokeSubscription] START - subscriptionId=${id}, action=${dto.action}, targetPlanId=${dto.targetPlanId}`,
    );

    // Find the subscription to revoke
    const subscription = await this.subscriptionModel.findById(id).lean();

    if (!subscription) {
      this.logger.error(`[revokeSubscription] Subscription ${id} not found`);
      throw new NotFoundException('Subscription not found');
    }

    if (!['active', 'trial', 'cancelled'].includes(subscription.status)) {
      this.logger.error(
        `[revokeSubscription] Subscription ${id} has status ${subscription.status}, cannot revoke`,
      );
      throw new BadRequestException(
        `Cannot revoke subscription with status: ${subscription.status}`,
      );
    }

    const userObjectId = subscription.userId as Types.ObjectId;
    const userId = userObjectId.toString();

    this.logger.log(
      `[revokeSubscription] Found subscription for user ${userId}, current status: ${subscription.status}`,
    );

    // Step 1: Supersede ALL existing subscriptions (active, trial, cancelled, expired, scheduled)
    // This ensures clean state before creating new subscription
    const supersedeActiveResult = await this.subscriptionModel.updateMany(
      { userId: userObjectId, status: { $in: ['active', 'trial'] } },
      { $set: { status: 'superseded', cancelledAt: new Date() } },
    );
    this.logger.log(
      `[revokeSubscription] Superseded ${supersedeActiveResult.modifiedCount} active/trial subscriptions`,
    );

    const supersedeOthersResult = await this.subscriptionModel.updateMany(
      {
        userId: userObjectId,
        status: { $in: ['cancelled', 'expired', 'scheduled'] },
      },
      { $set: { status: 'superseded' } },
    );
    this.logger.log(
      `[revokeSubscription] Superseded ${supersedeOthersResult.modifiedCount} other subscriptions`,
    );

    // Step 1.5: Cancel all active add-ons for this user
    try {
      await this.addOnsService.cancelAllUserAddOns(userId, 'Subscription revoked by admin');
      this.logger.log(`[revokeSubscription] Cancelled all active add-ons for user ${userId}`);
    } catch (error) {
      this.logger.error(`[revokeSubscription] Error cancelling add-ons:`, error);
    }

    // If no-plan, we're done — user has no active subscription
    if (dto.action === 'no-plan') {
      this.logger.log(
        `[revokeSubscription] Action is no-plan, user ${userId} has no active subscription`,
      );
      return { message: 'Subscription revoked — user has no active plan' };
    }

    // Step 2: Determine which plan to assign
    let targetPlan: Plan | null = null;

    if (dto.action === 'assign-free') {
      targetPlan = await this.planModel.findOne({ tier: PlanTier.FREE, isActive: true }).lean();
      if (!targetPlan) {
        this.logger.error('[revokeSubscription] No active free plan found');
        throw new NotFoundException('No active free plan found');
      }
      this.logger.log(
        `[revokeSubscription] Found free plan: ${String(targetPlan._id)} (${targetPlan.name})`,
      );
    } else if (dto.action === 'assign-plan') {
      if (!dto.targetPlanId) {
        this.logger.error('[revokeSubscription] targetPlanId is required but not provided');
        throw new BadRequestException('targetPlanId is required when action is assign-plan');
      }
      targetPlan = await this.planModel.findById(dto.targetPlanId).lean();
      if (!targetPlan) {
        this.logger.error(`[revokeSubscription] Target plan ${dto.targetPlanId} not found`);
        throw new NotFoundException('Target plan not found');
      }
      if (!targetPlan.isActive) {
        this.logger.error(`[revokeSubscription] Target plan ${dto.targetPlanId} is not active`);
        throw new BadRequestException('Target plan is not active');
      }
      this.logger.log(
        `[revokeSubscription] Found target plan: ${String(targetPlan._id)} (${targetPlan.name})`,
      );
    }

    // Step 3: Create new subscription
    const now = new Date();
    const periodEnd = new Date(now);

    // Free plans get 100 years, paid plans get standard billing cycle
    if ((targetPlan.tier as PlanTier) === PlanTier.FREE) {
      periodEnd.setFullYear(periodEnd.getFullYear() + 100);
    } else {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1); // Default to yearly for admin-assigned
    }

    const newSubscription = new this.subscriptionModel({
      userId: userObjectId,
      planId: targetPlan._id,
      status: 'active',
      billingCycle: (targetPlan.tier as PlanTier) === PlanTier.FREE ? 'monthly' : 'yearly',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      purchasedEntitlements: targetPlan.entitlements,
      appliedEntitlements: targetPlan.entitlements,
      source: 'admin',
      assignedBy: new Types.ObjectId(String(adminUser._id)),
      assignedAt: now,
      assignmentNote: dto.note || `Force cancelled and assigned ${targetPlan.name}`,
      previousSubscriptionId: new Types.ObjectId(id),
    });

    this.logger.log(
      `[revokeSubscription] Creating new subscription with plan ${String(targetPlan._id)}`,
    );

    try {
      const saved = await newSubscription.save();
      this.logger.log(
        `[revokeSubscription] SUCCESS - Created new subscription ${String(saved._id)} for user ${userId}`,
      );
      return {
        message: `Subscription revoked and ${targetPlan.name} plan assigned`,
      };
    } catch (error: unknown) {
      this.logger.error(`[revokeSubscription] Error saving new subscription:`, error);

      // Handle duplicate key error (E11000) - retry supersede once
      if ((error as { code?: number })?.code === 11000) {
        this.logger.warn(
          `[revokeSubscription] Duplicate key error, retrying supersede for user ${userId}`,
        );

        // Force supersede all active/trial again
        await this.subscriptionModel.updateMany(
          { userId: userObjectId, status: { $in: ['active', 'trial'] } },
          { $set: { status: 'superseded' } },
        );

        // Retry save
        const saved = await newSubscription.save();
        this.logger.log(
          `[revokeSubscription] SUCCESS on retry - Created subscription ${String(saved._id)}`,
        );
        return {
          message: `Subscription revoked and ${targetPlan.name} plan assigned`,
        };
      }
      throw error;
    }
  }

  async repairModuleAccess() {
    return this.subscriptionsService.repairEmptyModuleAccess();
  }

  async repairMissingSubFeatures() {
    return this.subscriptionsService.repairMissingSubFeatures();
  }

  async getUserSubscriptionHistory(userId: string) {
    return this.subscriptionModel
      .find({ userId: new Types.ObjectId(userId) })
      .populate('planId', 'name tier monthlyPrice yearlyPrice')
      .populate('assignedBy', 'name email')
      .sort({ currentPeriodStart: -1 })
      .lean();
  }

  async getTiers(product?: string) {
    // Optional product-line filter (erp | connect | bundle). No product = all.
    const tiers = await this.tierModel
      .find(product ? { product } : {})
      .sort({ displayOrder: 1 })
      .lean();
    return tiers;
  }

  async createTier(dto: CreateTierDto) {
    const existing = await this.tierModel.findOne({ key: dto.key });
    if (existing) {
      throw new ConflictException('Tier with this key already exists');
    }
    const tier = new this.tierModel(dto);
    await this.subscriptionsService.refreshTierCache();
    return tier.save();
  }

  async updateTier(id: string, dto: UpdateTierDto) {
    const tier = await this.tierModel
      .findByIdAndUpdate(id, { $set: dto }, { returnDocument: 'after' })
      .lean();
    if (!tier) throw new NotFoundException('Tier not found');
    await this.subscriptionsService.refreshTierCache();
    return tier;
  }

  async deleteTier(id: string) {
    const plansUsingTier = await this.planModel.countDocuments({
      tier: id,
      isActive: true,
    });
    if (plansUsingTier > 0) {
      throw new BadRequestException(
        `Cannot delete tier with ${plansUsingTier} active plans. Deactivate the plans first.`,
      );
    }
    const tier = await this.tierModel.findByIdAndDelete(id);
    if (!tier) throw new NotFoundException('Tier not found');
    await this.subscriptionsService.refreshTierCache();
    return { message: 'Tier deleted successfully' };
  }

  async updateUserSessionLimit(
    userId: string,
    sessionLimitOverride: number | null,
    actorId: string,
  ) {
    const before = await this.userModel
      .findById(userId)
      .select('sessionLimitOverride')
      .lean<{ sessionLimitOverride?: number | null }>()
      .exec();
    if (!before) throw new NotFoundException('User not found');

    const updated = await this.userModel
      .findByIdAndUpdate(userId, { $set: { sessionLimitOverride } }, { returnDocument: 'after' })
      .select('sessionLimitOverride')
      .lean<{ sessionLimitOverride?: number | null }>()
      .exec();
    if (!updated) throw new NotFoundException('User not found');

    const beforeValue = before.sessionLimitOverride ?? null;
    const afterValue = updated.sessionLimitOverride ?? null;

    await this.auditService
      .logEvent({
        module: AppModule.AUTH,
        entityType: 'user',
        entityId: userId,
        action: 'admin_update_session_limit',
        actorId,
        before: { sessionLimitOverride: beforeValue },
        after: { sessionLimitOverride: afterValue },
      })
      .catch(() => undefined);

    return { sessionLimitOverride: afterValue };
  }

  async getWorkspaceDetail(id: string) {
    const workspace = await this.workspaceModel
      .findById(id)
      // Workspaces hardening OQ-W8: `pass` is now `select: false`. Re-include it
      // ONLY so the masking decision below (`pass ? '••••••••' : ''`) reflects
      // whether a password is actually set — the spread overwrites it with the
      // mask, so the real encrypted value never leaves this method.
      .select('+emailConfig.smtpConfig.pass')
      .populate('ownerId', 'name email')
      .lean()
      .exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    const ownerIdValue =
      (workspace.ownerId as { _id?: Types.ObjectId } | Types.ObjectId | null)?.constructor ===
      Types.ObjectId
        ? (workspace.ownerId as Types.ObjectId)
        : ((workspace.ownerId as { _id?: Types.ObjectId })?._id ?? workspace.ownerId);

    const sub = await this.subscriptionModel
      .findOne({
        userId: ownerIdValue,
        status: { $in: ['active', 'trial'] },
      })
      .select('appliedEntitlements.emailsPerMonth status planId')
      .lean()
      .exec();

    const emailConfig = workspace.emailConfig
      ? {
          emailLimitOverride: workspace.emailConfig.emailLimitOverride ?? null,
          usage: workspace.emailConfig.usage ?? { count: 0, monthKey: '' },
          smtpConfig: workspace.emailConfig.smtpConfig
            ? {
                ...workspace.emailConfig.smtpConfig,
                pass: workspace.emailConfig.smtpConfig.pass ? '••••••••' : '',
              }
            : undefined,
        }
      : undefined;

    return {
      ...workspace,
      emailConfig,
      planEmailLimit:
        (sub?.appliedEntitlements as { emailsPerMonth?: number } | undefined)?.emailsPerMonth ?? 0,
    };
  }

  async updateWorkspaceEmailConfig(
    id: string,
    config: {
      emailLimitOverride?: number | null;
      smtpConfig?: {
        host?: string;
        port?: number;
        user?: string;
        pass?: string;
        fromEmail?: string;
        fromName?: string;
        secure?: boolean;
        enabled?: boolean;
      };
    },
  ) {
    const workspace = await this.workspaceModel.findById(id).exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    const update: Record<string, unknown> = {};
    if (config.emailLimitOverride !== undefined) {
      update['emailConfig.emailLimitOverride'] = config.emailLimitOverride;
    }
    if (config.smtpConfig) {
      const smtp = config.smtpConfig;
      if (smtp.host !== undefined) update['emailConfig.smtpConfig.host'] = smtp.host;
      if (smtp.port !== undefined) update['emailConfig.smtpConfig.port'] = smtp.port;
      if (smtp.user !== undefined) update['emailConfig.smtpConfig.user'] = smtp.user;
      if (smtp.pass !== undefined && smtp.pass !== '••••••••') {
        update['emailConfig.smtpConfig.pass'] = encryptSmtpPassword(smtp.pass);
      }
      if (smtp.fromEmail !== undefined) update['emailConfig.smtpConfig.fromEmail'] = smtp.fromEmail;
      if (smtp.fromName !== undefined) update['emailConfig.smtpConfig.fromName'] = smtp.fromName;
      if (smtp.secure !== undefined) update['emailConfig.smtpConfig.secure'] = smtp.secure;
      if (smtp.enabled !== undefined) update['emailConfig.smtpConfig.enabled'] = smtp.enabled;
    }

    await this.workspaceModel.updateOne({ _id: id }, { $set: update });
    return { message: 'Email config updated' };
  }

  async testSmtpConnection(id: string, adminEmail: string) {
    // Workspaces hardening OQ-W8: the SMTP `pass` field is now `select: false`,
    // so re-include it explicitly — this is a functional reader (the SMTP test
    // decrypts and authenticates with the real password).
    const workspace = await this.workspaceModel
      .findById(id)
      .select('+emailConfig.smtpConfig.pass')
      .lean()
      .exec();
    if (!workspace) throw new NotFoundException('Workspace not found');

    const smtp = workspace.emailConfig?.smtpConfig;
    if (!smtp?.host || !smtp.user || !smtp.pass || !smtp.fromEmail) {
      throw new BadRequestException('SMTP config is incomplete');
    }

    let plainPass: string;
    try {
      plainPass = decryptSmtpPassword(smtp.pass);
    } catch {
      throw new BadRequestException('Failed to decrypt SMTP password — re-save the config');
    }

    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port || 587,
      secure: smtp.secure ?? true,
      auth: { user: smtp.user, pass: plainPass },
    });

    try {
      await transport.verify();
      await transport.sendMail({
        from: `"${smtp.fromName || workspace.name}" <${smtp.fromEmail}>`,
        to: adminEmail,
        subject: 'ManekHR SMTP Test',
        text: `SMTP connection for workspace "${workspace.name}" is working correctly.`,
      });
      return { success: true, message: 'Test email sent successfully' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(`SMTP test failed: ${message}`);
    }
  }

  async resetWorkspaceEmailUsage(id: string) {
    const workspace = await this.workspaceModel.findById(id).exec();
    if (!workspace) throw new NotFoundException('Workspace not found');
    await this.workspaceModel.updateOne(
      { _id: id },
      {
        $set: {
          'emailConfig.usage.count': 0,
          'emailConfig.usage.monthKey': '',
        },
      },
    );
    return { message: 'Email usage reset' };
  }
}
