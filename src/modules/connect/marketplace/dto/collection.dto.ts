import {
  ArrayMaxSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/** Create a shop Collection. The slug is derived server-side from the title. */
export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  // Cover must be an https URL (the media-ownership guard further checks it is
  // on our storage and uploaded by the caller).
  @IsUrl({ protocols: ['https'], require_protocol: true })
  coverImage?: string;
}

/** Update a Collection. All optional; the slug is re-derived when title changes. */
export class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  // Cover must be an https URL (the media-ownership guard further checks it is
  // on our storage and uploaded by the caller).
  @IsUrl({ protocols: ['https'], require_protocol: true })
  coverImage?: string;
}

/** Reorder the shop's collections: the full ordered list of collection ids. */
export class ReorderCollectionsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  orderedIds!: string[];
}

/** Set the exact members + order of a collection (the manage-a-collection view). */
export class SetCollectionProductsDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @IsMongoId({ each: true })
  listingIds!: string[];
}

/** Bulk-add products to a collection (union; no removals). */
export class AddCollectionProductsDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @IsMongoId({ each: true })
  listingIds!: string[];
}

/** Set which collections a single product belongs to (the product-editor path). */
export class SetListingCollectionsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  collectionIds!: string[];
}
