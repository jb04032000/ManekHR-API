import { Controller, Get } from '@nestjs/common';
import { Public } from '../../../../common/decorators/public.decorator';
import { BannerService } from '../services/banner.service';

/**
 * `connect/banners` — the public feed-carousel read. `@Public()` (no auth): the
 * carousel is viewer-independent promo content, so it serves the same list to
 * everyone (and works even before login). Returns only banners that are active
 * AND inside their live window, sorted by order; `[]` when nothing is live or
 * the feature flag is off (the FE renders nothing on an empty list).
 */
@Controller('connect/banners')
export class BannerPublicController {
  constructor(private readonly banners: BannerService) {}

  @Public()
  @Get()
  list() {
    return this.banners.listActive();
  }
}
