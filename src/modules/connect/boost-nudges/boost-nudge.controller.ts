import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';
import { BoostNudgeService } from './boost-nudge.service';
import { BoostNudgeCandidate } from './boost-nudge.types';
import { DismissBoostNudgeDto } from './dto/dismiss-boost-nudge.dto';

/** JWT payload shape populated by `JwtAuthGuard` -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `me/connect/boost-nudges` -- the traction-based boost nudge surface. All three
 * routes are owner-scoped (resolved from the JWT) and read/write only this
 * owner's own entities + nudge state. `JwtAuthGuard` only, mirroring the sibling
 * `me/connect/usage` controller (Connect is flag-gated, not subscription-gated).
 *
 * Cross-module links: BoostNudgeService does the eligibility math; the web mirror
 * is features/connect/boost-nudges.actions.ts.
 */
@LegacyUnclassified()
@Controller('me/connect/boost-nudges')
@UseGuards(JwtAuthGuard)
export class BoostNudgeController {
  constructor(private readonly nudges: BoostNudgeService) {}

  /** Up to 3 high-traction, boost-eligible entities (ranked by views desc). */
  @Get()
  get(@Req() req: AuthedRequest): Promise<{ candidates: BoostNudgeCandidate[] }> {
    return this.nudges.getNudges(req.user.sub);
  }

  /** Mark that a nudge was rendered (starts the 7-day global cool-down). */
  @Post('shown')
  async markShown(@Req() req: AuthedRequest): Promise<{ ok: true }> {
    await this.nudges.markShown(req.user.sub);
    return { ok: true };
  }

  /** Dismiss the nudge for one entity (sticks for 30 days). Idempotent. */
  @Post(':entityId/dismiss')
  async dismiss(
    @Req() req: AuthedRequest,
    @Param('entityId') entityId: string,
    @Body() body: DismissBoostNudgeDto,
  ): Promise<{ ok: true }> {
    await this.nudges.dismiss(req.user.sub, body.kind, entityId);
    return { ok: true };
  }
}
