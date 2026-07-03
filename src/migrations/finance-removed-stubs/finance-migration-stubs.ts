import { Injectable, Logger } from '@nestjs/common';

/**
 * LEDGER-STABLE NO-OP STUBS — Finance product removed from ManekHR (2026-07-04,
 * owner directive: no use for this business). Mirrors the same pattern used for
 * the Connect-removal migration stubs.
 *
 * These 5 classes back migration UNITS whose names stay registered in
 * migrations.module.ts so the applied-migrations ledger keeps matching on
 * databases that already ran them; on a fresh ManekHR database each unit
 * records itself as applied without touching anything (Finance collections no
 * longer exist). Do not add Finance logic back here.
 */
@Injectable()
export class GstRateHistoryStubService {
  private readonly logger = new Logger(GstRateHistoryStubService.name);
  async seedIfEmpty(): Promise<void> {
    this.logger.log('no-op: Finance product removed from ManekHR (2026-07-04)');
  }
}

@Injectable()
export class InventoryMigrationStubService {
  private readonly logger = new Logger(InventoryMigrationStubService.name);
  async run(): Promise<void> {
    this.logger.log('no-op: Finance product removed from ManekHR (2026-07-04)');
  }
}

@Injectable()
export class CessRulesSeedStubService {
  private readonly logger = new Logger(CessRulesSeedStubService.name);
  async runSeed(): Promise<void> {
    this.logger.log('no-op: Finance product removed from ManekHR (2026-07-04)');
  }
}

@Injectable()
export class ReminderTemplatesStubService {
  private readonly logger = new Logger(ReminderTemplatesStubService.name);
  async runSeed(): Promise<void> {
    this.logger.log('no-op: Finance product removed from ManekHR (2026-07-04)');
  }
}

@Injectable()
export class HsnStubService {
  private readonly logger = new Logger(HsnStubService.name);
  async seedIfMissing(): Promise<void> {
    this.logger.log('no-op: Finance product removed from ManekHR (2026-07-04)');
  }
}
