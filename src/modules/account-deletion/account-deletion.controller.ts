import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedOnly } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SmsOtpService } from '../auth/services/sms-otp.service';
import { AccountDeletionService } from './account-deletion.service';
import { ScheduleAccountDeletionDto, VerifyStepupOtpDto } from './dto/account-deletion.dto';

/**
 * Self-serve account-deletion endpoints (Scope 3, ACCOUNT-DELETION-AND-DPDP-PLAN.md
 * §6). All routes are authenticated-self: the acting user is ALWAYS the JWT
 * subject (`@CurrentUser('sub')`) — there is no path/body that can name another
 * user, and bearer-token-only (no cookie path) makes CSRF moot (§5). Each route
 * is `@AuthenticatedOnly()` so it is reachable under the global deny-by-default
 * RolesGuard; Auth holds no workspace-scoped data so none is ERP-gated.
 *
 * Flow: (1) `stepup` texts a step-up OTP → (2) `stepup/verify` exchanges the OTP
 * for a single-use proof token → (3) `account` schedules the deletion with
 * re-auth + that proof + type-to-confirm.
 */
@Controller('me/deletion')
export class AccountDeletionController {
  constructor(
    private readonly smsOtp: SmsOtpService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  /**
   * Issue the step-up OTP for the delete action (wraps sendStepupOtp). Sends to
   * the user's existing verified mobile; mints NO session.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 5, ttl: 60_000 } })
  @Post('stepup')
  sendStepup(@CurrentUser('sub') userId: string, @Req() req: Request) {
    return this.smsOtp.sendStepupOtp(userId, this.resolveIp(req));
  }

  /**
   * Verify the step-up OTP and return a single-use, short-lived proof token
   * (consumed once by `POST /me/deletion/account`). Creates NO session.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 10, ttl: 60_000 } })
  @Post('stepup/verify')
  verifyStepup(@CurrentUser('sub') userId: string, @Body() dto: VerifyStepupOtpDto) {
    return this.smsOtp.verifyStepupOtp(userId, dto.otp, dto.accessToken);
  }

  /**
   * Schedule whole-account deletion (Scope 3): re-auth + single-use step-up proof
   * + type-to-confirm, then suspend + log out + start the 30-day recovery timer.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('account')
  scheduleAccount(@CurrentUser('sub') userId: string, @Body() dto: ScheduleAccountDeletionDto) {
    return this.accountDeletion.scheduleSelfServeAccountDeletion(userId, dto);
  }

  /**
   * Schedule Connect-only deletion (Scope 1): SAME gating as Scope 3 (re-auth +
   * single-use step-up proof + type-to-confirm), then hide the Connect profile +
   * start the 30-day recovery timer. The ERP account stays fully active.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('connect')
  scheduleConnect(@CurrentUser('sub') userId: string, @Body() dto: ScheduleAccountDeletionDto) {
    return this.accountDeletion.scheduleSelfServeConnectDeletion(userId, dto);
  }

  /**
   * The Scope-2 "delete ERP" impact for the confirm screen (B2 warning surface):
   * the affected workspaces (owned + member), whether the team loses access, and
   * the open employer-loan / unpaid-advance flags. Read-only — no state change.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ auth: { limit: 30, ttl: 60_000 } })
  @Get('erp/preview')
  previewErp(@CurrentUser('sub') userId: string) {
    return this.accountDeletion.getErpDeletionImpact(userId);
  }

  /**
   * Schedule ERP-only deletion (Scope 2): SAME gating as Scope 1/3 (re-auth +
   * single-use step-up proof + type-to-confirm), then soft-delete owned workspaces
   * + offboard member workspaces (worker cascade) + start the 30-day recovery
   * timer. The account + Connect stay fully active.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('erp')
  scheduleErp(@CurrentUser('sub') userId: string, @Body() dto: ScheduleAccountDeletionDto) {
    return this.accountDeletion.scheduleSelfServeErpDeletion(userId, dto);
  }

  /**
   * Best-effort client IP resolution (X-Forwarded-For aware) for the per-IP OTP
   * caps. Mirrors AuthController.resolveIp.
   */
  private resolveIp(req: Request): string | undefined {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? '').split(',')[0];
    return (first || req.ip || req.socket?.remoteAddress || '').trim() || undefined;
  }
}
