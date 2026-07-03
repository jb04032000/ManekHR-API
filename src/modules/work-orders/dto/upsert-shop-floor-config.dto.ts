import { Type } from 'class-transformer';
import {
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One floor name — order in the array is the display order (preserved). */
export class ShopFloorFloorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}

/** One team-member→floor link; `floor` must match a floors[].name. */
export class ShopFloorPersonDto {
  @IsMongoId()
  teamMemberId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  floor!: string;
}

/**
 * UpsertShopFloorConfigDto — body for
 * `PUT /workspaces/:wsId/machines/shop-floor-config`. Full-replace upsert
 * keyed on (workspaceId, locationId); business rules (≤12 floors,
 * case-insensitive uniqueness, floor refs, member existence) live in the
 * service so they surface as { code, message } errors, not class-validator.
 */
export class UpsertShopFloorConfigDto {
  @IsMongoId()
  locationId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShopFloorFloorDto)
  floors!: ShopFloorFloorDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShopFloorPersonDto)
  people!: ShopFloorPersonDto[];
}
