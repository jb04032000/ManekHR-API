import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PartyTimelineEvent,
  PartyTimelineEventSchema,
} from './timeline/party-timeline-event.schema';
import {
  IntelligenceController,
  IntelligenceRerunController,
} from './intelligence/intelligence.controller';
import { IntelligenceService } from './intelligence/intelligence.service';
import { PartyIntelligenceSettingsController } from './settings/party-intelligence-settings.controller';
import { PartyIntelligenceSettingsService } from './settings/party-intelligence-settings.service';
// Phase 17 Plan 04 — RFM segmenter.
import { RfmSegmenterService } from './rfm/rfm-segmenter.service';
import { RfmCron } from './rfm/rfm.cron';
import { PartyTimelineService } from './timeline/party-timeline.service';
import { PartyTimelineSubscriber } from './timeline/party-timeline.subscriber';
import { PartyTimelineController } from './timeline/party-timeline.controller';
import { PartyTimelineBackfillService } from './timeline/backfill/backfill.service';
import { PartyTimelineBackfillController } from './timeline/backfill/backfill.command';
// Phase 17 Plan 03 — GSTIN risk monitor.
import { GstinMonitorService } from './gstin-monitor/gstin-monitor.service';
import { GstinMonitorCron } from './gstin-monitor/gstin-monitor.cron';
// Phase 17 Plan 05 — per-party P&L.
import { PartyPnlService } from './pnl/party-pnl.service';
import { PartyPnlController } from './pnl/party-pnl.controller';
// Phase 17 Plan 06 — birthday/anniversary greetings.
import { GreetingsService } from './greetings/greetings.service';
import { GreetingsCron } from './greetings/greetings.cron';
import {
  GreetingsDispatchLog,
  GreetingsDispatchLogSchema,
} from './greetings/greetings-dispatch-log.schema';
import { ReminderTemplateModule } from '../reminders/reminder-template/reminder-template.module';
import { AdaptersModule } from '../reminders/adapters/adapters.module';
import { Firm, FirmSchema } from '../firms/firm.schema';
import {
  StockMovement,
  StockMovementSchema,
} from '../inventory/stock-movements/stock-movement.schema';
import { GstinModule } from '../gstin/gstin.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import {
  Workspace,
  WorkspaceSchema,
} from '../../workspaces/schemas/workspace.schema';

import { Party, PartySchema } from '../parties/party.schema';
import {
  SaleInvoice,
  SaleInvoiceSchema,
} from '../sales/sale-invoice/sale-invoice.schema';
import {
  PaymentReceipt,
  PaymentReceiptSchema,
} from '../payments/payment-receipt/payment-receipt.schema';
import {
  PaymentOut,
  PaymentOutSchema,
} from '../purchases/payment-out/payment-out.schema';
import {
  CreditNote,
  CreditNoteSchema,
} from '../credit-notes/credit-note.schema';
import {
  DebitNote,
  DebitNoteSchema,
} from '../debit-notes/debit-note.schema';
import {
  ReminderLog,
  ReminderLogSchema,
} from '../reminders/reminder-log/reminder-log.schema';

/**
 * Phase 17 / FIN-16 — Party Intelligence + CRM module.
 *
 * Wave-0 (this plan) registers the empty shells + the PartyTimelineEvent
 * collection. Wave-1 plans add their providers/controllers/cron handlers
 * to existing files (no creation collisions):
 *   - Plan 02: PartyTimeline subscriber + service + controller + backfill
 *   - Plan 03: GstinMonitor cron + recheck endpoint
 *   - Plan 04: RfmSegmenter cron + intelligence CRUD
 *   - Plan 05: PartyPnl service + report controller
 *   - Plan 06: Greetings cron + settings service
 *
 * EventEmitterModule.forRoot() is registered globally in AppModule (Plan 01
 * Task 1) so all submodule providers can inject EventEmitter2 without
 * re-importing.
 */
@Module({
  imports: [
    GstinModule, // exports SurepassProvider for GstinMonitorService injection
    NotificationsModule, // exports NotificationsService
    // Phase 17 Plan 06 — greetings reuse F-08 channel adapters and the
    // ReminderTemplatesService template resolver.
    ReminderTemplateModule,
    AdaptersModule,
    MongooseModule.forFeature([
      { name: PartyTimelineEvent.name, schema: PartyTimelineEventSchema },
      // Workspace — needed by GstinMonitorCron to enumerate workspaces.
      { name: Workspace.name, schema: WorkspaceSchema },
      // Party — needed by the timeline controller to resolve firmId on POST.
      { name: Party.name, schema: PartySchema },
      // Firm — needed by GreetingsService for firmName variable substitution.
      { name: Firm.name, schema: FirmSchema },
      // Phase 17 Plan 06 — GreetingsDispatchLog dedupe collection.
      { name: GreetingsDispatchLog.name, schema: GreetingsDispatchLogSchema },
      // Source-of-truth schemas for the backfill cursor scans (Plan 02 / D-18).
      // Mongoose dedupes models by name, so registering them here doesn't
      // collide with their owning modules.
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: PaymentReceipt.name, schema: PaymentReceiptSchema },
      { name: PaymentOut.name, schema: PaymentOutSchema },
      { name: CreditNote.name, schema: CreditNoteSchema },
      { name: DebitNote.name, schema: DebitNoteSchema },
      { name: ReminderLog.name, schema: ReminderLogSchema },
      // Phase 17 Plan 05 — StockMovement model needed for COGS aggregation.
      // Mongoose dedupes models by name, so this does not collide with the
      // owning InventoryModule registration.
      { name: StockMovement.name, schema: StockMovementSchema },
    ]),
  ],
  providers: [
    IntelligenceService,
    PartyIntelligenceSettingsService,
    PartyTimelineService,
    PartyTimelineSubscriber,
    PartyTimelineBackfillService,
    // Phase 17 Plan 03 — GSTIN risk monitor.
    GstinMonitorService,
    GstinMonitorCron,
    // Phase 17 Plan 04 — RFM segmenter.
    RfmSegmenterService,
    RfmCron,
    // Phase 17 Plan 05 — per-party P&L.
    PartyPnlService,
    // Phase 17 Plan 06 — birthday/anniversary greetings.
    GreetingsService,
    GreetingsCron,
  ],
  controllers: [
    IntelligenceController,
    IntelligenceRerunController,
    PartyIntelligenceSettingsController,
    PartyTimelineController,
    PartyTimelineBackfillController,
    // Phase 17 Plan 05 — per-party P&L.
    PartyPnlController,
  ],
  exports: [
    IntelligenceService,
    PartyIntelligenceSettingsService,
    PartyTimelineService,
    PartyTimelineBackfillService,
    GstinMonitorService,
    RfmSegmenterService,
    PartyPnlService,
    GreetingsService,
  ],
})
export class PartyIntelligenceModule {}
