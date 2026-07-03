import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId } from 'class-validator';
import { VIEW_BATCH_MAX } from '../feed.constants';

/**
 * Body for `POST /me/connect/feed/views` — the post ids that entered the
 * viewer's viewport since the last flush. The client de-dups per session; the
 * service de-dups + caps again, so a generous `VIEW_BATCH_MAX` ceiling is safe.
 */
export class RecordViewsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIEW_BATCH_MAX)
  @IsMongoId({ each: true })
  postIds!: string[];
}
