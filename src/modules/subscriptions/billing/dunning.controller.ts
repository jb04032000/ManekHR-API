import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { DunningService } from './services/dunning.service';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve dunning status (D1g). The frontend polls this on
 * dashboard load to render:
 *   - "Payment failed" banner with the days-remaining count.
 *   - "Update payment method" CTA pointing at `/checkout/mandate`.
 *   - "Contact sales" link when configured + policy enabled.
 *   - Read-only mode indicator so write actions in the UI can grey out
 *     before the server returns 403.
 *
 * Returns `null` body when the user has no current subscription —
 * the FE renders the empty state in that case.
 */
@LegacyUnclassified()
@Controller('subscriptions/dunning')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class DunningController {
  constructor(private readonly dunning: DunningService) {}

  @Get('status')
  async status(@Req() req: any) {
    return this.dunning.getStatusForUser(req.user.sub);
  }
}
