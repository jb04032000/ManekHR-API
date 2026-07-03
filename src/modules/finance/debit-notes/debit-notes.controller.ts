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
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequireSubscription, SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { DebitNotesService } from './debit-notes.service';
import {
  CreateDebitNoteDto,
  UpdateDebitNoteDto,
  CancelDebitNoteDto,
  ListDebitNotesQueryDto,
} from './debit-note.dto';

@ApiTags('Debit Notes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'sales_credit_debit_notes' })
@Controller('workspaces/:wsId/finance/firms/:firmId/debit-notes')
export class DebitNotesController {
  constructor(private readonly debitNotesService: DebitNotesService) {}

  /** POST /workspaces/:wsId/finance/firms/:firmId/debit-notes — create draft */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @ApiOperation({ summary: 'Create draft Debit Note from source Purchase Bill' })
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateDebitNoteDto,
    @CurrentUser() user: any,
  ) {
    const dn = await this.debitNotesService.createDraft(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data: dn };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/debit-notes — list with filters */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List Debit Notes with filters and pagination' })
  async findAll(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListDebitNotesQueryDto,
  ) {
    const result = await this.debitNotesService.findAll(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      query,
    );
    return { success: true, data: result };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/debit-notes/by-bill/:billId
   *  IMPORTANT: must be declared BEFORE /:id to avoid NestJS routing 'by-bill' as :id param */
  @Get('by-bill/:billId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List Debit Notes against a specific Purchase Bill' })
  async findByBill(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('billId') billId: string,
  ) {
    const items = await this.debitNotesService.listByBill(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      billId,
    );
    return { success: true, data: items };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/debit-notes/:id — detail */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Get Debit Note detail' })
  async findOne(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    const dn = await this.debitNotesService.findById(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
    );
    return { success: true, data: dn };
  }

  /** PATCH /workspaces/:wsId/finance/firms/:firmId/debit-notes/:id — update draft */
  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Update draft Debit Note' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDebitNoteDto,
    @CurrentUser() user: any,
  ) {
    const dn = await this.debitNotesService.update(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data: dn };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/debit-notes/:id/post — post voucher */
  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Post Debit Note (creates LedgerEntry, updates PurchaseBill outstanding, reverses CapitalGoodsItcSchedule if applicable). ' +
      'Capital goods ITC routed to account 1103 (deferred) per Edge Case 4.',
  })
  async postDebitNote(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    const dn = await this.debitNotesService.post(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
    return { success: true, data: dn };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/debit-notes/:id/cancel — cancel posted */
  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel posted Debit Note (reverses LedgerEntry, restores PurchaseBill outstanding, restores CapitalGoodsItcSchedule rows)',
  })
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: CancelDebitNoteDto,
    @CurrentUser() user: any,
  ) {
    const dn = await this.debitNotesService.cancel(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto.reason,
      user._id ?? user.sub,
    );
    return { success: true, data: dn };
  }
}
