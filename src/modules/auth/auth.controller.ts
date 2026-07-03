import { Controller, Post, Body, Get, UseGuards, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SmsOtpService } from './services/sms-otp.service';
import { setRefreshCookie, clearRefreshCookie, readRefreshCookie } from './utils/refresh-cookie';
import type { AuthResult } from './types/auth.types';
import {
  ResendOtpDto,
  SendMobileVerifyOtpDto,
  SendOtpDto,
  TerminateAndOtpLoginDto,
  VerifyMobileDto,
  VerifyOtpDto,
} from './dto/sms-otp.dto';

/**
 * Express request shape after `JwtAuthGuard` (or the Passport `'jwt'`
 * strategy) has populated `req.user` with the decoded JWT payload.
 * Public routes also receive a `Request` but with `user` undefined.
 */
type AuthedRequest = Request & {
  user: {
    sub: string;
    platform?: string;
    jti?: string;
    family?: string;
    /**
     * True when the current session was minted through the SMS-OTP
     * forgot-password flow. Permits a one-shot bypass of the "current
     * password" check in PATCH /users/change-password.
     */
    forgotPasswordReset?: boolean;
  };
};
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  CheckUserDto,
  SendVerificationEmailDto,
  VerifyEmailDto,
  SetupAdminDto,
  TerminateAndLoginUnauthDto,
  SetPinDto,
  ChangePinDto,
  VerifyPinDto,
  ForgotPinCredentialDto,
  ForgotPinResetDto,
  ChangePasswordAfterForgotDto,
  SendEmailRegistrationOtpDto,
} from './dto/auth.dto';
import { ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';
import { AuthenticatedOnly } from '../../common/decorators/require-permission.decorator';

/**
 * Auth route classification (SEC-5, auth-hardening Pillar 2):
 *
 * The class-level `@LegacyUnclassified()` was REMOVED. Every Auth route is now
 * explicitly classified: either `@Public()` (signup / login / refresh / forgot
 * / OTP — pre-auth surfaces) or `@AuthenticatedOnly()` (user-self routes that
 * carry a `JwtAuthGuard`). No Auth route is ERP-workspace-gated — Auth holds no
 * workspace-scoped data, so none reads/writes a `workspaceId` (the RolesGuard
 * fail-open path SEC-3 therefore cannot apply here). The authenticated routes
 * are all self-scoped via `req.user.sub`; there is no param/body that can name
 * another user, so a caller can only ever reach their own record.
 *
 * `@AuthenticatedOnly()` makes the route reachable by any authenticated user
 * once RolesGuard is global + deny-by-default (it is the real marker that
 * replaces the transitional legacy one), while `@Public()` at handler level
 * keeps the pre-auth routes open. JwtAuthGuard is applied per-route below.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly smsOtpService: SmsOtpService,
  ) {}

  /**
   * OQ-1 (auth-hardening): on every successful auth response, write the
   * long-lived refresh token into an httpOnly + Secure + SameSite cookie so an
   * XSS payload can never read it from localStorage. The response BODY still
   * carries the refreshToken so the MOBILE client (no cookie jar) keeps
   * working; the web client stops persisting it and relies on the cookie. We
   * use `@Res({ passthrough: true })` so Nest still serializes the returned
   * body through the ResponseInterceptor.
   */
  private withRefreshCookie(res: Response, result: AuthResult): AuthResult {
    if (result?.refreshToken) {
      setRefreshCookie(res, result.refreshToken);
    }
    return result;
  }

  @Public()
  @Post('check-user')
  checkUser(@Body() checkUserDto: CheckUserDto) {
    return this.authService.checkUser(checkUserDto);
  }

  @Public()
  @Post('register')
  async register(@Body() registerDto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    return this.withRefreshCookie(res, await this.authService.register(registerDto));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.withRefreshCookie(res, await this.authService.login(loginDto));
  }

  // Same throttle profile as /login since it validates credentials and bypasses
  // JwtAuthGuard. Used by the SessionLimitModal terminate-and-sign-in button.
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @Post('terminate-and-login')
  async terminateAndLogin(
    @Body() dto: TerminateAndLoginUnauthDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withRefreshCookie(res, await this.authService.terminateAndLoginUnauth(dto));
  }

  @Public()
  @Post('google')
  async googleAuth(@Body() googleDto: GoogleAuthDto, @Res({ passthrough: true }) res: Response) {
    return this.withRefreshCookie(res, await this.authService.googleAuth(googleDto));
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Body() refreshDto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const authHeader = req.headers['authorization'];
    const oldAccessToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
    // OQ-1: web sends the refresh token via the httpOnly cookie (absent from the
    // body); mobile sends it in the body. Cookie wins; body is the fallback.
    const cookieToken = readRefreshCookie(req);
    const effectiveDto: RefreshTokenDto = {
      ...refreshDto,
      refreshToken: cookieToken ?? refreshDto.refreshToken,
    };
    const result = await this.authService.refreshToken(effectiveDto, oldAccessToken);
    // Rotation issues a NEW refresh token — re-set the cookie so the web client
    // keeps a valid one. (Mobile reads the rotated token from the body.)
    if (result?.refreshToken) {
      setRefreshCookie(res, result.refreshToken);
    }
    return result;
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body);
  }

  /**
   * Pre-signup email-OTP send for the new web combined-signup flow. Mints a
   * 6-digit code, mails it, stores in Redis with a 10-min TTL. The OTP is
   * consumed by `/auth/register` when the FE submits the full signup payload
   * (name + password + workspace + emailOtp). Mirrors `/auth/send-otp` for
   * the SMS-OTP register flow but channel-keyed for email.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('email-otp/send-register')
  async sendEmailRegistrationOtp(@Body() body: SendEmailRegistrationOtpDto, @Req() req: Request) {
    const ipAddress =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress;
    return this.authService.sendEmailRegistrationOtp(body.email, ipAddress);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body);
  }

  /**
   * Authenticated counterpart to `POST /auth/reset-password` — used by the
   * web client AFTER the user signed in via the SMS-OTP forgot flow and
   * landed on `/dashboard/settings#password`. The session JWT carries the
   * `forgotPasswordReset: true` claim (embedded by `finalizeAuthSuccess`
   * on forgot-OTP verify); this endpoint allows the user to set a new
   * password without supplying the old one (which they don't know).
   *
   * @SkipPinUnlock — the App-Lock guard would otherwise 423 these calls
   *                 because the user hasn't (yet) set a PIN OR unlocked
   *                 their session post-login. The forgot-reset path must
   *                 stay reachable from the locked state.
   */
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('change-password-after-forgot')
  async changePasswordAfterForgot(
    @Req() req: AuthedRequest,
    @Body() body: ChangePasswordAfterForgotDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!req.user.forgotPasswordReset) {
      throw new ForbiddenException({
        code: 'FORGOT_RESET_CLAIM_REQUIRED',
        message:
          'This endpoint requires a forgot-password reset session. Use /users/change-password instead.',
      });
    }
    const authHeader = req.headers['authorization'];
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
    // OQ-1: web's old refresh token is in the cookie; mobile in the body.
    const refreshToken = readRefreshCookie(req) ?? body.refreshToken;
    const result = await this.authService.completeForgotPasswordReset({
      userId: req.user.sub,
      newPassword: body.newPassword,
      refreshToken,
      accessToken,
      platform: body.platform,
      deviceName: body.deviceName,
      ipAddress: body.ipAddress,
      userAgent: body.userAgent,
    });
    // A fresh pair was issued — re-set the web cookie with the new refresh token.
    return this.withRefreshCookie(res, result);
  }

  @Public()
  @Post('setup-admin')
  setupAdmin(@Body() dto: SetupAdminDto) {
    return this.authService.setupAdmin(dto);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard)
  @Post('send-verification-email')
  async sendVerificationEmail(@Req() req: AuthedRequest, @Body() body: SendVerificationEmailDto) {
    // Self-only: writes the verify-OTP staged for THIS caller (req.user.sub).
    return this.authService.sendVerificationEmail(body, req.user.sub);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard)
  @Post('verify-email')
  async verifyEmail(@Req() req: AuthedRequest, @Body() body: VerifyEmailDto) {
    // Self-only: verifies the caller's own staged email OTP (req.user.sub).
    return this.authService.verifyEmail(body, req.user.sub);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard)
  @SkipPinUnlock()
  @Post('logout')
  async logout(
    @Body() body: RefreshTokenDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const authHeader = req.headers['authorization'];
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
    // OQ-1: the web refresh token lives in the cookie now, so denylist THAT
    // jti (cookie-first, body fallback for mobile), then ALWAYS clear the
    // cookie so a logged-out browser can't replay it on /auth/refresh.
    const refreshToken = readRefreshCookie(req) ?? body.refreshToken ?? '';
    await this.authService.revokeTokens(refreshToken, accessToken, req.user.sub);
    clearRefreshCookie(res);
    return { message: 'Logged out successfully' };
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard)
  @SkipPinUnlock()
  @Get('me')
  async me(@Req() req: AuthedRequest) {
    // Fetch the full user profile from the database
    const user = await this.authService.getUserProfile(req.user.sub);
    return {
      user,
      subscription: { plan: null },
      workspaces: [],
      // Surface the forgot-password-reset session flag so the FE knows it
      // should route the user into the change-password card with the
      // current-password field hidden + auto-scroll on /dashboard/settings.
      forgotPasswordReset: req.user.forgotPasswordReset === true,
    };
  }

  // ───────────────── App Lock (Quick PIN) ─────────────────
  // All PIN routes carry @SkipPinUnlock() so the user can transition between
  // locked/unlocked states even when the global PinUnlockGuard would 423 a
  // regular API call. Throttler tier `pin` is 5/min — same risk profile as
  // forgot/reset password.

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ pin: { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('pin-set')
  async setPin(@Req() req: AuthedRequest, @Body() body: SetPinDto) {
    return this.authService.setPin(req.user.sub, req.user.jti ?? '', body, req.user.family);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ pin: { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('pin-change')
  async changePin(@Req() req: AuthedRequest, @Body() body: ChangePinDto) {
    return this.authService.changePin(req.user.sub, req.user.jti ?? '', body, req.user.family);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ pin: { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('pin-verify')
  async verifyPin(@Req() req: AuthedRequest, @Body() body: VerifyPinDto) {
    return this.authService.verifyPin(req.user.sub, req.user.jti ?? '', body, req.user.family);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard)
  @SkipPinUnlock()
  @Get('pin-status')
  async pinStatus(@Req() req: AuthedRequest) {
    return this.authService.getPinStatus(req.user.sub, req.user.jti ?? '', req.user.family);
  }

  // App Lock activity heartbeat. DELIBERATELY no @SkipPinUnlock: the global
  // PinUnlockGuard must run so it slides the unlock TTL. The web idle timer
  // pings this on real user input (throttled ~20s) so the BE idle clock tracks
  // the same user-activity signal the FE clock does — fixes the session
  // locking mid-use while the user is active but not making API calls.
  // Links: PinUnlockGuard (slides TTL), web useIdle.onActivity -> pinApi.touch.
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'pin-touch': { limit: 60, ttl: 60_000 } })
  @Post('pin-touch')
  async pinTouch(@Req() req: AuthedRequest) {
    return this.authService.pinTouch(req.user.sub, req.user.jti ?? '', req.user.family);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('forgot-pin-credential-verify')
  async forgotPinCredentialVerify(@Req() req: AuthedRequest, @Body() body: ForgotPinCredentialDto) {
    return this.authService.forgotPinCredentialVerify(req.user.sub, req.user.jti ?? '', body);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ pin: { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('forgot-pin-reset')
  async forgotPinReset(@Req() req: AuthedRequest, @Body() body: ForgotPinResetDto) {
    return this.authService.forgotPinReset(req.user.sub, req.user.jti ?? '', body, req.user.family);
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard)
  @SkipPinUnlock()
  @Post('lock')
  async lock(@Req() req: AuthedRequest) {
    return this.authService.lockSession(
      req.user.sub,
      req.user.jti ?? '',
      undefined,
      req.user.family,
    );
  }

  // ───────────────── SMS-OTP (login / register / forgot) ─────────────────
  // All public (pre-auth). Per-IP burst via the new `sms-otp` throttler tier
  // (5/min default, /verify gets 10/min, /resend gets 3/min). Per-phone +
  // per-IP-daily caps live in Redis sliding-window inside SmsOtpService.

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 5, ttl: 60_000 } })
  @Post('send-otp')
  sendOtp(@Body() body: SendOtpDto, @Req() req: Request) {
    return this.smsOtpService.sendOtp(body, this.resolveIp(req));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 10, ttl: 60_000 } })
  @Post('verify-otp')
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.ipAddress) body.ipAddress = this.resolveIp(req);
    // OQ-1: a successful OTP verify is a full login (AuthResult) — set the
    // refresh cookie for web, just like the password-login paths.
    return this.withRefreshCookie(res, await this.smsOtpService.verifyOtp(body));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 3, ttl: 60_000 } })
  @Post('resend-otp')
  resendOtp(@Body() body: ResendOtpDto, @Req() req: Request) {
    return this.smsOtpService.resendOtp(body, this.resolveIp(req));
  }

  // Mirror of /auth/terminate-and-login for the OTP path. Caller passes the
  // mobile + a freshly-verified OTP + the sessionId to terminate; backend
  // re-verifies the OTP, terminates the target session, and issues new JWTs.
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @Post('terminate-and-otp-login')
  async terminateAndOtpLogin(
    @Body() body: TerminateAndOtpLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.ipAddress) body.ipAddress = this.resolveIp(req);
    // OQ-1: also a full login (AuthResult) — set the web refresh cookie.
    return this.withRefreshCookie(res, await this.smsOtpService.terminateAndOtpLogin(body));
  }

  // @SkipPinUnlock — MobileVerificationGate (the force-verify-your-number
  // modal) fires for a signed-in user whose phone is unverified, which can
  // be BEFORE they've set up their app-lock PIN. Without this, PinUnlockGuard
  // 423s the send/verify calls with "PIN setup required" and the gate can
  // never be completed. Mirrors the same exemption already used for
  // forgot-password-after-otp and the PIN-setup routes above.
  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 5, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('send-mobile-verify-otp')
  sendMobileVerifyOtp(@Req() req: AuthedRequest, @Body() body: SendMobileVerifyOtpDto) {
    return this.smsOtpService.sendMobileVerifyOtp(req.user.sub, body, this.resolveIp(req));
  }

  @AuthenticatedOnly()
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ 'sms-otp': { limit: 10, ttl: 60_000 } })
  @SkipPinUnlock()
  @Post('verify-mobile')
  verifyMobile(@Req() req: AuthedRequest, @Body() body: VerifyMobileDto) {
    return this.smsOtpService.verifyMobile(req.user.sub, body);
  }

  /**
   * Best-effort client IP resolution — honours X-Forwarded-For when present
   * (set by reverse proxy / load balancer) else falls back to the socket
   * address. Used to scope per-IP daily OTP caps.
   */
  private resolveIp(req: Request): string | undefined {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? '').split(',')[0];
    return (first || req.ip || req.socket?.remoteAddress || '').trim() || undefined;
  }
}
