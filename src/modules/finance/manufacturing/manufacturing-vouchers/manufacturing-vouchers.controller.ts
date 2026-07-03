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
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import {
  RolesGuard,
  RequirePermissions,
} from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ManufacturingVouchersService } from './manufacturing-vouchers.service';
import { CreateManufacturingVoucherDto } from './dto/create-manufacturing-voucher.dto';
import { IssueMaterialsDto } from './dto/issue-materials.dto';
import { CompleteProductionDto } from './dto/complete-production.dto';
import { ListManufacturingVouchersDto } from './dto/list-manufacturing-vouchers.dto';

/**
 * ManufacturingVouchersController
 *
 * Base path: /workspaces/:wsId/finance/firms/:firmId/manufacturing/manufacturing-vouchers
 *
 * All routes require JwtAuthGuard + RolesGuard + SubscriptionGuard.
 * Subscription gate: AppModule.FINANCE subFeature 'manufacturing_voucher' (D-13 Pro+ gate).
 *
 * Route declaration order matters — 'register' MUST appear before ':mvId' so NestJS
 * does not interpret the literal string "register" as a param value (D-15).
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/manufacturing/manufacturing-vouchers')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.MANUFACTURING, subFeature: 'manufacturing_voucher_lifecycle' })
export class ManufacturingVouchersController {
  constructor(private readonly mvService: ManufacturingVouchersService) {}

  /**
   * GET /...manufacturing-vouchers/register
   * Manufacturing register: all MVs matching filters with completion totals.
   * MUST be declared before GET :mvId to avoid NestJS param ambiguity.
   */
  @Get('register')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async register(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() filters: ListManufacturingVouchersDto,
  ) {
    const data = await this.mvService.register(wsId, firmId, filters);
    return { success: true, data };
  }

  /**
   * GET /...manufacturing-vouchers
   * List manufacturing vouchers with optional filters.
   */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() filters: ListManufacturingVouchersDto,
  ) {
    const data = await this.mvService.list(wsId, firmId, filters);
    return { success: true, data };
  }

  /**
   * POST /...manufacturing-vouchers
   * Create a new draft ManufacturingVoucher.
   */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateManufacturingVoucherDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.mvService.createDraft(
      wsId,
      firmId,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data };
  }

  /**
   * GET /...manufacturing-vouchers/:mvId
   * Get single MV by ID. Draft MVs include lotSuggestions (D-06).
   */
  @Get(':mvId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async detail(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('mvId') mvId: string,
  ) {
    const data = await this.mvService.findById(wsId, firmId, mvId);
    return { success: true, data };
  }

  /**
   * PATCH /...manufacturing-vouchers/:mvId
   * Update a draft MV (allowed fields: componentsPlanned, finishedQty, additionalCosts,
   * narration, batchNo, costMethod). Guard: status must be 'draft'.
   */
  @Patch(':mvId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('mvId') mvId: string,
    @Body() dto: any,
    @CurrentUser() user: any,
  ) {
    const data = await this.mvService.update(wsId, firmId, mvId, dto, user._id ?? user.sub);
    return { success: true, data };
  }

  /**
   * POST /...manufacturing-vouchers/:mvId/issue
   * Issue Materials: draft → in_progress.
   * Records manufacturing_out StockMovements, WIP ledger entry, creates Batch.
   */
  @Post(':mvId/issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async issue(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('mvId') mvId: string,
    @Body() dto: IssueMaterialsDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.mvService.issueMaterials(
      wsId,
      firmId,
      mvId,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data };
  }

  /**
   * POST /...manufacturing-vouchers/:mvId/complete
   * Complete Production: in_progress → completed.
   * Records FG/by-product StockMovements, updates Batch, auto-creates excess scrap WastageEntry,
   * posts FG/Variance/WIP ledger entry.
   */
  @Post(':mvId/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async complete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('mvId') mvId: string,
    @Body() dto: CompleteProductionDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.mvService.completeProduction(
      wsId,
      firmId,
      mvId,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data };
  }

  /**
   * POST /...manufacturing-vouchers/:mvId/cancel
   * Cancel a ManufacturingVoucher.
   * Draft: clean status flip. in_progress: reverses stock, ledger, soft-deletes Batch.
   * Guard: cannot cancel a completed MV (T-F10-W4-07).
   */
  @Post(':mvId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('mvId') mvId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.mvService.cancel(wsId, firmId, mvId, user._id ?? user.sub);
    return { success: true, data };
  }
}
