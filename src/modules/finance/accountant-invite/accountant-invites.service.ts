import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { env } from '../../../config/env';
import { AccountantInvite } from './accountant-invite.schema';
import { assertInviteEmailMatch } from './accountant-invite.rules';
import { User } from '../../users/schemas/user.schema';
import { MailerService } from '@nestjs-modules/mailer';
import { randomUUID } from 'crypto';
// Platform-bar observability (mirrors finance sub-modules): shared finance tracer +
// fire-and-forget PostHog on successful writes. PostHogService is @Global so no module
// import is needed. PII rule: never emit the invite token or the invitee email - ids,
// scopeRole, and counts only.
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';

@Injectable()
export class AccountantInvitesService {
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(AccountantInvite.name) private readonly model: Model<AccountantInvite>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly mailerService: MailerService,
    private readonly postHog: PostHogService,
  ) {}

  async invite(
    workspaceId: string,
    firmId: string,
    dto: {
      email: string;
      scopeRole?: string;
      modulePermissions?: Array<{ module: string; access: string }>;
    },
  ): Promise<AccountantInvite> {
    // Span-only wrap: this signature carries no userId (actor), so per the
    // observability rule we emit a span but SKIP the PostHog event. The invitee
    // email is PII and is never emitted; span carries ids + scopeRole + counts only.
    return withFinanceSpan(
      this.tracer,
      'finance.createAccountantInvite',
      {
        workspaceId,
        firmId,
        scopeRole: dto.scopeRole ?? 'read_only',
        permissionCount: dto.modulePermissions?.length ?? 3,
      },
      async () => {
        const token = randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const defaultPermissions = [
          { module: 'finance', access: 'read' },
          { module: 'salary', access: 'read' },
          { module: 'team', access: 'read' },
        ];

        const doc = await this.model
          .findOneAndUpdate(
            { firmId: new Types.ObjectId(firmId), email: dto.email },
            {
              $set: {
                workspaceId: new Types.ObjectId(workspaceId),
                firmId: new Types.ObjectId(firmId),
                email: dto.email,
                scopeRole: dto.scopeRole ?? 'read_only',
                modulePermissions: dto.modulePermissions ?? defaultPermissions,
                status: 'pending',
                token,
                expiresAt,
              },
            },
            { upsert: true, new: true },
          )
          .exec();

        // Send invite email
        try {
          const appUrl = env.nextPublicAppUrl;
          await this.mailerService.sendMail({
            to: dto.email,
            subject: 'You have been invited as an accountant',
            html: `<p>You have been invited to access accounting data. Click <a href="${appUrl}/accept-invite?token=${token}">here</a> to accept (expires in 7 days).</p>`,
          });
        } catch (e) {
          // Do not fail invite creation if email fails — log and continue
          console.warn('AccountantInvite email failed:', (e as Error).message);
        }

        return doc as AccountantInvite;
      },
    );
  }

  async findAll(workspaceId: string, firmId: string): Promise<AccountantInvite[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      })
      .exec();
  }

  async accept(token: string, userId: string): Promise<void> {
    // Observability wrap (additive): this write has the accepting user's id, so it
    // gets a span AND a fire-and-forget PostHog event after the successful accept.
    return withFinanceSpan(
      this.tracer,
      'finance.acceptAccountantInvite',
      { userId: userId || 'anonymous' },
      async () => {
        // SEC-3: acceptance must bind to a real authenticated user, never an empty id.
        if (!userId || !Types.ObjectId.isValid(userId)) {
          throw new UnauthorizedException('You must be signed in to accept an invite.');
        }
        const invite = await this.model.findOne({ token, status: 'pending' }).exec();
        if (!invite) throw new NotFoundException('Invite not found or already used');
        if (invite.expiresAt && invite.expiresAt < new Date()) {
          await this.model.updateOne({ _id: invite._id }, { status: 'expired' }).exec();
          throw new NotFoundException('Invite has expired');
        }
        // SEC-3: the token alone must not grant access - the signed-in user's email
        // must match the invited address (case/whitespace-insensitive).
        const user = await this.userModel.findById(userId).select('email').exec();
        if (!user) throw new UnauthorizedException('Your account could not be found.');
        assertInviteEmailMatch(invite.email, user.email);

        await this.model
          .updateOne(
            { _id: invite._id },
            { status: 'accepted', acceptedByUserId: new Types.ObjectId(userId) },
          )
          .exec();
        await this.userModel
          .updateOne(
            { _id: new Types.ObjectId(userId) },
            { $addToSet: { accountantWorkspaces: invite.workspaceId.toString() } },
          )
          .exec();

        // PostHog after the successful write. Emit ids + scopeRole only - never the
        // invite token or the invitee email (PII).
        this.postHog?.capture({
          distinctId: userId,
          event: 'accountant.accepted_invite',
          properties: {
            workspaceId: String(invite.workspaceId),
            firmId: String(invite.firmId),
            inviteId: String(invite._id),
            scopeRole: invite.scopeRole,
          },
        });
      },
    );
  }

  async revoke(workspaceId: string, firmId: string, inviteId: string): Promise<void> {
    // Span-only wrap: no userId (actor) in the signature, so SKIP the PostHog event
    // per the rule. Do NOT change the signature to add one.
    return withFinanceSpan(
      this.tracer,
      'finance.revokeAccountantInvite',
      { workspaceId, firmId, inviteId },
      async () => {
        const invite = await this.model
          .findOneAndDelete({
            _id: new Types.ObjectId(inviteId),
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
          })
          .exec();
        if (!invite) throw new NotFoundException('Invite not found');
        if (invite.status === 'accepted' && invite.acceptedByUserId) {
          await this.userModel
            .updateOne(
              { _id: invite.acceptedByUserId },
              { $pull: { accountantWorkspaces: workspaceId } },
            )
            .exec();
        }
      },
    );
  }
}
