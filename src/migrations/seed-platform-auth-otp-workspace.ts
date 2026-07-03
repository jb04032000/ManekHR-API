import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { env } from '../config/env';
import { Workspace } from '../modules/workspaces/schemas/workspace.schema';

const PLATFORM_AUTH_OTP_WORKSPACE_NAME = '__platform_auth_otp__';

/**
 * Idempotent seed — creates the synthetic workspace used as `workspaceId` on
 * `SmsDispatchLog` rows for auth-OTP sends.
 *
 * `SmsService.sendDltSms()` requires a non-null `workspaceId` because the
 * dispatch log row's index is `{ workspaceId: 1, createdAt: -1 }`. Auth OTPs
 * fire BEFORE the user has any workspace (login + register) so we route them
 * to a dedicated platform workspace owned by the system user. `creditSource:
 * 'system'` bypasses customer + marketing-pool credit deduction so the
 * workspace doesn't need a subscription.
 *
 * Behaviour:
 *   - Looks for an existing workspace by name. If found, returns its `_id`
 *     (idempotent re-runs are no-ops).
 *   - Otherwise creates one with ownerId = SYSTEM_USER_ID and returns the new
 *     `_id`. Operator must paste this into AUTH_OTP_WORKSPACE_ID env var.
 *
 * Wired from MigrationsModule's `onModuleInit` AFTER the standard seeds; runs
 * only when SEED_DEFAULTS_ON_BOOTSTRAP=true. Failures log + swallow; never
 * crash app startup.
 */
@Injectable()
export class SeedPlatformAuthOtpWorkspaceService {
  private readonly logger = new Logger(SeedPlatformAuthOtpWorkspaceService.name);

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
  ) {}

  async runSeed(): Promise<{ workspaceId: string; created: boolean }> {
    const existing = await this.workspaceModel
      .findOne({ name: PLATFORM_AUTH_OTP_WORKSPACE_NAME })
      .lean();
    if (existing) {
      const id = existing._id.toString();
      if (env.msg91.authOtpWorkspaceId !== id) {
        this.logger.warn(
          `Platform auth-OTP workspace exists (_id=${id}) but AUTH_OTP_WORKSPACE_ID env var is ${env.msg91.authOtpWorkspaceId ?? '(unset)'} — these must match.`,
        );
      }
      return { workspaceId: id, created: false };
    }

    if (!env.systemUserId || env.systemUserId === '000000000000000000000000') {
      this.logger.warn(
        'SYSTEM_USER_ID is unset (or default sentinel). Skipping platform-auth-otp workspace seed — set SYSTEM_USER_ID and re-run.',
      );
      return { workspaceId: '', created: false };
    }

    const created = await this.workspaceModel.create({
      name: PLATFORM_AUTH_OTP_WORKSPACE_NAME,
      ownerId: new Types.ObjectId(env.systemUserId),
      isActive: true,
      timezone: 'UTC',
    });
    const id = created._id.toString();
    this.logger.log(
      `Created platform auth-OTP workspace _id=${id}. Set AUTH_OTP_WORKSPACE_ID=${id} in your environment.`,
    );
    return { workspaceId: id, created: true };
  }
}
