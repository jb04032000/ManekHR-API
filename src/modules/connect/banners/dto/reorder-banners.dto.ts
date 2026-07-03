import { ArrayNotEmpty, IsArray, IsMongoId } from 'class-validator';

/**
 * Body for `PUT /admin/connect/banners/reorder`. `orderedIds` is the desired
 * top-to-bottom sequence; each banner's `order` becomes its index. Used by the
 * admin drag-reorder table.
 */
export class ReorderBannersDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsMongoId({ each: true })
  orderedIds: string[];
}
