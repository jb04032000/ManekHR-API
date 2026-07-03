import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { SamplesService } from './samples.service';
import { CreateSampleVoucherDto } from './dto/create-sample-voucher.dto';
import { UpdateSampleVoucherDto } from './dto/update-sample-voucher.dto';
import { AcceptSampleVoucherDto } from './dto/accept-sample-voucher.dto';
import { ReturnSampleVoucherDto } from './dto/return-sample-voucher.dto';

/**
 * SamplesController — D-07 Sample/Consignment voucher endpoints.
 *
 * Base path: workspaces/:wsId/finance/firms/:firmId/inventory/samples
 *
 * Endpoints (8 total per D-16):
 *   GET    /samples                   — list with filters
 *   POST   /samples                   — create (draft)
 *   GET    /samples/:id               — get by id
 *   PATCH  /samples/:id               — update (draft/sent/partially_accepted only)
 *   POST   /samples/:id/post          — post (draft → sent)
 *   POST   /samples/:id/accept        — accept goods (sent/partially_accepted → fully_accepted/partially_accepted)
 *   POST   /samples/:id/return        — return goods (sent/partially_accepted → rejected_returned/partially_accepted)
 *   DELETE /samples/:id               — soft delete (draft only)
 */
@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/samples')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'samples' })
export class SamplesController {
  constructor(private readonly service: SamplesService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async list(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query('status') status?: string,
    @Query('sampleType') sampleType?: string,
    @Query('partyId') partyId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return {
      success: true,
      data: await this.service.list(wsId, firmId, { status, sampleType, partyId, from, to }),
    };
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateSampleVoucherDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.create(wsId, firmId, dto, user._id ?? user.id),
    };
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  async findById(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    return { success: true, data: await this.service.findById(wsId, firmId, id) };
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSampleVoucherDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.update(wsId, firmId, id, dto, user._id ?? user.id),
    };
  }

  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.post(wsId, firmId, id, user._id ?? user.id),
    };
  }

  @Post(':id/accept')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async accept(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: AcceptSampleVoucherDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.accept(wsId, firmId, id, dto, user._id ?? user.id),
    };
  }

  @Post(':id/return')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  async return(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: ReturnSampleVoucherDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.service.return(wsId, firmId, id, dto, user._id ?? user.id),
    };
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  async delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    await this.service.delete(wsId, firmId, id, user._id ?? user.id);
    return { success: true, data: { deleted: true } };
  }
}
