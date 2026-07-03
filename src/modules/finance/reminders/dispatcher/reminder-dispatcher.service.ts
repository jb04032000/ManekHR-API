/*
 * Polish-deferred — pre-existing Wave 4-8.2 rot in this 1029-line dispatcher.
 * Mongoose .lean() projections + cross-collection $lookup pipelines surface as
 * `any` here; properly typing each call site is a dedicated module-polish task
 * (Phase 5 finance/reminders sweep). Suppressing only the unsafe-* family on
 * THIS file. ESLint coverage on the rest of the module stays intact.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { env } from '../../../../config/env';
import { ReminderRule } from '../reminder-rule/reminder-rule.schema';
import { ReminderLog } from '../reminder-log/reminder-log.schema';
import { ReminderSettings } from '../reminder-settings/reminder-settings.schema';
import { ReminderRulesService } from '../reminder-rule/reminder-rule.service';
import { CallTodoService } from '../call-todo/call-todo.service';
import { InAppAdapter } from '../adapters/in-app.adapter';
import { EmailAdapter } from '../adapters/email.adapter';
import { SmsAdapter } from '../adapters/sms.adapter';
import { PushAdapter } from '../adapters/push.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { ChannelDispatchInput, ReminderChannel } from '../adapters/types';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { Party } from '../../parties/party.schema';
import { Firm } from '../../firms/firm.schema';
import { Machine } from '../../../machines/schemas/machine.schema';
import { Workspace } from '../../../workspaces/schemas/workspace.schema';
import { WorkspaceMember } from '../../../workspaces/schemas/workspace-member.schema';
import { User } from '../../../users/schemas/user.schema';
import { Subscription } from '../../../subscriptions/schemas/subscription.schema';
import { AppModule } from '../../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../../common/enums/feature-access.enum';
import { Msg91BalanceService } from '../../../sms/services/msg91-balance.service';
import { AddOnsService } from '../../../add-ons/add-ons.service';

/**
 * Wave 7 — sub-feature → channel mapping for the REMINDERS module gate.
 * Keys must match `module-features.registry.ts` REMINDERS entries.
 */
const CHANNEL_TO_SUBFEATURE: Record<ReminderChannel, string> = {
  in_app: 'reminder_channel_in_app',
  email: 'reminder_channel_email',
  sms: 'reminder_channel_sms',
  whatsapp: 'reminder_channel_whatsapp',
  push: 'reminder_channel_push',
};

@Injectable()
export class ReminderDispatcherService {
  private readonly logger = new Logger(ReminderDispatcherService.name);

  constructor(
    @InjectModel(ReminderRule.name) private readonly ruleModel: Model<ReminderRule>,
    @InjectModel(ReminderLog.name) private readonly logModel: Model<ReminderLog>,
    @InjectModel(ReminderSettings.name) private readonly settingsModel: Model<ReminderSettings>,
    @InjectModel(SaleInvoice.name) private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    @InjectModel(Machine.name) private readonly machineModel: Model<Machine>,
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name) private readonly memberModel: Model<WorkspaceMember>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Firm.name) private readonly firmModel: Model<Firm>,
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<Subscription>,
    private readonly rulesService: ReminderRulesService,
    private readonly callTodoService: CallTodoService,
    private readonly inAppAdapter: InAppAdapter,
    private readonly emailAdapter: EmailAdapter,
    private readonly smsAdapter: SmsAdapter,
    private readonly pushAdapter: PushAdapter,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    // Phase 17 / FIN-16-03 — party.timeline emit (D-17 non-blocking).
    private readonly events: EventEmitter2,
    // Wave 8.1 — pre-flight MSG91 wallet check + ops alert. Optional so
    // tests / non-paid deployments boot without it.
    @Optional()
    private readonly msg91Balance?: Msg91BalanceService,
    @Optional()
    private readonly addOnsService?: AddOnsService,
  ) {}

  /**
   * Cron entry — iterates all active workspaces and dispatches.
   * Best-effort per-workspace; one failure must not block others.
   */
  async runForAllWorkspaces(): Promise<{
    workspacesProcessed: number;
    remindersSent: number;
    errors: number;
  }> {
    const todayIso = new Date().toISOString().slice(0, 10);
    const workspaces = await this.workspaceModel
      .find({ isActive: true, isDeleted: { $ne: true } })
      .select('_id name')
      .lean();
    let workspacesProcessed = 0;
    let remindersSent = 0;
    let errors = 0;

    for (const ws of workspaces) {
      try {
        const firms = await this.firmModel
          .find({ workspaceId: ws._id, isDeleted: { $ne: true } })
          .select('_id firmName')
          .lean();
        for (const firm of firms) {
          const result = await this.runForFirm(String(ws._id), String(firm._id), todayIso, {
            workspaceName: (ws as any).name ?? '',
            firmName: (firm as any).firmName ?? '',
          });
          remindersSent += result.sent;
          errors += result.errors;
        }
        workspacesProcessed++;
      } catch (err: unknown) {
        this.logger.error(
          `Workspace ${ws._id} dispatch failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        errors++;
      }
    }

    this.logger.log(
      `Reminder dispatcher complete: workspaces=${workspacesProcessed} sent=${remindersSent} errors=${errors}`,
    );
    return { workspacesProcessed, remindersSent, errors };
  }

  async runForFirm(
    workspaceId: string,
    firmId: string,
    todayIso: string,
    ctx: { workspaceName: string; firmName: string },
    filter?: { partyId?: string; ruleId?: string },
  ): Promise<{ sent: number; errors: number }> {
    const settings = await this.settingsModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      })
      .lean();
    if (!settings || !(settings as any).enabled) return { sent: 0, errors: 0 };

    // Wave 7 — resolve channel sub-feature locks for the workspace owner's
    // active subscription. Pre-empts adapter dispatch for tier-locked
    // channels so credits aren't burned + provider isn't billed for sends
    // the customer's plan doesn't include.
    const lockedChannels = await this.resolveLockedChannels(workspaceId);

    // Wave 8.1 — pre-flight MSG91 wallet runway check. If our wallet can't
    // cover a 1-segment SMS / 1 WhatsApp conversation, mark the channel
    // provider-empty for THIS firm-run. Customer credits stay intact;
    // dispatcher logs `skipped_provider_empty`; ops alert fires (throttled).
    const providerEmptyChannels = await this.resolveProviderEmptyChannels();
    if (providerEmptyChannels.size > 0) {
      // Fire the ops alert once per firm-run — internal 7d throttle prevents
      // pager spam if multiple firms hit it within the same hour.
      this.fireProviderEmptyOpsAlert().catch((err) =>
        this.logger.warn(
          `provider-empty ops alert dispatch failed: ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }

    let sent = 0;
    let errors = 0;
    const maxPerDay = (settings as any).maxRemindersPerDay ?? 10000;

    try {
      sent += await this.dispatchOverdueInvoices(
        workspaceId,
        firmId,
        todayIso,
        settings,
        ctx,
        lockedChannels,
        providerEmptyChannels,
        filter,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Firm ${String(firmId)} overdue-invoices dispatch error: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      errors++;
    }

    if (sent >= maxPerDay) {
      this.logger.warn(
        `maxRemindersPerDay (${maxPerDay}) reached for firm ${String(firmId)} after overdue invoices — stopping`,
      );
      return { sent, errors };
    }

    try {
      sent += await this.dispatchDueSoonInvoices(
        workspaceId,
        firmId,
        todayIso,
        settings,
        ctx,
        lockedChannels,
        providerEmptyChannels,
        filter,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Firm ${String(firmId)} due-soon-invoices dispatch error: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      errors++;
    }

    if (sent >= maxPerDay) {
      this.logger.warn(
        `maxRemindersPerDay (${maxPerDay}) reached for firm ${String(firmId)} after due-soon invoices — stopping`,
      );
      return { sent, errors };
    }

    try {
      sent += await this.dispatchMachineMaintenance(
        workspaceId,
        firmId,
        todayIso,
        settings,
        ctx,
        lockedChannels,
        providerEmptyChannels,
        filter,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Firm ${String(firmId)} machine-maintenance dispatch error: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      errors++;
    }

    return { sent, errors };
  }

  /**
   * Wave 7 — compute the Set of locked reminder channels for a workspace
   * by reading the workspace owner's active subscription `appliedEntitlements
   * .moduleAccess[REMINDERS].subFeatures`. Channels with access==='locked'
   * are pre-empted at dispatch time (no credit burn, no provider call).
   *
   * Best-effort: any lookup failure → empty Set (fail-open). The credit
   * gate at `tryConsumeXxxCredit` remains the last line of defence.
   */
  private async resolveLockedChannels(workspaceId: string): Promise<Set<ReminderChannel>> {
    const locked = new Set<ReminderChannel>();
    try {
      const ownerId = await this.findFirmOwner(workspaceId);
      if (!ownerId) return locked;
      const sub = await this.subscriptionModel
        .findOne({
          userId: new Types.ObjectId(ownerId),
          status: { $in: ['active', 'trial'] },
        })
        .select('appliedEntitlements')
        .lean();
      const moduleAccess: any[] = (sub as any)?.appliedEntitlements?.moduleAccess ?? [];
      const reminders = moduleAccess.find((m) => m?.module === AppModule.REMINDERS);
      if (!reminders) return locked;
      const subFeatures: any[] = reminders.subFeatures ?? [];
      for (const ch of Object.keys(CHANNEL_TO_SUBFEATURE) as ReminderChannel[]) {
        const key = CHANNEL_TO_SUBFEATURE[ch];
        const sf = subFeatures.find((s) => s?.key === key);
        if (sf && sf.access === FeatureAccessLevel.LOCKED) {
          locked.add(ch);
        }
      }
    } catch (err: unknown) {
      this.logger.warn(
        `resolveLockedChannels: ws=${workspaceId} fallback to empty (open) — ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    return locked;
  }

  /**
   * Wave 8.1 — pre-flight MSG91/AiSensy wallet runway check at firm scope.
   * SMS pre-flight: estimate 1 GSM-7 segment cost. WhatsApp pre-flight:
   * estimate 1 conversation. Returns the set of paid channels currently
   * UNDERWATER. Empty set when balance service unavailable (fail-open).
   */
  private async resolveProviderEmptyChannels(): Promise<Set<ReminderChannel>> {
    const empty = new Set<ReminderChannel>();
    if (!this.msg91Balance) return empty;
    try {
      const smsCostPaise = env.msg91.costGsm7SegPaise;
      const waCostPaise = env.aisensy.costPerConversationPaise;
      const [smsOk, waOk] = await Promise.all([
        this.msg91Balance.hasRunwayFor(smsCostPaise),
        this.msg91Balance.hasRunwayFor(waCostPaise),
      ]);
      if (!smsOk) empty.add('sms');
      if (!waOk) empty.add('whatsapp');
    } catch (err: unknown) {
      this.logger.warn(
        `resolveProviderEmptyChannels: ${err instanceof Error ? err.message : 'unknown'} — fail-open`,
      );
    }
    return empty;
  }

  /** Wave 8.1 — fire the throttled ops alert. Best-effort, non-blocking. */
  private async fireProviderEmptyOpsAlert(): Promise<void> {
    if (!this.addOnsService || !this.msg91Balance) return;
    const status = await this.msg91Balance.getStatus().catch(() => null);
    if (!status) return;
    const balance = status.balancePaise < 0 ? 0 : status.balancePaise;
    await this.addOnsService.dispatchOpsLowMsg91Alert({
      context: 'send_skipped',
      balancePaise: balance,
      requiredPaise: env.msg91.costGsm7SegPaise,
      runwayDays: status.avgDailyBurnPaise > 0 ? Math.floor(balance / status.avgDailyBurnPaise) : 0,
      note: 'Reminder dispatcher detected provider-empty wallet at run start',
    });
  }

  // ─── Candidate set 1: overdue invoices ────────────────────────────────────

  private async dispatchOverdueInvoices(
    workspaceId: string,
    firmId: string,
    todayIso: string,
    settings: any,
    ctx: { workspaceName: string; firmName: string },
    lockedChannels: Set<ReminderChannel>,
    providerEmptyChannels: Set<ReminderChannel>,
    filter?: { partyId?: string; ruleId?: string },
  ): Promise<number> {
    const query: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      paymentStatus: 'overdue',
      isDeleted: false,
      state: 'posted',
    };
    if (filter?.partyId) query.partyId = new Types.ObjectId(filter.partyId);

    const invoices = await this.invoiceModel
      .find(query)
      .select('_id partyId voucherNumber grandTotalPaise amountDuePaise dueDate')
      .lean();

    let sent = 0;
    for (const invoice of invoices) {
      try {
        const party = await this.partyModel.findById(invoice.partyId).lean();
        if (!party) continue;

        // Skip invoices below the minimum outstanding threshold
        const minPaise = settings.minimumOutstandingPaise ?? 0;
        if (
          minPaise > 0 &&
          ((invoice as any).amountDuePaise ?? (invoice as any).grandTotalPaise ?? 0) < minPaise
        ) {
          continue; // noise-suppression gate
        }

        const partyId = String(invoice.partyId);
        const rules = await this.rulesService.findApplicableRules({
          workspaceId,
          firmId,
          partyId,
          triggerType: 'invoice_overdue',
        });

        const daysPastDue = invoice.dueDate
          ? Math.floor((Date.now() - new Date(invoice.dueDate).getTime()) / 86_400_000)
          : 0;

        for (const rule of rules) {
          if (filter?.ruleId && String(rule._id) !== filter.ruleId) continue;
          const channels = this.resolveChannels(rule);
          const optedOut = this.computeOptedOutChannels(party);
          for (const channel of channels) {
            if (optedOut.has(channel)) continue;
            // Wave 7 — channel locked on the customer's tier; skip + log so
            // credits aren't burned and the provider isn't called.
            if (lockedChannels.has(channel)) {
              await this.logChannelLockedSkip({
                workspaceId,
                firmId,
                partyId,
                ruleId: String(rule._id),
                invoiceId: String(invoice._id),
                channel,
                todayIso,
                escalationLevel: (rule as any).escalationLevel ?? 1,
              });
              continue;
            }
            // Wave 8.1 — MSG91/AiSensy wallet empty for this channel.
            // Customer credit NOT debited; tomorrow's cron retries.
            if (providerEmptyChannels.has(channel)) {
              await this.logProviderEmptySkip({
                workspaceId,
                firmId,
                partyId,
                ruleId: String(rule._id),
                invoiceId: String(invoice._id),
                channel,
                todayIso,
                escalationLevel: (rule as any).escalationLevel ?? 1,
              });
              continue;
            }
            try {
              const dispatched = await this.dispatchOne({
                workspaceId,
                firmId,
                partyId,
                ruleId: String(rule._id),
                invoiceId: String(invoice._id),
                channel,
                todayIso,
                settings,
                party,
                rule,
                ctx,
                invoiceNumber: (invoice as any).voucherNumber,
                grandTotalPaise: (invoice as any).grandTotalPaise,
                daysPastDue,
                dueDate: invoice.dueDate
                  ? new Date(invoice.dueDate).toISOString().slice(0, 10)
                  : undefined,
                eventType: 'invoice_overdue',
              });
              if (dispatched) sent++;
            } catch (err: unknown) {
              this.logger.error(
                `dispatchOne error invoice=${invoice._id} channel=${channel}: ${err instanceof Error ? err.message : 'unknown'}`,
              );
            }
          }

          // Escalation level 3: auto-create CallTodo if 21+ days overdue and no pending todo
          if ((rule as any).escalationLevel === 3 && daysPastDue >= 21) {
            try {
              const existing = await this.callTodoService.findPendingForParty(
                workspaceId,
                firmId,
                partyId,
              );
              if (!existing) {
                const owner = await this.findFirmOwner(workspaceId);
                await this.callTodoService.create(workspaceId, firmId, {
                  title: `FINAL NOTICE: ${(party as any).name} — ${daysPastDue} days overdue`,
                  partyId,
                  invoiceId: String(invoice._id),
                  totalOverdueAmountPaise: (invoice as any).amountDuePaise ?? 0,
                  callType: 'payment_followup',
                  priority: 'urgent',
                  assignedTo:
                    owner ??
                    String(
                      // eslint-disable-next-line @typescript-eslint/no-base-to-string
                      (await this.workspaceModel.findById(workspaceId).select('ownerId').lean())
                        ?.ownerId ?? '',
                    ),
                  autoCreated: true,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
              }
            } catch (err: unknown) {
              this.logger.error(
                `Auto-CallTodo creation failed for party=${partyId}: ${err instanceof Error ? err.message : 'unknown'}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        this.logger.error(
          `Invoice ${invoice._id} dispatch error: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return sent;
  }

  // ─── Candidate set 2: due-soon invoices ───────────────────────────────────

  private async dispatchDueSoonInvoices(
    workspaceId: string,
    firmId: string,
    todayIso: string,
    settings: any,
    ctx: { workspaceName: string; firmName: string },
    lockedChannels: Set<ReminderChannel>,
    providerEmptyChannels: Set<ReminderChannel>,
    filter?: { partyId?: string; ruleId?: string },
  ): Promise<number> {
    const today = new Date(todayIso);
    const futureCutoff = new Date(today.getTime() + 7 * 86_400_000); // 7-day lookahead

    const query: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      paymentStatus: { $in: ['unpaid', 'partial'] },
      dueDate: { $gte: today, $lte: futureCutoff },
      isDeleted: false,
      state: 'posted',
    };
    if (filter?.partyId) query.partyId = new Types.ObjectId(filter.partyId);

    const invoices = await this.invoiceModel
      .find(query)
      .select('_id partyId voucherNumber grandTotalPaise amountDuePaise dueDate')
      .lean();

    let sent = 0;
    for (const invoice of invoices) {
      try {
        const party = await this.partyModel.findById(invoice.partyId).lean();
        if (!party) continue;

        // Skip invoices below the minimum outstanding threshold
        const minPaise = settings.minimumOutstandingPaise ?? 0;
        if (
          minPaise > 0 &&
          ((invoice as any).amountDuePaise ?? (invoice as any).grandTotalPaise ?? 0) < minPaise
        ) {
          continue; // noise-suppression gate
        }

        const partyId = String(invoice.partyId);
        const rules = await this.rulesService.findApplicableRules({
          workspaceId,
          firmId,
          partyId,
          triggerType: 'invoice_due_soon',
        });

        const daysUntilDue = invoice.dueDate
          ? Math.ceil((new Date(invoice.dueDate).getTime() - Date.now()) / 86_400_000)
          : 0;

        for (const rule of rules) {
          if (filter?.ruleId && String(rule._id) !== filter.ruleId) continue;
          const channels = this.resolveChannels(rule);
          const optedOut = this.computeOptedOutChannels(party);
          for (const channel of channels) {
            if (optedOut.has(channel)) continue;
            if (lockedChannels.has(channel)) {
              await this.logChannelLockedSkip({
                workspaceId,
                firmId,
                partyId,
                ruleId: String(rule._id),
                invoiceId: String(invoice._id),
                channel,
                todayIso,
                escalationLevel: (rule as any).escalationLevel ?? 1,
              });
              continue;
            }
            if (providerEmptyChannels.has(channel)) {
              await this.logProviderEmptySkip({
                workspaceId,
                firmId,
                partyId,
                ruleId: String(rule._id),
                invoiceId: String(invoice._id),
                channel,
                todayIso,
                escalationLevel: (rule as any).escalationLevel ?? 1,
              });
              continue;
            }
            try {
              const dispatched = await this.dispatchOne({
                workspaceId,
                firmId,
                partyId,
                ruleId: String(rule._id),
                invoiceId: String(invoice._id),
                channel,
                todayIso,
                settings,
                party,
                rule,
                ctx,
                invoiceNumber: (invoice as any).voucherNumber,
                grandTotalPaise: (invoice as any).grandTotalPaise,
                daysPastDue: -daysUntilDue,
                dueDate: invoice.dueDate
                  ? new Date(invoice.dueDate).toISOString().slice(0, 10)
                  : undefined,
                eventType: 'invoice_due_soon',
              });
              if (dispatched) sent++;
            } catch (err: unknown) {
              this.logger.error(
                `dispatchOne error invoice=${invoice._id} channel=${channel}: ${err instanceof Error ? err.message : 'unknown'}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        this.logger.error(
          `DueSoon invoice ${invoice._id} dispatch error: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return sent;
  }

  // ─── Candidate set 3: machine maintenance ─────────────────────────────────

  private async dispatchMachineMaintenance(
    workspaceId: string,
    firmId: string,
    todayIso: string,
    settings: any,
    ctx: { workspaceName: string; firmName: string },
    lockedChannels: Set<ReminderChannel>,
    providerEmptyChannels: Set<ReminderChannel>,
    filter?: { partyId?: string; ruleId?: string },
  ): Promise<number> {
    const today = new Date(todayIso);
    const lookahead = new Date(today.getTime() + 3 * 86_400_000);

    const machines = await this.machineModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        isActive: true,
        isDeleted: false,
        maintenanceIntervalDays: { $ne: null },
      })
      .lean();

    let sent = 0;

    // Find owner/admin to send the maintenance reminder to
    const adminUserId = await this.findFirmOwner(workspaceId);
    if (!adminUserId) return 0;

    const adminUser = await this.userModel.findById(adminUserId).lean();
    if (!adminUser) return 0;

    for (const machine of machines) {
      try {
        const baseDate = (machine as any).lastMaintenanceDate ?? (machine as any).installedOn;
        if (!baseDate) continue;
        const intervalDays = (machine as any).maintenanceIntervalDays as number;
        const nextDue = new Date(new Date(baseDate).getTime() + intervalDays * 86_400_000);

        if (nextDue > lookahead) continue; // not due within 3 days

        // For machine maintenance, partyId is not relevant; use workspaceId-based rule lookup
        // Using a synthetic partyId = '000000000000000000000000' (null) to match global rules
        const rules = await this.rulesService.findApplicableRules({
          workspaceId,
          firmId,
          partyId: adminUserId, // not party-based; we match global rules only
          triggerType: 'service_maintenance',
        });

        if (rules.length === 0) {
          // No configured rules — send default in-app + email to admin
          await this.sendMachineMaintenanceDefault(
            workspaceId,
            firmId,
            machine,
            adminUserId,
            adminUser,
            todayIso,
            ctx,
            lockedChannels,
          );
          sent++;
          continue;
        }

        for (const rule of rules) {
          if (filter?.ruleId && String(rule._id) !== filter.ruleId) continue;

          const channelsTried: ReminderChannel[] = ['in_app', 'email'];
          for (const channel of channelsTried) {
            if (lockedChannels.has(channel)) {
              await this.logChannelLockedSkip({
                workspaceId,
                firmId,
                partyId: adminUserId,
                ruleId: String(rule._id),
                machineId: String(machine._id),
                channel,
                todayIso,
                escalationLevel: (rule as any).escalationLevel ?? 1,
              });
              continue;
            }
            if (providerEmptyChannels.has(channel)) {
              await this.logProviderEmptySkip({
                workspaceId,
                firmId,
                partyId: adminUserId,
                ruleId: String(rule._id),
                machineId: String(machine._id),
                channel,
                todayIso,
                escalationLevel: (rule as any).escalationLevel ?? 1,
              });
              continue;
            }
            try {
              const input: ChannelDispatchInput = {
                workspaceId,
                firmId,
                partyId: adminUserId,
                ruleId: String(rule._id),
                machineId: String(machine._id),
                recipientUserId: adminUserId,
                recipientEmail: (adminUser as any).email,
                recipientFcmToken: (adminUser as any).fcmToken,
                subject: `Maintenance reminder: ${(machine as any).name}`,
                body: `Machine "${(machine as any).name}" is due for maintenance.`,
                partyName: ctx.workspaceName,
                workspaceName: ctx.workspaceName,
                escalationLevel: ((rule as any).escalationLevel as 1 | 2 | 3) ?? 1,
                eventType: 'service_maintenance',
              };

              const logDoc = await this.logModel
                .create({
                  workspaceId: new Types.ObjectId(workspaceId),
                  firmId: new Types.ObjectId(firmId),
                  partyId: new Types.ObjectId(adminUserId),
                  ruleId: new Types.ObjectId(String(rule._id)),
                  machineId: new Types.ObjectId(String(machine._id)),
                  channel,
                  triggerDate: todayIso,
                  status: 'sent',
                  escalationLevel: (rule as any).escalationLevel ?? 1,
                })
                .catch((err: any) => {
                  if (err?.code === 11000) return null;
                  throw err;
                });
              if (!logDoc) continue; // already sent today

              const adapter = this.getAdapter(channel);
              const result = await adapter.send(input);
              if (!result.success) {
                await this.logModel.findByIdAndUpdate(logDoc._id, {
                  $set: { status: 'failed', errorMessage: result.errorMessage?.slice(0, 500) },
                });
              } else {
                sent++;
              }
            } catch (err: unknown) {
              this.logger.error(
                `Machine ${machine._id} channel=${channel} error: ${err instanceof Error ? err.message : 'unknown'}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        this.logger.error(
          `Machine ${machine._id} maintenance dispatch error: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return sent;
  }

  private async sendMachineMaintenanceDefault(
    workspaceId: string,
    firmId: string,
    machine: any,
    adminUserId: string,
    adminUser: any,
    todayIso: string,
    ctx: { workspaceName: string; firmName: string },
    lockedChannels: Set<ReminderChannel>,
  ): Promise<void> {
    for (const channel of ['in_app', 'email'] as ReminderChannel[]) {
      if (lockedChannels.has(channel)) continue;
      try {
        const input: ChannelDispatchInput = {
          workspaceId,
          firmId,
          partyId: adminUserId,
          ruleId: '000000000000000000000000',
          machineId: String(machine._id),
          recipientUserId: adminUserId,
          recipientEmail: adminUser.email,
          subject: `Maintenance due: ${machine.name}`,
          body: `Machine "${machine.name}" scheduled maintenance is due within 3 days.`,
          partyName: ctx.workspaceName,
          workspaceName: ctx.workspaceName,
          escalationLevel: 1,
          eventType: 'service_maintenance',
        };
        const adapter = this.getAdapter(channel);
        await adapter.send(input);
      } catch (err: unknown) {
        this.logger.error(
          `Default machine maintenance channel=${channel} error: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
  }

  // ─── Core dispatch with idempotency, cooldown, opt-out ────────────────────

  private async dispatchOne(params: {
    workspaceId: string;
    firmId: string;
    partyId: string;
    ruleId: string;
    invoiceId?: string;
    machineId?: string;
    channel: ReminderChannel;
    todayIso: string;
    settings: any;
    party: any;
    rule: any;
    ctx: { workspaceName: string; firmName: string };
    invoiceNumber?: string;
    grandTotalPaise?: number;
    daysPastDue?: number;
    dueDate?: string;
    eventType: ChannelDispatchInput['eventType'];
  }): Promise<boolean> {
    const {
      workspaceId,
      firmId,
      partyId,
      ruleId,
      invoiceId,
      machineId,
      channel,
      todayIso,
      settings,
      party,
      rule,
      ctx,
      invoiceNumber,
      grandTotalPaise,
      daysPastDue,
      dueDate,
      eventType,
    } = params;

    // Cooldown check
    const cooldownCutoff = new Date(Date.now() - (rule.cooldownHours ?? 24) * 3_600_000);
    const cooldownHit = await this.logModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        partyId: new Types.ObjectId(partyId),
        ruleId: new Types.ObjectId(ruleId),
        channel,
        status: 'sent',
        createdAt: { $gte: cooldownCutoff },
      })
      .lean();
    if (cooldownHit) return false;

    // Idempotency: optimistic insert with UNIQUE index
    const logDoc = await this.logModel
      .create({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        partyId: new Types.ObjectId(partyId),
        ruleId: new Types.ObjectId(ruleId),
        invoiceId: invoiceId ? new Types.ObjectId(invoiceId) : undefined,
        machineId: machineId ? new Types.ObjectId(machineId) : undefined,
        channel,
        triggerDate: todayIso,
        status: 'sent',
        escalationLevel: rule.escalationLevel ?? 1,
      })
      .catch((err: any) => {
        if (err?.code === 11000) return null; // already sent today
        throw err;
      });
    if (!logDoc) return false;

    // Resolve recipient contact info from party
    // NOTE: recipientEmail and recipientPhone come from the Party (customer/supplier).
    // But recipientUserId and recipientFcmToken must come from the workspace OWNER User —
    // Party is a finance entity (not a User), so party._id is NOT a valid User ID.
    const ownerUserId = await this.findFirmOwner(workspaceId);
    const ownerUser = ownerUserId
      ? await this.userModel.findById(ownerUserId).select('email fcmToken').lean()
      : null;
    const recipientUserId = ownerUserId ?? String(party._id);
    const recipientEmail = party.email;
    const recipientPhone = party.phone;
    const recipientFcmToken = (ownerUser as any)?.fcmToken;

    const amountFormatted =
      grandTotalPaise != null ? `₹${(grandTotalPaise / 100).toLocaleString('en-IN')}` : undefined;

    const input: ChannelDispatchInput = {
      workspaceId,
      firmId,
      partyId,
      ruleId,
      invoiceId,
      recipientUserId,
      recipientEmail,
      recipientPhone,
      recipientFcmToken,
      subject: invoiceNumber
        ? `Reminder: Invoice ${invoiceNumber}`
        : `Reminder from ${ctx.workspaceName}`,
      body: `Dear ${party.name}, this is a payment reminder for Invoice ${invoiceNumber ?? ''}. Amount due: ${amountFormatted ?? ''}`,
      templateKey:
        channel === 'sms'
          ? rule.smsTemplateKey
          : channel === 'whatsapp'
            ? rule.whatsAppCampaignName
            : undefined,
      partyName: party.name,
      invoiceNumber,
      invoiceAmountFormatted: amountFormatted,
      daysPastDue,
      dueDate,
      workspaceName: ctx.workspaceName,
      escalationLevel: (rule.escalationLevel as 1 | 2 | 3) ?? 1,
      eventType,
    };

    const adapter = this.getAdapter(channel);
    const result = await adapter.send(input);

    if (!result.success) {
      await this.logModel.findByIdAndUpdate(logDoc._id, {
        $set: {
          status: 'failed',
          errorMessage: result.errorMessage?.slice(0, 500),
          recipient: result.recipient,
        },
      });

      // Stale FCM token cleanup — uses ownerUserId (User._id), not party._id (Party is not a User)
      if (
        channel === 'push' &&
        result.errorMessage?.includes('registration-token-not-registered') &&
        ownerUserId
      ) {
        await this.userModel.findByIdAndUpdate(ownerUserId, {
          $unset: { fcmToken: 1, fcmTokenUpdatedAt: 1 },
        });
      }
      return false;
    }

    await this.logModel.findByIdAndUpdate(logDoc._id, {
      $set: { recipient: result.recipient, messageId: result.messageId },
    });

    // Phase 17 / FIN-16-03 — reminder.sent party.timeline event AFTER ReminderLog
    // write succeeds (log + timeline paired). System event — no actorUserId.
    // Wrapped in try/catch — D-17 non-blocking guarantee.
    try {
      this.events.emit('party.timeline', {
        type: 'reminder.sent',
        workspaceId,
        firmId,
        partyId,
        refModel: 'ReminderLog',
        refId: logDoc._id,
        occurredAt: new Date(),
        summary: `${rule.templateKind ?? eventType ?? 'reminder'} reminder via ${channel}`,
        meta: {
          templateKind: rule.templateKind ?? eventType,
          channel,
          recipient: result.recipient,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `party.timeline emit failed for reminder.sent (logId=${String(logDoc._id)}): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    return true;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Wave 8.1 — write a `status=skipped_provider_empty` ReminderLog entry
   * when MSG91 wallet pre-flight fails. Customer credit NOT debited.
   * Idempotent retry next day via the existing UNIQUE-by-day index.
   */
  private async logProviderEmptySkip(params: {
    workspaceId: string;
    firmId: string;
    partyId: string;
    ruleId: string;
    invoiceId?: string;
    machineId?: string;
    channel: ReminderChannel;
    todayIso: string;
    escalationLevel: 1 | 2 | 3 | number;
  }): Promise<void> {
    try {
      await this.logModel
        .create({
          workspaceId: new Types.ObjectId(params.workspaceId),
          firmId: new Types.ObjectId(params.firmId),
          partyId: new Types.ObjectId(params.partyId),
          ruleId: new Types.ObjectId(params.ruleId),
          invoiceId: params.invoiceId ? new Types.ObjectId(params.invoiceId) : undefined,
          machineId: params.machineId ? new Types.ObjectId(params.machineId) : undefined,
          channel: params.channel,
          triggerDate: params.todayIso,
          status: 'skipped_provider_empty',
          escalationLevel: params.escalationLevel,
          errorMessage: `Provider wallet low — message queued for retry. Ops alerted.`,
        })
        .catch((err: any) => {
          if (err?.code === 11000) return null; // already logged today
          throw err;
        });
    } catch (err: unknown) {
      this.logger.warn(
        `logProviderEmptySkip failed channel=${params.channel} party=${params.partyId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /**
   * Wave 7 — write a `status=skipped` ReminderLog entry when a channel is
   * locked by tier. Honours the same composite UNIQUE key as `dispatchOne`'s
   * idempotency log; duplicate-key (11000) errors are swallowed because a
   * prior dispatchOne call already recorded the day's attempt.
   */
  private async logChannelLockedSkip(params: {
    workspaceId: string;
    firmId: string;
    partyId: string;
    ruleId: string;
    invoiceId?: string;
    machineId?: string;
    channel: ReminderChannel;
    todayIso: string;
    escalationLevel: 1 | 2 | 3 | number;
  }): Promise<void> {
    try {
      await this.logModel
        .create({
          workspaceId: new Types.ObjectId(params.workspaceId),
          firmId: new Types.ObjectId(params.firmId),
          partyId: new Types.ObjectId(params.partyId),
          ruleId: new Types.ObjectId(params.ruleId),
          invoiceId: params.invoiceId ? new Types.ObjectId(params.invoiceId) : undefined,
          machineId: params.machineId ? new Types.ObjectId(params.machineId) : undefined,
          channel: params.channel,
          triggerDate: params.todayIso,
          status: 'skipped_channel_locked',
          escalationLevel: params.escalationLevel,
          errorMessage: `Channel locked on tier — upgrade plan to enable ${params.channel} reminders.`,
        })
        .catch((err: any) => {
          if (err?.code === 11000) return null; // already logged today
          throw err;
        });
    } catch (err: unknown) {
      this.logger.warn(
        `logChannelLockedSkip failed channel=${params.channel} party=${params.partyId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private resolveChannels(rule: any): ReminderChannel[] {
    const channels: ReminderChannel[] = [];
    if (rule.channelInApp) channels.push('in_app');
    if (rule.channelEmail) channels.push('email');
    if (rule.channelSms) channels.push('sms');
    if (rule.channelPush) channels.push('push');
    if (rule.channelWhatsApp) channels.push('whatsapp');
    return channels;
  }

  /**
   * Returns a Set of channels where Party has explicitly opted out (consented=false).
   * Reads Party.consentLog and takes the most recent entry per channel.
   */
  private computeOptedOutChannels(party: any): Set<ReminderChannel> {
    const consentLog: any[] = party.consentLog ?? [];
    const latestByChannel = new Map<string, any>();
    for (const entry of consentLog) {
      const existing = latestByChannel.get(entry.channel);
      if (!existing || new Date(entry.timestamp) > new Date(existing.timestamp)) {
        latestByChannel.set(entry.channel, entry);
      }
    }
    const optedOut = new Set<ReminderChannel>();
    for (const [ch, entry] of latestByChannel.entries()) {
      if (entry.consented === false) {
        optedOut.add(ch as ReminderChannel);
      }
    }
    return optedOut;
  }

  private getAdapter(channel: ReminderChannel) {
    switch (channel) {
      case 'in_app':
        return this.inAppAdapter;
      case 'email':
        return this.emailAdapter;
      case 'sms':
        return this.smsAdapter;
      case 'push':
        return this.pushAdapter;
      case 'whatsapp':
        return this.whatsAppAdapter;
    }
  }

  /**
   * Find the first workspace owner or admin member's userId.
   */
  private async findFirmOwner(workspaceId: string): Promise<string | null> {
    const workspace = await this.workspaceModel.findById(workspaceId).select('ownerId').lean();
    if (workspace?.ownerId) return String((workspace as any).ownerId);
    const member = await this.memberModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId), status: 'active' })
      .lean();
    if (member?.userId) return String((member as any).userId);
    return null;
  }
}
