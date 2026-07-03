import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedOnly } from '../../common/decorators/require-permission.decorator';
import { PERMISSION_REGISTRY } from './permission-registry';
import { TEAM_ROLE_PRESETS } from './role-presets';

/**
 * Serves the static permission registry tree and role presets so the web
 * permission matrix renders registry-driven rows without duplicating the
 * catalog. Both the registry and presets are structural metadata — no
 * per-workspace data, no secrets — so any authenticated workspace member
 * may read them.
 */
@Controller('workspaces/:workspaceId/rbac')
@UseGuards(JwtAuthGuard)
export class RbacRegistryController {
  @Get('registry')
  @AuthenticatedOnly()
  getRegistry() {
    return { registry: PERMISSION_REGISTRY };
  }

  @Get('presets')
  @AuthenticatedOnly()
  getPresets() {
    return { team: TEAM_ROLE_PRESETS };
  }
}
