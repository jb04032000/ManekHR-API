import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../../../common/decorators/public.decorator';
import { StorefrontService } from '../services/storefront.service';

/**
 * Public Storefront read by slug -- powers the SEO page `/store/[slug]`.
 * `@Public()` (works logged-out). `hidden` shops 404. The storefront's own
 * listings join is added once `Listing.storefrontId` lands (W3 migration).
 */
@Controller('connect/storefronts/public')
export class StorefrontPublicController {
  constructor(private readonly service: StorefrontService) {}

  @Public()
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.service.getPublicBySlug(slug);
  }
}
