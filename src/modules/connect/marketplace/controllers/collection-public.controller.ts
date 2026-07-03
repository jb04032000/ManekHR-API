import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../../../common/decorators/public.decorator';
import { CollectionService } from '../services/collection.service';

/**
 * `connect/marketplace/public` -- unauthenticated Shop Collections reads.
 *
 * Powers the public storefront's collection browser. Returns each collection
 * with its LIVE (active + approved) product count; the client hides any with a
 * zero live count so the public tab row carries no dead chips.
 */
@Controller('connect/marketplace/public')
export class CollectionPublicController {
  constructor(private readonly collections: CollectionService) {}

  /** A shop's public collections (ordered), each with its live product count. */
  @Public()
  @Get('storefront/:storefrontId/collections')
  listByStorefront(@Param('storefrontId') storefrontId: string) {
    return this.collections.listPublicByStorefront(storefrontId);
  }
}
