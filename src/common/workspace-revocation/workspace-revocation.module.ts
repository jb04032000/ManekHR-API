import { Global, Module } from '@nestjs/common';
import { WorkspaceRevocationService } from './workspace-revocation.service';

/**
 * Wave 2 token revocation — Global module so RolesGuard, WorkspacesService,
 * and TeamService can inject the service without per-module wiring.
 * Depends on the Global RedisModule (REDIS_CLIENT provider).
 */
@Global()
@Module({
  providers: [WorkspaceRevocationService],
  exports: [WorkspaceRevocationService],
})
export class WorkspaceRevocationModule {}
