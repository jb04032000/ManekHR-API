import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { InquiryService } from '../services/inquiry.service';
import { CreateInquiryDto } from '../dto/create-inquiry.dto';
import { ListInquiriesQueryDto } from '../dto/list-inquiries.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/marketplace/listings/:id/inquiries` -- the buyer's inquiry path.
 * `connect/marketplace/inquiries/mine/*` -- the buyer's outbox + seller's inbox.
 *
 * The buyer is always the authenticated Connect User (`req.user.sub`); the
 * listing comes from the URL. The service blocks self-inquiry, dedupes per
 * `(listingId, buyerUserId)`, and routes through `ConnectAllowanceService`
 * to enforce the seller's per-cycle lead cap.
 *
 * Throttler tier is tighter than the listing-write path (an inquiry is a
 * one-tap action; ten per minute is a generous human ceiling and stops a
 * scripted lead-scraper from carpet-bombing every listing in town).
 */
@LegacyUnclassified()
@Controller('connect/marketplace')
@UseGuards(JwtAuthGuard)
export class InquiryController {
  constructor(private readonly inquiries: InquiryService) {}

  /** Send an inquiry on a listing (buyer-side; gated by the seller's leadsPerMonth cap). */
  @Post('listings/:id/inquiries')
  @Throttle({ 'connect-write': { limit: 10, ttl: 60_000 } })
  create(@Req() req: AuthedRequest, @Param('id') listingId: string, @Body() dto: CreateInquiryDto) {
    return this.inquiries.create(req.user.sub, listingId, dto);
  }

  /** Buyer outbox: one keyset page of inquiries the caller has sent, newest first. */
  @Get('inquiries/mine/sent')
  listMineSent(@Req() req: AuthedRequest, @Query() query: ListInquiriesQueryDto) {
    return this.inquiries.listMineSent(req.user.sub, { cursor: query.cursor, limit: query.limit });
  }

  /** Seller inbox: one keyset page of inquiries received on the caller's listings. */
  @Get('inquiries/mine/received')
  listMineReceived(@Req() req: AuthedRequest, @Query() query: ListInquiriesQueryDto) {
    return this.inquiries.listMineReceived(req.user.sub, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
