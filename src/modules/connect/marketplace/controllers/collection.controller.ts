import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { CollectionService } from '../services/collection.service';
import {
  AddCollectionProductsDto,
  CreateCollectionDto,
  ReorderCollectionsDto,
  SetCollectionProductsDto,
  UpdateCollectionDto,
} from '../dto/collection.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/...` -- Shop Collections owner admin. Person-centric: the owner is
 * always `req.user.sub`; the service verifies ownership of the collection AND of
 * every shop / listing it touches.
 */
@LegacyUnclassified()
@Controller('connect')
@UseGuards(JwtAuthGuard)
export class CollectionController {
  constructor(private readonly service: CollectionService) {}

  /** Create a collection in one of the owner's shops. */
  @Post('storefronts/:storefrontId/collections')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  create(
    @Req() req: AuthedRequest,
    @Param('storefrontId') storefrontId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.service.create(req.user.sub, storefrontId, dto);
  }

  /** The shop's collections (owner view), ordered, each with its product count. */
  @Get('storefronts/:storefrontId/collections')
  listMine(@Req() req: AuthedRequest, @Param('storefrontId') storefrontId: string) {
    return this.service.listMine(req.user.sub, storefrontId);
  }

  /** Reorder the shop's collections from a full ordered id list. */
  @Post('storefronts/:storefrontId/collections/reorder')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  reorder(
    @Req() req: AuthedRequest,
    @Param('storefrontId') storefrontId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    return this.service.reorderCollections(req.user.sub, storefrontId, dto.orderedIds);
  }

  /** Rename / re-describe / re-cover a collection. */
  @Patch('collections/:id')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpdateCollectionDto) {
    return this.service.update(id, req.user.sub, dto);
  }

  /** Delete a collection (pulls it from every member product). */
  @Delete('collections/:id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.remove(id, req.user.sub);
  }

  /** Set the exact members + order of a collection (manage view). */
  @Post('collections/:id/products')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  setProducts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: SetCollectionProductsDto,
  ) {
    return this.service.setProducts(id, req.user.sub, dto.listingIds);
  }

  /** Bulk-add products to a collection (union; no removals). */
  @Post('collections/:id/products/add')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  addProducts(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: AddCollectionProductsDto,
  ) {
    return this.service.addProductsBulk(id, req.user.sub, dto.listingIds);
  }
}
