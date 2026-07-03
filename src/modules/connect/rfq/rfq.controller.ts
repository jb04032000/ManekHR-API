import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RfqService } from './rfq.service';
import {
  CreateRfqDto,
  CreateQuoteDto,
  RfqBoardQueryDto,
  RfqBoardFacetsQueryDto,
} from './dto/rfq.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/rfq` -- the Request-for-Quote board + quotes (members-only). Board-
 * only (no seller notifications). The actor is always `req.user.sub`. Literal
 * routes are declared before `:id` so they are not shadowed by the param route.
 */
@LegacyUnclassified()
@Controller('connect/rfq')
@UseGuards(JwtAuthGuard)
export class RfqController {
  constructor(private readonly rfq: RfqService) {}

  /** The open-RFQ board with the filter rail / sort / search / paging. The
   *  viewer id powers the notQuotedByMe + matchedToMyWork scopes. */
  @Get('board')
  board(@Req() req: AuthedRequest, @Query() query: RfqBoardQueryDto) {
    return this.rfq.listBoard(req.user.sub, query);
  }

  /** Headline counts for the board KPI strip (viewer-aware: supply match +
   *  my-requests / my-quotes numbers). */
  @Get('board/stats')
  boardStats(@Req() req: AuthedRequest) {
    return this.rfq.boardStats(req.user.sub);
  }

  /** Facet counts for the filter rail (one $facet aggregation; jobs pattern). */
  @Get('board/facets')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  boardFacets(@Req() req: AuthedRequest, @Query() query: RfqBoardFacetsQueryDto) {
    return this.rfq.boardFacets(req.user.sub, query);
  }

  /** The caller's own posted RFQs. */
  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    return this.rfq.listMine(req.user.sub);
  }

  /** The caller's own sent quotes. */
  @Get('my-quotes')
  myQuotes(@Req() req: AuthedRequest) {
    return this.rfq.listMyQuotes(req.user.sub);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateRfqDto) {
    return this.rfq.createRfq(req.user.sub, dto);
  }

  /** Accept a quote on one of the caller's RFQs (buyer-only). */
  @Post('quotes/:quoteId/accept')
  accept(@Req() req: AuthedRequest, @Param('quoteId') quoteId: string) {
    return this.rfq.acceptQuote(req.user.sub, quoteId);
  }

  /** Shortlist a quote on one of the caller's RFQs (buyer-only finalist mark). */
  @Post('quotes/:quoteId/shortlist')
  shortlist(@Req() req: AuthedRequest, @Param('quoteId') quoteId: string) {
    return this.rfq.shortlistQuote(req.user.sub, quoteId);
  }

  /** Decline a quote on one of the caller's RFQs (buyer-only). */
  @Post('quotes/:quoteId/decline')
  decline(@Req() req: AuthedRequest, @Param('quoteId') quoteId: string) {
    return this.rfq.declineQuote(req.user.sub, quoteId);
  }

  /** Withdraw the caller's own quote (seller-only). */
  @Post('quotes/:quoteId/withdraw')
  withdraw(@Req() req: AuthedRequest, @Param('quoteId') quoteId: string) {
    return this.rfq.withdrawQuote(req.user.sub, quoteId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.rfq.getRfq(id);
  }

  @Post(':id/close')
  close(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.rfq.closeRfq(req.user.sub, id);
  }

  /** Submit (or update) the caller's quote on an open RFQ (seller). */
  @Post(':id/quotes')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  quote(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: CreateQuoteDto) {
    return this.rfq.createQuote(req.user.sub, id, dto);
  }

  /** All quotes on one of the caller's RFQs (buyer-only). */
  @Get(':id/quotes')
  quotesForMyRfq(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.rfq.listQuotesForMyRfq(req.user.sub, id);
  }
}
