import { Injectable, Logger } from '@nestjs/common';

/**
 * LEDGER-STABLE NO-OP STUB — Connect product removed from ManekHR (2026-07-04).
 *
 * The original DropEngagementViewTtlIndexService migrated Connect-only collections. Its migration-unit
 * name stays registered in migrations.module.ts so the applied-migrations
 * ledger keeps matching on databases that already ran it; on a fresh database
 * the unit records itself as applied without touching anything. Do not add
 * Connect logic back here.
 */
@Injectable()
export class DropEngagementViewTtlIndexService {
  private readonly logger = new Logger(DropEngagementViewTtlIndexService.name);

  async run(): Promise<void> {
    this.logger.log('no-op: Connect product removed from ManekHR (2026-07-04)');
  }
}
