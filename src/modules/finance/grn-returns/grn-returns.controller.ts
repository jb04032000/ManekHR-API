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
import { GrnReturnsService } from './grn-returns.service';
import {
  CreateGrnReturnDto,
  UpdateGrnReturnDto,
  CancelGrnReturnDto,
  ListGrnReturnsQueryDto,
} from './grn-return.dto';

@ApiTags('GRN Returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_grn_returns' })
@Controller('workspaces/:wsId/finance/firms/:firmId/grn-returns')
export class GrnReturnsController {
  constructor(private readonly grnReturnsService: GrnReturnsService) {}

  /** POST /workspaces/:wsId/finance/firms/:firmId/grn-returns — create draft */
  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @ApiOperation({ summary: 'Create draft GRN-Return' })
  async create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateGrnReturnDto,
    @CurrentUser() user: any,
  ) {
    const gr = await this.grnReturnsService.createDraft(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data: gr };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/grn-returns — list with filters */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @ApiOperation({ summary: 'List GRN-Returns with filters and pagination' })
  async findAll(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: ListGrnReturnsQueryDto,
  ) {
    const result = await this.grnReturnsService.findAll(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      query,
    );
    return { success: true, data: result };
  }

  /** GET /workspaces/:wsId/finance/firms/:firmId/grn-returns/:id — detail */
  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Get GRN-Return detail' })
  async findOne(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
  ) {
    const gr = await this.grnReturnsService.findById(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
    );
    return { success: true, data: gr };
  }

  /** PATCH /workspaces/:wsId/finance/firms/:firmId/grn-returns/:id — update draft */
  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @ApiOperation({ summary: 'Update draft GRN-Return' })
  async update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: UpdateGrnReturnDto,
    @CurrentUser() user: any,
  ) {
    const gr = await this.grnReturnsService.update(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto,
      user._id ?? user.sub,
    );
    return { success: true, data: gr };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/grn-returns/:id/dispatch — dispatch (draft → dispatched; stockOut) */
  @Post(':id/dispatch')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Dispatch GRN-Return: assigns voucherNumber, reduces stock (negative stock allowed — warns only per Pitfall 6)',
  })
  async dispatch(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    const gr = await this.grnReturnsService.dispatch(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
    return { success: true, data: gr };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/grn-returns/:id/confirm — confirm (dispatched → confirmed) */
  @Post(':id/confirm')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm GRN-Return: vendor has acknowledged receipt. Returns promptCreateDebitNote=true if no DN linked yet.',
  })
  async confirm(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    const result = await this.grnReturnsService.confirm(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      user._id ?? user.sub,
    );
    return { success: true, data: result };
  }

  /** POST /workspaces/:wsId/finance/firms/:firmId/grn-returns/:id/cancel — cancel */
  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel GRN-Return. If state was dispatched or confirmed, restores stock via stockIn (Edge Case 6).',
  })
  async cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: CancelGrnReturnDto,
    @CurrentUser() user: any,
  ) {
    const gr = await this.grnReturnsService.cancel(
      new Types.ObjectId(wsId),
      new Types.ObjectId(firmId),
      id,
      dto.reason,
      user._id ?? user.sub,
    );
    return { success: true, data: gr };
  }
}
