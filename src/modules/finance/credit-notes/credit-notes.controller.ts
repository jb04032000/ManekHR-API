import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CreditNotesService } from './credit-notes.service';
import {
  CreateCreditNoteDto,
  UpdateCreditNoteDto,
  CancelCreditNoteDto,
  ListCreditNotesQueryDto,
} from './credit-note.dto';

@ApiTags('Credit Notes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'sales_credit_debit_notes' })
@Controller('workspaces/:wsId/finance/firms/:firmId/credit-notes')
export class CreditNotesController {
  constructor(private readonly creditNotesService: CreditNotesService) {}

  /** POST /workspaces/:wsId/finance/firms/:firmId/credit-notes — create draft */
  @Post()
  @RequirePermission('finance.creditNote.create', 'self')
  @ApiOperation({ summary: 'Create draft Credit Note from source Tax Invoice' })
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateCreditNoteDto,
    @CurrentUser() user: any,
  ) {
    const cn = await this.creditNotesService.createDraft(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data: cn };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/credit-notes — list with filters */
  @Get()
  @RequirePermission('finance.invoice.view', 'self')
  @ApiOperation({ summary: 'List Credit Notes with filters and pagination' })
  async findAll(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListCreditNotesQueryDto,
  ) {
    const result = await this.creditNotesService.findAll(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      query,
    );
    return { success: true, data: result };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/credit-notes/by-invoice/:invoiceId
   *  IMPORTANT: must be declared BEFORE /:id to avoid NestJS routing 'by-invoice' as :id param */
  @Get('by-invoice/:invoiceId')
  @RequirePermission('finance.invoice.view', 'self')
  @ApiOperation({ summary: 'List Credit Notes against a specific Tax Invoice' })
  async findByInvoice(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    const items = await this.creditNotesService.listByInvoice(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      invoiceId,
    );
    return { success: true, data: items };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/credit-notes/:id — detail */
  @Get(':id')
  @RequirePermission('finance.invoice.view', 'self')
  @ApiOperation({ summary: 'Get Credit Note detail' })
  async findOne(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    const cn = await this.creditNotesService.findById(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
    );
    return { success: true, data: cn };
  }

  /** PATCH /workspaces/:wsId/finance/firms/:firmId/credit-notes/:id — update draft */
  @Patch(':id')
  @RequirePermission('finance.creditNote.create', 'self')
  @ApiOperation({ summary: 'Update draft Credit Note' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCreditNoteDto,
    @CurrentUser() user: any,
  ) {
    const cn = await this.creditNotesService.update(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data: cn };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/credit-notes/:id/post — post voucher */
  @Post(':id/post')
  @RequirePermission('finance.creditNote.create', 'self')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Post Credit Note (creates LedgerEntry, reverses stock if applicable, updates source invoice outstanding). ' +
      'Enforces Finance Act 2025 ITC reversal confirmation for B2B CNs > ₹5L.',
  })
  async postCreditNote(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    const cn = await this.creditNotesService.post(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
    return { success: true, data: cn };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/credit-notes/:id/cancel — cancel posted */
  @Post(':id/cancel')
  @RequirePermission('finance.creditNote.create', 'self')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel posted Credit Note (reverses LedgerEntry, restores stock, restores invoice outstanding)',
  })
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: CancelCreditNoteDto,
    @CurrentUser() user: any,
  ) {
    const cn = await this.creditNotesService.cancel(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto.reason,
      user._id ?? user.sub,
    );
    return { success: true, data: cn };
  }
}
