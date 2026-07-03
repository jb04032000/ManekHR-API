import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../../../common/decorators/public.decorator';
import { ListingService } from '../services/listing.service';

/**
 * `connect/marketplace/public` -- unauthenticated marketplace reads.
 *
 * Only `active` + moderation-`approved` listings are publicly visible; anything
 * else reads as not-found to a non-owner.
 */
@Controller('connect/marketplace/public')
export class ListingPublicController {
  constructor(private readonly listings: ListingService) {}

  /** Public listing detail. */
  @Public()
  @Get('listings/:id')
  getPublic(@Param('id') id: string) {
    return this.listings.getPublic(id);
  }

  /** A storefront's own public products (active + approved), for `/store/[slug]`. */
  @Public()
  @Get('storefront/:storefrontId/listings')
  listByStorefront(@Param('storefrontId') storefrontId: string) {
    return this.listings.listPublicByStorefront(storefrontId);
  }

  /**
   * A company page's public products: the active + approved listings across the
   * public storefronts linked to that page. Powers the company page Products tab.
   */
  @Public()
  @Get('company-page/:pageId/listings')
  listByCompanyPage(@Param('pageId') pageId: string) {
    return this.listings.listPublicByCompanyPage(pageId);
  }
}
