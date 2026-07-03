import {
  Injectable,
  Logger,
  BadRequestException,
  TooManyRequestsException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { TeamMobileOtp, TeamMobileOtpDoc } from './schemas/team-mobile-otp.schema';
import { SmsService } from '../sms/sms.service';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

/**
 * Placeholder DLT template ID. Must be registered with MSG91 before
 * production. Owner registers separately via the MSG91 DLT portal and
 * replaces this constant with the approved flow_id.
 *
 * NOTE: This is intentionally a placeholder - do NOT treat it as a real
 * template. The SMS send will be skipped by SmsService when MSG91 rejects
 * an unregistered flow_id.
 */
const DLT_TEMPLATE_TEAM_MOBILE_OTP = 'TEAM_MOBILE_OTP_PLACEHOLDER';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_PROOF_TTL_MS = 15 * 60 * 1000; // 15 minutes for the post-verify JWT
const MAX_ATTEMPTS = 5;
const PER_NUMBER_COOLDOWN_MS = 60 * 1000; // 1 send per (wsId, mobile) per 60s
const PER_WORKSPACE_CAP_PER_MINUTE = 10; // 10 sends per workspace per 60s

interface MobileVerifyClaims {
  kind: string;
  workspaceId: string;
  mobile: string;
  confirmedBy: string;
}

@Injectable()
export class MobileOtpService {
  private readonly logger = new Logger(MobileOtpService.name);

  constructor(
    @InjectModel(TeamMobileOtp.name) private readonly otpModel: Model<TeamMobileOtpDoc>,
    private readonly smsService: SmsService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly postHog: PostHogService,
  ) {}

  async startVerification(
    workspaceId: string,
    mobile: string,
    requestedBy: string,
  ): Promise<{ sent: boolean; expiresAt: Date }> {
    const wsOid = new Types.ObjectId(workspaceId);
    const now = new Date();

    // Abuse cap: per-number cooldown (1 send per number per 60s)
    const perNumberRecent = await this.otpModel
      .countDocuments({
        workspaceId: wsOid,
        mobile,
        createdAt: { $gt: new Date(now.getTime() - PER_NUMBER_COOLDOWN_MS) },
      })
      .exec();
    if (perNumberRecent >= 1) {
      throw new TooManyRequestsException({
        code: 'TOO_MANY_REQUESTS',
        message: 'Please wait a minute before requesting another code for this number.',
      });
    }

    // Abuse cap: per-workspace burst (max 10 sends per workspace per 60s)
    const perWsRecent = await this.otpModel
      .countDocuments({
        workspaceId: wsOid,
        createdAt: { $gt: new Date(now.getTime() - 60_000) },
      })
      .exec();
    if (perWsRecent >= PER_WORKSPACE_CAP_PER_MINUTE) {
      throw new TooManyRequestsException({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many verification requests in this workspace. Try again in a minute.',
      });
    }

    // Generate code, hash it, persist. Plaintext NEVER stored.
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    await this.otpModel.create({
      workspaceId: wsOid,
      mobile,
      codeHash,
      expiresAt,
      attempts: 0,
      consumedAt: null,
      requestedBy: new Types.ObjectId(requestedBy),
    });

    // Send DLT SMS. Log + surface error on failure (best-effort).
    try {
      await this.smsService.sendDltSms({
        workspaceId,
        mobile,
        templateId: DLT_TEMPLATE_TEAM_MOBILE_OTP,
        vars: { code, ttlMinutes: '5' },
      });
    } catch (e) {
      this.logger.error(
        `mobile OTP send failed for ws=${workspaceId} mobile=${mobile.slice(-4)}: ${(e as Error).message}`,
      );
      // Surface to caller so FE can show a retry option.
      throw new BadRequestException({
        code: 'OTP_SMS_FAILED',
        message: 'Could not send SMS. Check the number, your SMS credits, and try again.',
      });
    }

    void this.auditService
      .logEvent({
        workspaceId,
        module: AppModuleEnum.TEAM,
        entityType: 'team_mobile_otp',
        entityId: mobile,
        action: 'team.mobile_otp_sent',
        actorId: requestedBy,
        meta: { mobile: mobile.slice(-4), ttlMinutes: 5 },
      })
      .catch(() => undefined);

    this.postHog.capture({
      distinctId: requestedBy,
      event: 'team.mobile_otp_sent',
      properties: { workspaceId, mobileLast4: mobile.slice(-4) },
    });

    return { sent: true, expiresAt };
  }

  async confirmVerification(
    workspaceId: string,
    mobile: string,
    code: string,
    confirmedBy: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const wsOid = new Types.ObjectId(workspaceId);
    const now = new Date();

    const doc = await this.otpModel
      .findOne({
        workspaceId: wsOid,
        mobile,
        consumedAt: null,
        expiresAt: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .exec();

    if (!doc) {
      void this.auditAttempt(workspaceId, mobile, confirmedBy, 'expired_or_invalid');
      throw new UnauthorizedException({
        code: 'OTP_EXPIRED_OR_INVALID',
        message: 'No active code. Please request a new one.',
      });
    }

    if (doc.attempts >= MAX_ATTEMPTS) {
      doc.consumedAt = now;
      await doc.save();
      void this.auditAttempt(workspaceId, mobile, confirmedBy, 'locked');
      throw new UnauthorizedException({
        code: 'OTP_LOCKED',
        message: 'Too many wrong attempts. Please request a new code.',
      });
    }

    const match = await bcrypt.compare(code, doc.codeHash);
    if (!match) {
      doc.attempts += 1;
      await doc.save();
      const remaining = MAX_ATTEMPTS - doc.attempts;
      void this.auditAttempt(workspaceId, mobile, confirmedBy, 'wrong_code');
      throw new UnauthorizedException({
        code: 'OTP_WRONG_CODE',
        message: `Wrong code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
        attempts: doc.attempts,
      });
    }

    doc.consumedAt = now;
    await doc.save();

    // Mint JWT proof token (15 min TTL). Claims carry workspaceId + mobile
    // so assertProofToken can validate cross-context misuse.
    const expiresAt = new Date(now.getTime() + OTP_PROOF_TTL_MS);
    const token = await this.jwtService.signAsync(
      {
        kind: 'mobile-verify',
        workspaceId,
        mobile,
        confirmedBy,
      },
      { expiresIn: '15m' },
    );

    void this.auditService
      .logEvent({
        workspaceId,
        module: AppModuleEnum.TEAM,
        entityType: 'team_mobile_otp',
        entityId: mobile,
        action: 'team.mobile_otp_verified',
        actorId: confirmedBy,
        meta: { mobile: mobile.slice(-4) },
      })
      .catch(() => undefined);

    this.postHog.capture({
      distinctId: confirmedBy,
      event: 'team.mobile_otp_verified',
      properties: { workspaceId, mobileLast4: mobile.slice(-4) },
    });

    return { token, expiresAt };
  }

  /**
   * Verify a proof token presented at create/update time. Throws if invalid.
   * Returns silently on success.
   *
   * Validates: JWT signature, expiry (via jwtService.verifyAsync), kind claim,
   * workspaceId claim, and mobile claim against the actual request values.
   */
  async assertProofToken(workspaceId: string, mobile: string, token: string): Promise<void> {
    try {
      const claims = await this.jwtService.verifyAsync<MobileVerifyClaims>(token);
      if (claims.kind !== 'mobile-verify') {
        throw new UnauthorizedException({
          code: 'OTP_PROOF_INVALID',
          message: 'Invalid verification token.',
        });
      }
      if (claims.workspaceId !== workspaceId) {
        throw new UnauthorizedException({
          code: 'OTP_PROOF_INVALID',
          message: 'Verification token is for a different workspace.',
        });
      }
      if (claims.mobile !== mobile) {
        throw new UnauthorizedException({
          code: 'OTP_PROOF_INVALID',
          message: 'Verification token is for a different mobile number.',
        });
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException({
        code: 'OTP_PROOF_INVALID',
        message: 'Verification token expired or invalid.',
      });
    }
  }

  private auditAttempt(workspaceId: string, mobile: string, actorId: string, reason: string): void {
    void this.auditService
      .logEvent({
        workspaceId,
        module: AppModuleEnum.TEAM,
        entityType: 'team_mobile_otp',
        entityId: mobile,
        action: 'team.mobile_otp_failed',
        actorId,
        meta: { mobile: mobile.slice(-4), reason },
      })
      .catch(() => undefined);

    this.postHog.capture({
      distinctId: actorId,
      event: 'team.mobile_otp_failed',
      properties: { workspaceId, mobileLast4: mobile.slice(-4), reason },
    });
  }
}
