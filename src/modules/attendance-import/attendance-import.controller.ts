import {
  Controller,
  Post,
  Param,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { Request } from 'express';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AttendanceImportService } from './attendance-import.service';
import { ParseResponseDto } from './dto/parse-response.dto';
import { CommitRequestDto, CommitResult } from './dto/commit-request.dto';

const ALLOWED_EXTENSIONS = ['.dat', '.xls', '.xlsx', '.csv', '.txt'];

@Controller('workspaces/:workspaceId/attendance/import')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceImportController {
  constructor(private readonly importService: AttendanceImportService) {}

  /**
   * POST /api/workspaces/:workspaceId/attendance/import/parse
   * Accepts multipart file field named 'file', max 5 MB.
   * Returns format, preview rows, column map, and unique device user IDs.
   * Auth: JwtAuthGuard + RolesGuard (workspace membership verified via RequirePermissions).
   * NOTE: XLSX.read() is synchronous and blocks the event loop for large files.
   * For production scale, offload to a worker thread.
   */
  @Post('parse')
  @RequirePermission('attendance.record.mark')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB (reduced from 10 MB to limit sync parse time)
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              `Unsupported file extension "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
            ),
            false,
          );
        }
      },
    }),
  )
  parse(
    @Param('workspaceId') _workspaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ): ParseResponseDto {
    if (!file) {
      throw new BadRequestException('No file uploaded. Use field name "file".');
    }
    return this.importService.detectAndPreview(file);
  }

  /**
   * POST /api/workspaces/:workspaceId/attendance/import/commit
   * Multipart: field 'file' (same file as parse), field 'data' (JSON string of CommitRequestDto).
   * When dryRun=true in the data payload: returns counts without writing events.
   */
  @Post('commit')
  @RequirePermission('attendance.record.mark')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              `Unsupported file extension "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
            ),
            false,
          );
        }
      },
    }),
  )
  async commit(
    @Param('workspaceId') workspaceId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('data') dataJson: string,
    @Req() req: Request,
  ): Promise<CommitResult> {
    if (!file) {
      throw new BadRequestException('No file uploaded. Use field name "file".');
    }
    if (!dataJson) {
      throw new BadRequestException('Missing "data" form field (JSON CommitRequestDto).');
    }

    let plain: unknown;
    try {
      plain = JSON.parse(dataJson);
    } catch {
      throw new BadRequestException('Invalid JSON in "data" form field.');
    }

    const dto = plainToInstance(CommitRequestDto, plain);
    const validationErrors = validateSync(dto);
    if (validationErrors.length > 0) {
      throw new BadRequestException(
        validationErrors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join('; '),
      );
    }

    // Extract authenticated user ID from JWT payload (attached by JwtAuthGuard).
    const userId = (req as any).user?.userId ?? (req as any).user?._id ?? 'unknown';

    return this.importService.commitImport(workspaceId, file, dto, userId);
  }
}
