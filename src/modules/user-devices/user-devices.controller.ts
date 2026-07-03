import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserDevicesService } from './user-devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { SkipPinUnlock } from '../../common/decorators/skip-pin-unlock.decorator';

// @SkipPinUnlock (class-level) — push-token registration is product-neutral,
// user-scoped data (no payroll/finance/staff), and the browser-push opt-in is
// driven from the PIN-free Connect surface. App Lock is an ERP-only protection
// (see PinUnlockGuard, which already exempts Connect + account self-service), so
// the global guard must NOT 423 these /devices/* calls while the ERP side is
// locked — otherwise enabling/disabling browser push fails with APP_LOCKED.
// Keep in sync with PinUnlockGuard's exemptions + lib/push/useBrowserPush (web).
@LegacyUnclassified()
@SkipPinUnlock()
@Controller('devices')
@UseGuards(JwtAuthGuard)
export class UserDevicesController {
  constructor(private readonly userDevicesService: UserDevicesService) {}

  /**
   * Upsert this user's device by FCM token. The mobile app calls this on
   * every cold start (token may have rotated) and after a permission grant.
   */
  @Post('register')
  async register(@Req() req, @Body() dto: RegisterDeviceDto) {
    const device = await this.userDevicesService.registerDevice(req.user.sub, dto);
    return {
      _id: device._id,
      platform: device.platform,
      deviceName: device.deviceName,
      lastUsedAt: device.lastUsedAt,
    };
  }

  /** List the calling user's registered push targets. */
  @Get()
  async list(@Req() req) {
    return this.userDevicesService.listDevices(req.user.sub);
  }

  /** Revoke a specific device (e.g. user signs out on one phone). */
  @Delete(':id')
  async revoke(@Req() req, @Param('id') id: string) {
    await this.userDevicesService.revokeDevice(req.user.sub, id);
    return { ok: true };
  }

  /** Revoke every device for this user. Useful on full sign-out. */
  @Delete()
  async revokeAll(@Req() req) {
    return this.userDevicesService.revokeAll(req.user.sub);
  }
}
