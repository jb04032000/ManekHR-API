/**
 * Phase 17 / FIN-16-05 — GreetingsService.
 *
 * Selects birthday/anniversary greeting candidates for one workspace on a
 * given local date, then dispatches them via channel adapters honoring:
 *   - master switch (WorkspaceSettings.partyIntelligence.greetings.enabled, D-29)
 *   - per-channel sub-toggles (greetings.whatsapp / .email / .sms, D-29)
 *   - per-contact suppressGreetings flag (D-32)
 *   - latest party.consentLog entry per channel (D-26)
 *   - calendar-day dedupe via GreetingsDispatchLog unique index (D-31)
 *   - WhatsApp > Email > SMS priority with identifier-availability fallback
 *     (D-27)
 *
 * Pitfall 1 (Mongoose 8.23 autocast): every read filter wraps ObjectIds via
 * `new Types.ObjectId(...)`.
 *
 * Reuses F-08 channel adapters directly. The existing
 * ReminderDispatcherService.dispatchOne is invoice/rule-coupled and is not
 * suitable for greetings — we call the adapter `.send()` interface directly,
 * which is what dispatchOne also does internally.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import pLimit from 'p-limit';
import { withFinanceSpan } from '../../common/finance-observability';
import { ReminderTemplatesService } from '../../reminders/reminder-template/reminder-template.service';
import { EmailAdapter } from '../../reminders/adapters/email.adapter';
import { SmsAdapter } from '../../reminders/adapters/sms.adapter';
import { WhatsAppAdapter } from '../../reminders/adapters/whatsapp.adapter';
import { ChannelDispatchInput, maskEmail, maskPhone } from '../../reminders/adapters/types';

export type GreetingChannel = 'whatsapp' | 'email' | 'sms';
export type GreetingOccasion = 'birthday' | 'anniversary';

export interface GreetingCandidate {
  party: any;
  contact: any;
  occasion: GreetingOccasion;
  channel: GreetingChannel;
}

export interface UpcomingGreeting {
  date: string; // 'YYYY-MM-DD'
  partyId: string;
  partyName: string;
  contactId: string;
  contactName: string;
  occasion: GreetingOccasion;
  channel: GreetingChannel | null;
  suppressed: boolean;
}

const CHANNEL_PRIORITY: GreetingChannel[] = ['whatsapp', 'email', 'sms'];

@Injectable()
export class GreetingsService {
  private readonly logger = new Logger(GreetingsService.name);
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // runForWorkspace is the daily greetings-dispatch cron pass - span only; the
  // per-greeting send already emits a party.timeline event, no PostHog here.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    // String injection tokens (matches Plan 17-04 RfmSegmenterService pattern)
    // — avoids vitest decorator-metadata trip on schemas with class-typed
    // refs (e.g. Workspace.ownerId: User|ObjectId). Build-time DI resolves
    // identically.
    @InjectModel('Party') private readonly partyModel: Model<any>,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('Firm') private readonly firmModel: Model<any>,
    @InjectModel('ReminderLog') private readonly reminderLogModel: Model<any>,
    @InjectModel('GreetingsDispatchLog')
    private readonly logModel: Model<any>,
    private readonly templates: ReminderTemplatesService,
    private readonly emailAdapter: EmailAdapter,
    private readonly smsAdapter: SmsAdapter,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    private readonly events: EventEmitter2,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Select greeting candidates for `wsId` whose birthday/anniversary
   * matches `todayLocal` (in workspace tz). Honors master switch, sub-toggles,
   * per-contact suppressGreetings, party.consentLog, and dedupe.
   */
  async selectGreetingsForToday(wsId: string, todayLocal: Date): Promise<GreetingCandidate[]> {
    const ws: any = await this.workspaceModel.findById(new Types.ObjectId(wsId)).lean();
    if (!ws) return [];

    const settings = ws?.partyIntelligence?.greetings;
    // D-29 — master switch: when undefined or explicitly false → no sends.
    if (!settings || settings.enabled !== true) return [];

    const subToggles = {
      whatsapp: settings.whatsapp !== false,
      email: settings.email !== false,
      sms: settings.sms !== false,
    };

    const tz: string = ws.timezone || 'Asia/Kolkata';
    const todayDate = this.todayDateInTz(todayLocal, tz);
    const monthDay = this.monthDayInTz(todayLocal, tz);

    const parties: any[] = await this.partyModel
      .find({
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: false,
        'contacts.0': { $exists: true },
      })
      .lean();

    const candidates: GreetingCandidate[] = [];
    for (const party of parties) {
      const consentByChannel = this.latestConsentByChannel(party.consentLog);
      const contacts = (party.contacts ?? []) as any[];
      for (const contact of contacts) {
        // D-32 — per-contact suppress.
        if (contact.suppressGreetings === true) continue;

        const occasion = this.matchOccasion(contact, monthDay);
        if (!occasion) continue;

        const channel = this.pickChannel(contact, consentByChannel, subToggles);
        if (!channel) continue;

        // D-31 — dedupe.

        const already = await this.alreadySentToday(
          wsId,
          String(party._id),
          String(contact._id),
          occasion,
          todayDate,
        );
        if (already) continue;

        candidates.push({ party, contact, occasion, channel });
      }
    }
    return candidates;
  }

  /**
   * 30-day forward-looking preview for the settings page (D-32). Returns one
   * row per (date, contact, occasion) regardless of dedupe state. `channel`
   * is the channel that WOULD be picked given current settings + identifiers;
   * `null` if no channel available. `suppressed` = either contact-level
   * suppressGreetings or master/sub-toggle off.
   */
  async upcomingGreetings(wsId: string, days: number = 30): Promise<UpcomingGreeting[]> {
    const ws: any = await this.workspaceModel.findById(new Types.ObjectId(wsId)).lean();
    if (!ws) return [];

    const settings = ws?.partyIntelligence?.greetings;
    const masterOn = settings?.enabled === true;
    const subToggles = {
      whatsapp: masterOn && settings?.whatsapp !== false,
      email: masterOn && settings?.email !== false,
      sms: masterOn && settings?.sms !== false,
    };
    const tz: string = ws.timezone || 'Asia/Kolkata';

    const parties: any[] = await this.partyModel
      .find({
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: false,
        'contacts.0': { $exists: true },
      })
      .lean();

    const out: UpcomingGreeting[] = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() + i * 86_400_000);
      const dateStr = this.todayDateInTz(date, tz);
      const monthDay = this.monthDayInTz(date, tz);
      for (const party of parties) {
        const consentByChannel = this.latestConsentByChannel(party.consentLog);
        for (const contact of (party.contacts ?? []) as any[]) {
          const occasion = this.matchOccasion(contact, monthDay);
          if (!occasion) continue;
          const suppressed = contact.suppressGreetings === true || !masterOn;
          const channel = suppressed
            ? null
            : this.pickChannel(contact, consentByChannel, subToggles);
          out.push({
            date: dateStr,
            partyId: String(party._id),
            partyName: party.name,
            contactId: String(contact._id),
            contactName: contact.name,
            occasion,
            channel,
            suppressed: suppressed || channel == null,
          });
        }
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  /**
   * Iterate every active workspace whose local time is approximately 09:00
   * and dispatch their candidates. Used by GreetingsCron.
   */
  async runForWorkspace(
    wsId: string,
    runId: string = randomUUID(),
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.runGreetingsForWorkspace',
      { workspaceId: wsId, runId },
      () => this.runForWorkspaceImpl(wsId, runId),
    );
  }

  private async runForWorkspaceImpl(
    wsId: string,
    runId: string,
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    const ws: any = await this.workspaceModel.findById(new Types.ObjectId(wsId)).lean();
    if (!ws) return { sent: 0, failed: 0, skipped: 0 };

    const candidates = await this.selectGreetingsForToday(wsId, new Date());
    let sent = 0;
    let failed = 0;
    const limit = pLimit(4);
    await Promise.all(
      candidates.map((c) =>
        limit(async () => {
          try {
            const ok = await this.dispatch(c, ws, runId);
            if (ok) sent++;
            else failed++;
          } catch (err) {
            failed++;
            this.logger.warn(
              `greetings dispatch crashed runId=${runId} party=${c.party._id} ` +
                `contact=${c.contact._id}: ${(err as Error)?.message ?? err}`,
            );
          }
        }),
      ),
    );
    return { sent, failed, skipped: 0 };
  }

  // ── Single-candidate dispatch ─────────────────────────────────────────────

  /**
   * Dispatches one greeting candidate via the F-08 channel adapter. Writes
   * GreetingsDispatchLog (sent or failed), ReminderLog audit row on success,
   * and emits party.timeline { type: 'greeting.sent' }.
   *
   * Returns true on success, false on failure (caller increments counters).
   */
  async dispatch(candidate: GreetingCandidate, ws: any, runId: string): Promise<boolean> {
    const { party, contact, occasion, channel } = candidate;
    const tz: string = ws.timezone || 'Asia/Kolkata';
    const todayDate = this.todayDateInTz(new Date(), tz);

    // Resolve locale: party.preferredLocale > workspace default 'en'.
    const locale = this.resolveLocale(party);
    const kind: 'birthday_greeting' | 'anniversary_greeting' =
      occasion === 'birthday' ? 'birthday_greeting' : 'anniversary_greeting';

    const tpl = await this.templates.getGreetingTemplate(String(party.workspaceId), kind, locale);
    if (!tpl) {
      await this.writeFailedLog(ws, party, contact, occasion, channel, todayDate, 'no_template');
      return false;
    }

    // Resolve firm name for {firmName} variable.
    let firmName = '';
    try {
      const firm: any = await this.firmModel.findById(party.firmId).select('firmName').lean();
      firmName = firm?.firmName ?? '';
    } catch {
      // ignore — firmName falls back to empty string.
    }

    const variables: Record<string, string> = {
      contactName: String(contact.name ?? ''),
      partyName: String(party.name ?? ''),
      firmName,
      occasion,
    };

    const subject = this.applyVars(tpl.subject ?? '', variables);
    const body = this.applyVars(tpl.body ?? '', variables);
    const recipientEmail = contact.email;
    const recipientPhone = contact.phone;

    const input: ChannelDispatchInput = {
      workspaceId: party.workspaceId,
      firmId: party.firmId,
      partyId: party._id,
      // Greetings are not rule-driven — pass a sentinel ruleId for the
      // adapter contract (recipient resolution doesn't need it).
      ruleId: new Types.ObjectId('000000000000000000000000'),
      recipientEmail,
      recipientPhone,
      subject,
      body,
      partyName: variables.partyName,
      workspaceName: ws.name ?? '',
      escalationLevel: 1,
      // Reuse 'service_maintenance' as the closest neutral eventType bucket
      // for the adapter contract — the actual greeting kind lives in the
      // template + GreetingsDispatchLog row.
      eventType: 'service_maintenance' as any,
    };

    try {
      const adapter = this.getAdapter(channel);
      const result = await adapter.send(input);
      if (!result.success) {
        await this.writeFailedLog(
          ws,
          party,
          contact,
          occasion,
          channel,
          todayDate,
          result.errorMessage?.slice(0, 500) ?? 'send_failed',
        );
        return false;
      }

      // 1. Write GreetingsDispatchLog (dedupe truth).
      try {
        await this.logModel.create({
          workspaceId: party.workspaceId,
          partyId: party._id,
          contactId: contact._id,
          occasion,
          todayDate,
          channel,
          status: 'sent',
          meta: {
            runId,
            language: tpl.language,
            recipient: result.recipient,
            messageId: result.messageId,
          },
        });
      } catch (err: any) {
        // Race-condition: another node already inserted the row.
        if (err?.code !== 11000) throw err;
        // Duplicate — silently swallow (D-31 dedupe).
        return true;
      }

      // 2. Write ReminderLog audit row (mirrors F-08 dispatcher pattern).
      try {
        await this.reminderLogModel.create({
          workspaceId: party.workspaceId,
          firmId: party.firmId,
          partyId: party._id,
          ruleId: new Types.ObjectId('000000000000000000000000'),
          channel: channel === 'whatsapp' ? 'whatsapp' : channel,
          triggerDate: todayDate,
          status: 'sent',
          recipient:
            channel === 'email'
              ? maskEmail(String(recipientEmail ?? ''))
              : maskPhone(String(recipientPhone ?? '')),
          messageId: result.messageId,
          escalationLevel: 1,
        });
      } catch (err) {
        this.logger.warn(
          `ReminderLog write failed for greeting (party=${party._id} contact=${contact._id}): ${
            (err as Error)?.message ?? err
          }`,
        );
        // Non-fatal — dedupe row already committed.
      }

      // 3. Emit party.timeline { type: 'greeting.sent' } — non-blocking.
      try {
        this.events.emit('party.timeline', {
          type: 'greeting.sent',
          workspaceId: party.workspaceId,
          firmId: party.firmId,
          partyId: party._id,
          occurredAt: new Date(),
          summary: `${occasion} greeting sent to ${contact.name} via ${channel}`,
          meta: {
            occasion,
            contactId: String(contact._id),
            contactName: contact.name,
            channel,
            locale: tpl.language,
          },
        });
      } catch (err) {
        this.logger.warn(
          `party.timeline emit failed for greeting.sent: ${(err as Error)?.message ?? err}`,
        );
      }

      return true;
    } catch (err: any) {
      // Provider exception (quota, network) — record as failed.
      await this.writeFailedLog(
        ws,
        party,
        contact,
        occasion,
        channel,
        todayDate,
        (err?.message ?? String(err)).slice(0, 500),
      );
      return false;
    }
  }

  // ── Helpers (exported for testability) ────────────────────────────────────

  /**
   * Latest consentLog entry per channel. Returns Map<channel, consented>.
   * Channel name normalized to 'whatsapp' | 'email' | 'sms'.
   */
  latestConsentByChannel(consentLog: any[] | undefined): Map<GreetingChannel, boolean> {
    const out = new Map<GreetingChannel, boolean>();
    if (!Array.isArray(consentLog)) return out;
    const latestByCh = new Map<string, any>();
    for (const e of consentLog) {
      if (!e?.channel) continue;
      const prev = latestByCh.get(e.channel);
      if (!prev || new Date(e.timestamp).getTime() > new Date(prev.timestamp).getTime()) {
        latestByCh.set(e.channel, e);
      }
    }
    for (const [ch, entry] of latestByCh.entries()) {
      if (ch === 'whatsapp' || ch === 'email' || ch === 'sms') {
        out.set(ch as GreetingChannel, entry.consented !== false);
      }
    }
    return out;
  }

  /**
   * Pick first available channel by priority [whatsapp, email, sms] subject
   * to:
   *   - sub-toggle on
   *   - identifier present (phone for whatsapp/sms; email for email)
   *   - latest consentLog entry for the channel is NOT consented:false
   * Returns null if none available.
   */
  pickChannel(
    contact: any,
    consentByChannel: Map<GreetingChannel, boolean>,
    subToggles: { whatsapp: boolean; email: boolean; sms: boolean },
  ): GreetingChannel | null {
    for (const ch of CHANNEL_PRIORITY) {
      if (!subToggles[ch]) continue;
      if (consentByChannel.get(ch) === false) continue;
      if (ch === 'email' && !contact.email) continue;
      if ((ch === 'whatsapp' || ch === 'sms') && !contact.phone) continue;
      return ch;
    }
    return null;
  }

  /**
   * Year-ignored month/day match. Feb-29 anniversaries on a non-leap year
   * match Feb-28 (D-31 spec — handle leap-year edge case).
   */
  matchOccasion(
    contact: any,
    monthDay: { month: number; day: number; isLeapYear: boolean },
  ): GreetingOccasion | null {
    const test = (raw: any): boolean => {
      if (!raw) return false;
      const d = new Date(raw);
      if (isNaN(d.getTime())) return false;
      const cMonth = d.getUTCMonth() + 1;
      const cDay = d.getUTCDate();
      if (cMonth === monthDay.month && cDay === monthDay.day) return true;
      // Feb-29 on non-leap year → match on Feb-28.
      if (
        cMonth === 2 &&
        cDay === 29 &&
        !monthDay.isLeapYear &&
        monthDay.month === 2 &&
        monthDay.day === 28
      ) {
        return true;
      }
      return false;
    };
    if (test(contact.birthday)) return 'birthday';
    if (test(contact.anniversary)) return 'anniversary';
    return null;
  }

  async alreadySentToday(
    wsId: string,
    partyId: string,
    contactId: string,
    occasion: GreetingOccasion,
    todayDate: string,
  ): Promise<boolean> {
    const hit = await this.logModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        partyId: new Types.ObjectId(partyId),
        contactId: new Types.ObjectId(contactId),
        occasion,
        todayDate,
      })
      .lean();
    return !!hit;
  }

  todayDateInTz(now: Date, tz: string): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA → 'YYYY-MM-DD'
    return fmt.format(now);
  }

  monthDayInTz(now: Date, tz: string): { month: number; day: number; isLeapYear: boolean } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(now);
    const year = parseInt(parts.find((p) => p.type === 'year')?.value ?? '0', 10);
    const month = parseInt(parts.find((p) => p.type === 'month')?.value ?? '0', 10);
    const day = parseInt(parts.find((p) => p.type === 'day')?.value ?? '0', 10);
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return { month, day, isLeapYear };
  }

  resolveLocale(party: any): 'en' | 'gu' | 'hi' {
    const p = (party?.preferredLocale ?? '').toLowerCase();
    if (p === 'en' || p === 'gu' || p === 'hi') return p;
    return 'en';
  }

  applyVars(s: string, vars: Record<string, string>): string {
    return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  }

  private getAdapter(channel: GreetingChannel) {
    if (channel === 'email') return this.emailAdapter;
    if (channel === 'sms') return this.smsAdapter;
    return this.whatsAppAdapter;
  }

  private async writeFailedLog(
    ws: any,
    party: any,
    contact: any,
    occasion: GreetingOccasion,
    channel: GreetingChannel,
    todayDate: string,
    error: string,
  ): Promise<void> {
    try {
      await this.logModel.create({
        workspaceId: party.workspaceId,
        partyId: party._id,
        contactId: contact._id,
        occasion,
        todayDate,
        channel,
        status: 'failed',
        error,
      });
    } catch (err: any) {
      // Race / dup — already a row for this dedupe key. Ignore.
      if (err?.code !== 11000) {
        this.logger.warn(
          `failed-log write error party=${party._id} contact=${contact._id}: ${
            err?.message ?? err
          }`,
        );
      }
    }
  }
}
