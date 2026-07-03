import { Controller, Get, Param } from '@nestjs/common';
import { LegalPagesService } from './legal-pages.service';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Public, unauthenticated read for the marketing site's /terms + /privacy routes.
 * `@Public()` bypasses the global JwtAuthGuard and satisfies the RolesGuard marker;
 * the service filters `status: 'published'` so drafts never leak (404 instead).
 *
 * Cross-module links: web app/(marketing)/{terms,privacy}/[product]/page.tsx fetch
 * by slug; keep slugs (`terms-connect` etc.) in sync with those routes.
 */
@Controller('legal-pages')
export class LegalPagesPublicController {
  constructor(private readonly legalPagesService: LegalPagesService) {}

  @Public()
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.legalPagesService.getPublishedBySlug(slug);
  }
}
