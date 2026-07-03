import { IsIn, IsMongoId } from 'class-validator';
import {
  CONNECT_VIEW_TARGET_TYPES,
  type ConnectViewTargetType,
} from '../schemas/connect-view-daily.schema';

/** Body for `POST /connect/views` -- record one view of a storefront or listing. */
export class RecordViewDto {
  @IsIn(CONNECT_VIEW_TARGET_TYPES)
  targetType: ConnectViewTargetType;

  @IsMongoId()
  targetId: string;
}
