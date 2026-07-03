import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { BankReconciliationService } from './bank-reconciliation.service';
import { BrsReportService } from './brs-report.service';
import { CreateFromRowService } from './create-from-row.service';
import { ManualMatchDto, BulkMatchDto } from './dto/manual-match.dto';
import { CreateFromRowDto } from './dto/create-from-row.dto';
import { ExcludeRowDto } from './dto/exclude-row.dto';
import { ListRowsDto } from './dto/list-rows.dto';
import { CompleteSessionDto } from './dto/complete-session.dto';
import { GenericColumnMappingDto } from './dto/upload-statement.dto';

// ─── File upload options (reused for both upload + confirm) ──────────────────

const ALLOWED_EXTENSIONS = ['.csv', '.xls', '.xlsx'];

const uploadInterceptorOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (
    _req: any,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new BadRequestException(`Unsupported extension ${ext}`), false);
    }
  },
};

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/bank-accounts/:bankAccountId/reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'banking_bank_accounts' })
export class BankReconciliationController {
  constructor(
    private readonly recon: BankReconciliationService,
    private readonly brsReport: BrsReportService,
    private readonly createFromRow: CreateFromRowService,
  ) {}

  // ─── 1. Upload preview (multipart, no persist) ───────────────────────────────

  @Post('statements/upload')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @UseInterceptors(FileInterceptor('file', uploadInterceptorOptions))
  async upload(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bankAccountId') bankAccountId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('genericMapping') genericMappingRaw?: string,
  ) {
    if (!file) throw new BadRequestException('file field required');
    let mapping: GenericColumnMappingDto | undefined;
    if (genericMappingRaw) {
      try {
        mapping = JSON.parse(genericMappingRaw) as GenericColumnMappingDto;
      } catch {
        throw new BadRequestException('genericMapping must be valid JSON');
      }
    }
    return {
      success: true,
      data: await this.recon.parseStatementPreview(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(bankAccountId),
        file.buffer,
        file.originalname,
        mapping,
      ),
    };
  }

  // ─── 2. Confirm + persist (multipart) ────────────────────────────────────────

  @Post('statements/confirm')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @UseInterceptors(FileInterceptor('file', uploadInterceptorOptions))
  async confirm(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bankAccountId') bankAccountId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
    @Body('genericMapping') genericMappingRaw?: string,
  ) {
    if (!file) throw new BadRequestException('file field required');
    let mapping: GenericColumnMappingDto | undefined;
    if (genericMappingRaw) {
      try {
        mapping = JSON.parse(genericMappingRaw) as GenericColumnMappingDto;
      } catch {
        throw new BadRequestException('genericMapping must be valid JSON');
      }
    }
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.confirmStatement(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(bankAccountId),
        file.buffer,
        file.originalname,
        new Types.ObjectId(userId),
        mapping,
      ),
    };
  }

  // ─── 3. List statements ───────────────────────────────────────────────────────

  @Get('statements')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async listStatements(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bankAccountId') bankAccountId: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      success: true,
      data: await this.recon.listStatements(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(bankAccountId),
        skip ? Number(skip) : 0,
        limit ? Number(limit) : 20,
      ),
    };
  }

  // ─── 4. Get one statement ─────────────────────────────────────────────────────

  @Get('statements/:statementId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async getStatement(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('statementId') statementId: string,
  ) {
    return {
      success: true,
      data: await this.recon.getStatement(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(statementId),
      ),
    };
  }

  // ─── 5. Delete statement ──────────────────────────────────────────────────────

  @Delete('statements/:statementId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async deleteStatement(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('statementId') statementId: string,
  ) {
    await this.recon.deleteStatement(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(statementId),
    );
    return { success: true, data: { deleted: true } };
  }

  // ─── 6. List sessions ─────────────────────────────────────────────────────────

  @Get('sessions')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async listSessions(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bankAccountId') bankAccountId: string,
  ) {
    return {
      success: true,
      data: await this.recon.listSessions(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(bankAccountId),
      ),
    };
  }

  // ─── 7. Get session ───────────────────────────────────────────────────────────

  @Get('sessions/:sessionId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async getSession(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return {
      success: true,
      data: await this.recon.getSession(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
      ),
    };
  }

  // ─── 8. List rows in session ──────────────────────────────────────────────────

  @Get('sessions/:sessionId/rows')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async listRows(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Query() query: ListRowsDto,
  ) {
    return {
      success: true,
      data: await this.recon.listRows(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        query,
      ),
    };
  }

  // ─── 9. Run auto-match ────────────────────────────────────────────────────────

  @Post('sessions/:sessionId/auto-match')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async autoMatch(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.runAutoMatch(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 10. Manual match (single row → 1+ entries) ───────────────────────────────

  @Post('sessions/:sessionId/rows/:rowId/match')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async manualMatch(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Param('rowId') rowId: string,
    @Body() dto: ManualMatchDto,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.manualMatch(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(rowId),
        dto,
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 11. Bulk match (N rows ↔ M entries) ─────────────────────────────────────

  @Post('sessions/:sessionId/bulk-match')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async bulkMatch(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: BulkMatchDto,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.bulkMatch(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        dto,
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 12. Unmatch row ──────────────────────────────────────────────────────────

  @Post('sessions/:sessionId/rows/:rowId/unmatch')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async unmatch(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Param('rowId') rowId: string,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.unmatchRow(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(rowId),
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 13. Create voucher from unmatched row ────────────────────────────────────

  @Post('sessions/:sessionId/rows/:rowId/create-voucher')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async createVoucher(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Param('rowId') rowId: string,
    @Body() dto: CreateFromRowDto,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.createFromRow.create(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(rowId),
        dto,
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 14. Exclude / dispute row ────────────────────────────────────────────────

  @Post('sessions/:sessionId/rows/:rowId/exclude')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async exclude(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Param('rowId') rowId: string,
    @Body() dto: ExcludeRowDto,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.excludeRow(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(rowId),
        dto,
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 15. Un-exclude row ───────────────────────────────────────────────────────

  @Post('sessions/:sessionId/rows/:rowId/unexclude')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async unexclude(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Param('rowId') rowId: string,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    return {
      success: true,
      data: await this.recon.unexcludeRow(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(rowId),
        new Types.ObjectId(userId),
      ),
    };
  }

  // ─── 16. Candidates for "Link to Voucher" drawer ──────────────────────────────

  @Get('sessions/:sessionId/rows/:rowId/candidates')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async candidates(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
    @Param('rowId') rowId: string,
  ) {
    return {
      success: true,
      data: await this.recon.getCandidatesForRow(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
        new Types.ObjectId(rowId),
      ),
    };
  }

  // ─── 17. Complete session (lock if differenceExplained === 0) ────────────────

  @Post('sessions/:sessionId/complete')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async complete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('bankAccountId') bankAccountId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: CompleteSessionDto,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;

    const result = await this.recon.completeSession(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      new Types.ObjectId(sessionId),
      new Types.ObjectId(userId),
      dto.note,
    );

    return { success: true, data: result };
  }

  // ─── 18. BRS report ───────────────────────────────────────────────────────────

  @Get('sessions/:sessionId/report')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async report(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return {
      success: true,
      data: await this.brsReport.generate(
        new Types.ObjectId(wsId),
        new Types.ObjectId(firmId),
        new Types.ObjectId(sessionId),
      ),
    };
  }
}
