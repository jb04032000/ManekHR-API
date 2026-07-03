import {
  Controller,
  Post,
  Delete,
  UseInterceptors,
  UseGuards,
  UploadedFile,
  Query,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UploadsService } from './uploads.service';
import { UploadResponseDto } from './dto/upload-response.dto';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/** JWT payload populated by the global JwtAuthGuard. `sub` is the User id. */
interface AuthedUser {
  sub: string;
  isAdmin?: boolean;
}

@LegacyUnclassified()
@UseGuards(ThrottlerGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  /**
   * Upload a single file.
   *
   * The uploader is always the authenticated user (`req.user.sub`) — never the
   * client body — and is recorded as the file's owner. `workspaceId` (optional
   * query param) attributes the upload to a workspace's storage quota, but the
   * caller must be a member of that workspace (else 403); the param can no
   * longer be used to charge an arbitrary workspace. Connect categories
   * (prefixed `connect-`) are additionally subject to a per-USER storage cap.
   *
   * Throttled to 20 uploads/min per user (`uploads-single` tier) as an abuse
   * guard.
   */
  @Post('single')
  @Throttle({ 'uploads-single': { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  async uploadSingle(
    @UploadedFile() file: any,
    @CurrentUser() user: AuthedUser,
    @Query('category') category: string,
    @Query('workspaceId') workspaceId?: string,
  ): Promise<UploadResponseDto> {
    if (!category) {
      throw new BadRequestException('Category query parameter is required');
    }

    return this.uploadsService.uploadSingle(file, category, user.sub, workspaceId);
  }

  /**
   * Delete a file. Only the recorded uploader or a platform admin may delete
   * it (ownership is enforced server-side against the upload record). The
   * `workspaceId` + `fileSizeBytes` body fields are still ACCEPTED for FE
   * backward-compat but are no longer trusted — the quota refund is derived
   * from the stored record.
   */
  @Delete('file')
  async deleteFile(
    @CurrentUser() user: AuthedUser,
    @Body('url') url: string,
    // Accepted for FE backward-compat; intentionally ignored (not trusted).
    @Body('workspaceId') _workspaceId?: string,
    @Body('fileSizeBytes') _fileSizeBytes?: number,
  ): Promise<{ success: boolean }> {
    if (!url) {
      throw new BadRequestException('URL is required');
    }

    await this.uploadsService.deleteFileForUser(url, user.sub, user.isAdmin === true);
    return { success: true };
  }
}
