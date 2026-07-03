/**
 * KioskController — public endpoints for the tablet kiosk.
 *
 * PUBLIC — no JwtAuthGuard. Defense relies on bcrypt-hashed rotatable secret
 * + per-employee PIN + lockout + optional IP allowlist (T-M02-01 through T-M02-06).
 *
 * Note: Plan D-17 specifies GET /lookup but GET cannot carry a request body in
 * standard HTTP clients. Changed to POST /lookup to align with KioskPunchDto
 * envelope. Documented as deviation in M-02-SUMMARY.md.
 */
import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { KioskService } from './kiosk.service';
import { KioskPunchDto, KioskLookupDto } from './dto/kiosk-punch.dto';

// Attendance hardening Gap ATTEND-6 (Pillar 2): the kiosk endpoints are PUBLIC
// (no JWT), so they carry an explicit per-IP HTTP throttle on top of the bcrypt
// PIN lockout. The factory-floor kiosk is a shared tablet — a generous 30
// punches/min per IP comfortably covers a busy shift-change rush while capping a
// brute-force script that bypasses the per-employee 5-attempt lockout by cycling
// employee codes. ThrottlerGuard is attached at class level since the controller
// is @Public (it has no other guards that pull it in).
@Public()
@UseGuards(ThrottlerGuard)
@Throttle({ kiosk: { limit: 30, ttl: 60_000 } })
@Controller('attendance/kiosk')
export class KioskController {
  constructor(private readonly kioskService: KioskService) {}

  @Post('punch')
  punch(@Body() dto: KioskPunchDto, @Req() req: any) {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      'unknown';
    return this.kioskService.punch(dto, ip);
  }

  @Post('lookup')
  lookup(@Body() dto: KioskLookupDto, @Req() req: any) {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      'unknown';
    return this.kioskService.lookup(dto, ip);
  }
}
