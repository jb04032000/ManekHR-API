import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Req,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import * as bcrypt from 'bcryptjs';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';

type AuthedRequest = Request & {
  user: {
    sub: string;
    platform?: string;
    jti?: string;
    forgotPasswordReset?: boolean;
  };
};

interface UpdateProfileBody {
  name?: string;
  /** R2-hosted URL from the `avatars` upload category, or empty string to
   *  remove the existing photo. Persisted to `User.profilePicture`. */
  profilePicture?: string;
  // The fields below are intentionally accepted (so the body type doesn't lie
  // about what the FE may send) but stripped before persistence — identity
  // channels and system fields are managed elsewhere.
  email?: string;
  mobile?: string;
  googleId?: string;
  passwordHash?: string;
  isEmailVerified?: boolean;
  isMobileVerified?: boolean;
  [key: string]: unknown;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

interface SetPasswordBody {
  newPassword: string;
}

interface MongoDuplicateKeyError {
  code?: number;
  keyPattern?: Record<string, unknown>;
  errorResponse?: {
    code?: number;
    keyPattern?: Record<string, unknown>;
  };
}

// @SkipPinUnlock: this controller is the user's own product-neutral identity
// surface (profile read/update, password set/change, FCM token) backing the
// shared `/account/*` area. App Lock (Quick PIN) is an ERP-only protection for
// payroll/finance/staff data and must NOT gate this surface - otherwise a
// Connect-only user (no PIN) cannot view or edit their own profile. The
// sensitive ERP modules stay behind the guard. Keep in sync with the web
// `appLockEnabled = mode === 'erp'` gate (DashboardLayout).
@SkipPinUnlock()
@LegacyUnclassified()
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  async getProfile(@Req() req: AuthedRequest) {
    const user = await this.usersService.findByIdWithCredentials(req.user.sub);
    if (!user) throw new BadRequestException('User not found');
    const obj = user.toObject() as Record<string, unknown> & { passwordHash?: string };
    const { passwordHash, ...result } = obj;
    return { user: { ...result, hasPassword: !!passwordHash } };
  }

  @Patch('profile')
  async updateProfile(@Req() req: AuthedRequest, @Body() updateDto: UpdateProfileBody) {
    const currentUser = await this.usersService.findById(req.user.sub);
    if (!currentUser) throw new BadRequestException('User not found');

    // System fields and identity channels (email/mobile) are never set via
    // this endpoint. Email and mobile changes go through the dedicated
    // verification flows (auth/send-verification-email + auth/verify-email
    // for email; auth/send-mobile-verify-otp + auth/verify-mobile for
    // mobile) so we never persist an unverified identifier from a generic
    // profile-update payload.
    //
    // `profilePicture` is whitelisted because it's an R2-hosted URL the
    // client uploaded via `/uploads/single?category=avatars` — the uploads
    // module already validated MIME + size, so the URL we receive here is
    // a trusted reference. Empty string is honored (used for "remove
    // photo") so we accept it explicitly rather than only `string` truthy.
    const safePayload: Record<string, unknown> = {};
    if (updateDto.name !== undefined) safePayload.name = updateDto.name;
    if (typeof updateDto.profilePicture === 'string') {
      safePayload.profilePicture = updateDto.profilePicture;
    }

    try {
      await this.usersService.update(req.user.sub, safePayload);
      // Refetch with credentials so hasPassword reflects truth (passwordHash is select:false)
      const updatedUser = await this.usersService.findByIdWithCredentials(req.user.sub);
      if (!updatedUser) throw new BadRequestException('User not found');
      const obj = updatedUser.toObject() as Record<string, unknown> & { passwordHash?: string };
      const { passwordHash: hash, ...result } = obj;
      return { user: { ...result, hasPassword: !!hash } };
    } catch (err) {
      const dupErr = err as MongoDuplicateKeyError;
      if (dupErr?.code === 11000 || dupErr?.errorResponse?.code === 11000) {
        const keyPattern = dupErr?.errorResponse?.keyPattern || dupErr?.keyPattern || {};
        const field = Object.keys(keyPattern)[0];
        throw new BadRequestException(
          `This ${field === 'mobile' ? 'mobile number' : field === 'email' ? 'email address' : 'value'} is already linked to another account.`,
        );
      }
      throw err;
    }
  }

  @Patch('change-password')
  async changePassword(@Req() req: AuthedRequest, @Body() body: ChangePasswordBody) {
    const user = await this.usersService.findByIdWithCredentials(req.user.sub);
    if (!user) throw new BadRequestException('Account not found.');

    // Safety check - if no password, they should use set-password
    if (!user.passwordHash) {
      throw new BadRequestException('Account has no password. Use set-password endpoint.');
    }

    const isMatch = await bcrypt.compare(body.currentPassword, user.passwordHash);

    if (!isMatch) {
      throw new BadRequestException('Invalid password');
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(body.newPassword, salt);

    await this.usersService.update(String(user._id), {
      passwordHash,
    });

    return { message: 'Password updated successfully' };
  }

  @Patch('profile/fcm-token')
  @UseGuards(JwtAuthGuard)
  async updateFcmToken(
    @CurrentUser() user: { userId?: string; sub?: string },
    @Body() body: { fcmToken: string },
  ) {
    if (!body?.fcmToken || typeof body.fcmToken !== 'string' || body.fcmToken.length < 10) {
      throw new BadRequestException('Invalid fcmToken');
    }
    const id = user.userId ?? user.sub;
    if (!id) throw new BadRequestException('Account not found.');
    await this.usersService.updateFcmToken(id, body.fcmToken);
    return { updated: true };
  }

  @Patch('set-password')
  async setPassword(@Req() req: AuthedRequest, @Body() body: SetPasswordBody) {
    this.logger.log(`setPassword called for user: ${req.user.sub}`);

    try {
      const user = await this.usersService.findByIdWithCredentials(req.user.sub);
      if (!user) throw new BadRequestException('Account not found.');

      if (user.passwordHash) {
        throw new BadRequestException('Password already set. Use change-password instead.');
      }

      if (!body.newPassword || body.newPassword.length < 6) {
        throw new BadRequestException('Password must be at least 6 characters long');
      }

      const salt = await bcrypt.genSalt(12);
      const passwordHash = await bcrypt.hash(body.newPassword, salt);

      await this.usersService.update(String(user._id), {
        passwordHash,
      });

      return { message: 'Password created successfully' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`setPassword failed for user: ${req.user.sub}: ${msg}`);
      throw e;
    }
  }
}
