import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

/**
 * ParseObjectIdPipe — validates that a URL param is a valid 24-hex-character
 * MongoDB ObjectId before passing it to the route handler.
 *
 * Without this pipe, `new Types.ObjectId(rawParam)` throws a BSONError (500)
 * when the caller passes a malformed value such as "undefined" or a UUID.
 * This pipe converts that into a proper 400 BadRequestException.
 *
 * Usage:
 *   @Param('id', ParseObjectIdPipe) id: Types.ObjectId
 */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, Types.ObjectId> {
  transform(value: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`"${value}" is not a valid ObjectId`);
    }
    return new Types.ObjectId(value);
  }
}
