import { Module } from '@nestjs/common';
import { ConnectContentPurgeService } from './connect-content-purge.service';

/**
 * Connect account-purge module (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A / §6).
 *
 * Provides {@link ConnectContentPurgeService}, the manifest-driven Day-30 Connect
 * content purge. The service depends only on the GLOBAL Mongoose connection
 * (`@InjectConnection`, from `MongooseModule.forRoot`) + the GLOBAL event bus
 * (`EventEmitter2`, from `EventEmitterModule.forRoot`), so this module needs no
 * imports — deliberately, to keep the purge decoupled from the Connect service
 * graph (no import cycles, no heavy construction tree). The search-indexer
 * listeners that consume the de-index events it emits live in the already-loaded
 * Connect SearchModule.
 *
 * Imported by `AccountDeletionModule` so the Day-30 finalize (Scope 3) + the
 * Connect-purge sweep (Scope 1) can run it.
 */
@Module({
  providers: [ConnectContentPurgeService],
  exports: [ConnectContentPurgeService],
})
export class ConnectAccountPurgeModule {}
