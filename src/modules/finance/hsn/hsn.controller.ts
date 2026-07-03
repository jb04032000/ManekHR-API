import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { HsnService } from './hsn.service';

// GET .../finance/hsn/search?q=&limit= - plain-language HSN/SAC finder (D18). Read-only
// reference lookup (FINANCE.VIEW); no paid subfeature gate. Served from an in-memory cache.
@ApiTags('Finance - GST')
@Controller('workspaces/:workspaceId/finance/hsn')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class HsnController {
  constructor(private readonly hsn: HsnService) {}

  @Get('search')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    const n = limit ? Math.min(Math.max(Number(limit) || 10, 1), 25) : 10;
    return this.hsn.search(q ?? '', n);
  }
}
