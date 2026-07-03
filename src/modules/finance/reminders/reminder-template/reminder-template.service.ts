import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ReminderTemplate } from './reminder-template.schema';
import { UpsertReminderTemplateDto } from './reminder-template.dto';
import { GREETING_TEMPLATE_DEFAULTS } from '../../party-intelligence/greetings/greeting-templates.seed';

@Injectable()
export class ReminderTemplatesService {
  private readonly logger = new Logger(ReminderTemplatesService.name);

  constructor(
    @InjectModel(ReminderTemplate.name) private readonly model: Model<ReminderTemplate>,
  ) {}

  /**
   * Phase 17 / FIN-16-05 D-28 — idempotent seed of global default
   * birthday/anniversary greeting templates. Upsert keyed on
   * (eventType, language, workspaceId: null, isDefault: true) so the seed
   * runs once per kind+locale and is safe to re-run.
   *
   * Run by the ledgered migration runner (ADR-0001 Slice 2), unit
   * `0011_finance_seed_greeting_templates` — was an onModuleInit hook that ran on
   * EVERY boot. Do NOT re-add a boot hook on merge. `$setOnInsert` only inserts,
   * so it is registered `convergent` (a bumped checksum re-applies to add any new
   * default templates without touching existing rows).
   */
  async runSeed(): Promise<{ inserted: number }> {
    // Body unchanged from the former onModuleInit, minus the swallow-on-boot
    // try/catch: errors now propagate to the runner so a failed seed fails the
    // migrate run (ADR-0001 fail-closed) instead of being silently logged.
    const ops = GREETING_TEMPLATE_DEFAULTS.map((t) => ({
      updateOne: {
        filter: {
          eventType: t.eventType,
          language: t.language,
          workspaceId: null,
          isDefault: true,
        },
        update: {
          $setOnInsert: {
            eventType: t.eventType,
            language: t.language,
            workspaceId: null,
            isDefault: true,
            isActive: true,
            variables: t.variables,
            subject: t.subject,
            body: t.body,
          },
        },
        upsert: true,
      },
    }));
    const result = await this.model.bulkWrite(ops, { ordered: false });
    const inserted = (result as any).upsertedCount ?? 0;
    if (inserted > 0) {
      this.logger.log(`Seeded ${inserted} default greeting template(s) (FIN-16-05 D-28)`);
    }
    return { inserted };
  }

  /**
   * Returns workspace-default templates + firm-specific templates.
   * Firm-specific templates take precedence over workspace defaults when consumed by dispatcher.
   */
  async list(workspaceId: string, firmId: string): Promise<ReminderTemplate[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [
          { firmId: new Types.ObjectId(firmId) },
          { firmId: null },
          { firmId: { $exists: false } },
        ],
        isActive: true,
      })
      .sort({ firmId: -1 })
      .exec();
  }

  /**
   * Upsert keyed on (workspaceId, firmId, channel, eventType, language).
   */
  async upsert(
    workspaceId: string,
    firmId: string,
    dto: UpsertReminderTemplateDto,
  ): Promise<ReminderTemplate> {
    const language = dto.language ?? 'en';
    return this.model
      .findOneAndUpdate(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          channel: dto.channel,
          eventType: dto.eventType,
          language,
        },
        {
          $set: {
            subject: dto.subject,
            body: dto.body,
            variables: dto.variables ?? [],
            isActive: dto.isActive ?? true,
          },
          $setOnInsert: {
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
            channel: dto.channel,
            eventType: dto.eventType,
            language,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
  }

  /**
   * Phase 17 / FIN-16-05 — resolve greeting template for a (workspace, kind,
   * locale) tuple. Resolution order (D-28):
   *   1. Workspace-specific template (workspaceId === wsId, isActive)
   *   2. Global default (workspaceId === null, isDefault: true)
   *   3. Locale fallback to 'en' if requested locale not present
   *
   * `kind` is one of 'birthday_greeting' | 'anniversary_greeting'.
   * `locale` is one of 'en' | 'gu' | 'hi'.
   */
  async getGreetingTemplate(
    wsId: string,
    kind: 'birthday_greeting' | 'anniversary_greeting',
    locale: 'en' | 'gu' | 'hi',
  ): Promise<ReminderTemplate | null> {
    const wsOid = new Types.ObjectId(wsId);

    // 1. workspace override.
    const wsOverride = await this.model
      .findOne({
        workspaceId: wsOid,
        eventType: kind,
        language: locale,
        isActive: true,
      })
      .lean()
      .exec();
    if (wsOverride) return wsOverride as unknown as ReminderTemplate;

    // 2. global default at requested locale.
    const globalAtLocale = await this.model
      .findOne({
        workspaceId: null,
        eventType: kind,
        language: locale,
        isDefault: true,
        isActive: true,
      })
      .lean()
      .exec();
    if (globalAtLocale) return globalAtLocale as unknown as ReminderTemplate;

    // 3. fallback to global English default.
    if (locale !== 'en') {
      const globalEn = await this.model
        .findOne({
          workspaceId: null,
          eventType: kind,
          language: 'en',
          isDefault: true,
          isActive: true,
        })
        .lean()
        .exec();
      if (globalEn) return globalEn as unknown as ReminderTemplate;
    }

    return null;
  }
}
