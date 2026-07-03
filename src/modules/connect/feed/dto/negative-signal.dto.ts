import { IsIn, IsMongoId } from 'class-validator';
import {
  CLIENT_NEGATIVE_SIGNAL_KINDS,
  type ClientNegativeSignalKind,
} from '../schemas/feed-negative-signal.schema';

/**
 * Body for the "show me less" endpoints (`POST` to record, `DELETE` to undo) on
 * `/me/connect/feed/negative`. Only CLIENT kinds are accepted — the derived
 * `not_interested_author` kind is server-side only and never settable here.
 */
export class NegativeSignalDto {
  @IsIn(CLIENT_NEGATIVE_SIGNAL_KINDS as readonly string[])
  kind!: ClientNegativeSignalKind;

  /** Post id (`hide_post` / `not_interested`) or author id (`mute_author`). */
  @IsMongoId()
  targetId!: string;
}
