import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../common/guards/admin.guard';
import { CessRulesService } from './cess-rules.service';
import { UpsertCessRuleDto } from './dto/upsert-cess-rule.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/**
 * CessRulesController — D-08 Cess registry management.
 *
 * Base path: finance/cess-rules (global — not workspace-scoped; cess rules are
 * platform-wide per D-12; the CessRule collection carries no workspaceId).
 *
 * Gated with `IsAdminGuard` (platform super-admin) — NOT the workspace-scoped
 * RolesGuard. A workspace-scoped guard would resolve against whatever
 * workspace the caller supplies (route param / x-workspace-id header), letting
 * a FINANCE_ADMIN/owner in any one workspace mutate platform-global cess
 * rules. These rules are read by every tenant, so writes are platform-admin
 * only and reads are exposed to authenticated callers.
 *
 * GET    / — list active rules (any authenticated user)
 * POST   / — upsert rule (platform admin only)
 * DELETE /:id — deactivate rule (platform admin only)
 */
@LegacyUnclassified()
@Controller('finance/cess-rules')
@UseGuards(JwtAuthGuard)
export class CessRulesController {
  constructor(private readonly service: CessRulesService) {}

  @Get()
  async list() {
    return { success: true, data: await this.service.list() };
  }

  @Post()
  @UseGuards(IsAdminGuard)
  async upsert(@Body() dto: UpsertCessRuleDto) {
    return { success: true, data: await this.service.upsert(dto) };
  }

  @Delete(':id')
  @UseGuards(IsAdminGuard)
  async deactivate(@Param('id') id: string) {
    await this.service.deactivate(id);
    return { success: true, data: { deactivated: true } };
  }
}
