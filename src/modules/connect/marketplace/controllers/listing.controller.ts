import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { ListingService } from '../services/listing.service';
import { CollectionService } from '../services/collection.service';
import { CreateListingDto } from '../dto/create-listing.dto';
import { UpdateListingDto } from '../dto/update-listing.dto';
import { SetListingCollectionsDto } from '../dto/collection.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload populated by JwtAuthGuard -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * `connect/marketplace/listings` -- the seller's own listing management.
 *
 * The owner is always the authenticated Connect User (`req.user.sub`);
 * ownerUserId is never read from the body, so cross-user manipulation is
 * impossible. create() is soft-capped by the person's listing allowance
 * (ConnectAllowanceService), never a hard subscription wall.
 */
@LegacyUnclassified()
@Controller('connect/marketplace/listings')
@UseGuards(JwtAuthGuard)
export class ListingController {
  constructor(
    private readonly listings: ListingService,
    private readonly collections: CollectionService,
  ) {}

  /** Create a listing (gated by the person's maxListings allowance). */
  @Post()
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  create(@Req() req: AuthedRequest, @Body() dto: CreateListingDto) {
    return this.listings.create(req.user.sub, dto);
  }

  /**
   * The caller's own listings (any status), newest first. `?storefrontId=`
   * scopes to one of the caller's shops (the per-shop product manager); omitted
   * returns all of the owner's listings flat.
   */
  @Get('mine')
  listMine(@Req() req: AuthedRequest, @Query('storefrontId') storefrontId?: string) {
    return this.listings.listMine(req.user.sub, storefrontId);
  }

  /**
   * Per-storefront roll-up (products / live / inquiries) for the caller's own
   * shops -- powers the Storefronts dashboard. One entry per storefront the
   * caller has at least one listing in.
   */
  @Get('mine/storefront-stats')
  storefrontStats(@Req() req: AuthedRequest) {
    return this.listings.storefrontStats(req.user.sub);
  }

  /** Patch a listing's content (owner-only); re-submits an approved listing for review. */
  @Patch(':id')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  update(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpdateListingDto) {
    return this.listings.update(id, req.user.sub, dto);
  }

  /** Publish a listing: live when approved, else submitted for review (owner-only). */
  @Post(':id/publish')
  publish(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.listings.publish(id, req.user.sub);
  }

  /** Pause an active listing (owner-only). */
  @Post(':id/pause')
  pause(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.listings.pause(id, req.user.sub);
  }

  /** Set which of the shop's collections this product belongs to (owner-only). */
  @Patch(':id/collections')
  @Throttle({ 'connect-write': { limit: 30, ttl: 60_000 } })
  setCollections(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: SetListingCollectionsDto,
  ) {
    return this.collections.setListingCollections(id, req.user.sub, dto.collectionIds);
  }

  /** Delete a listing (owner-only). */
  @Delete(':id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.listings.remove(id, req.user.sub);
  }
}
