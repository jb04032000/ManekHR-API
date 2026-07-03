/**
 * Phase 17 / FIN-16-01 D-09 + FIN-16-05 D-29 + FIN-16-02 D-11 — settings service.
 *
 * Wave-1 Plan 04 adds:
 *   - getSettings(wsId): read Workspace.partyIntelligence sub-doc
 *   - updateSettings(wsId, patch): merge patch via dotted $set per key.
 *
 * Defaults applied at READ time when keys are missing — write path stores only
 * what the caller explicitly provided.
 *
 * Plan 06 (greetings) will extend this with listUpcomingGreetings; that lives
 * in a separate file or here per Plan 06's discretion.
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { withFinanceSpan } from '../../common/finance-observability';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

const DEFAULTS = {
  rfmTuning: undefined, // when undefined, segmenter uses D-03 hard-coded thresholds
  greetings: { enabled: false, whatsapp: true, email: true, sms: true },
  gstinPollCadenceDays: 7,
};

@Injectable()
export class PartyIntelligenceSettingsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // updateSettings has no userId in its signature - span only, no PostHog event.
  private readonly tracer = trace.getTracer('finance');

  constructor(@InjectModel('Workspace') private readonly workspaceModel: Model<any>) {}

  async getSettings(wsId: string): Promise<{
    rfmTuning: any;
    greetings: { enabled: boolean; whatsapp: boolean; email: boolean; sms: boolean };
    gstinPollCadenceDays: number;
  }> {
    const wsOid = new Types.ObjectId(wsId); // Pitfall 1
    const ws = await this.workspaceModel.findById(wsOid).select('partyIntelligence').lean();
    const stored = (ws as any)?.partyIntelligence ?? {};
    return {
      rfmTuning: stored.rfmTuning ?? DEFAULTS.rfmTuning,
      greetings: {
        enabled: stored.greetings?.enabled ?? DEFAULTS.greetings.enabled,
        whatsapp: stored.greetings?.whatsapp ?? DEFAULTS.greetings.whatsapp,
        email: stored.greetings?.email ?? DEFAULTS.greetings.email,
        sms: stored.greetings?.sms ?? DEFAULTS.greetings.sms,
      },
      gstinPollCadenceDays: stored.gstinPollCadenceDays ?? DEFAULTS.gstinPollCadenceDays,
    };
  }

  /**
   * Merge a partial settings patch into Workspace.partyIntelligence.
   *
   * Build a dotted $set per key so we don't blow away unspecified sub-fields.
   * (e.g. setting `greetings.enabled=true` must NOT clear the per-channel
   * sub-toggles.)
   *
   * Validation is enforced upstream by class-validator on UpdateSettingsDto
   * (T-17-W1C-02 mitigation).
   */
  async updateSettings(wsId: string, patch: UpdateSettingsDto): Promise<{ updated: boolean }> {
    return withFinanceSpan(
      this.tracer,
      'finance.updatePartyIntelligenceSettings',
      { workspaceId: wsId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const $set: Record<string, unknown> = {};

        if (patch.rfmTuning) {
          for (const [k, v] of Object.entries(patch.rfmTuning)) {
            if (v !== undefined) {
              $set[`partyIntelligence.rfmTuning.${k}`] = v;
            }
          }
        }
        if (patch.greetings) {
          for (const [k, v] of Object.entries(patch.greetings)) {
            if (v !== undefined) {
              $set[`partyIntelligence.greetings.${k}`] = v;
            }
          }
        }
        if (patch.gstinPollCadenceDays !== undefined) {
          $set['partyIntelligence.gstinPollCadenceDays'] = patch.gstinPollCadenceDays;
        }

        if (Object.keys($set).length === 0) {
          return { updated: false };
        }

        await this.workspaceModel.updateOne({ _id: wsOid }, { $set });
        return { updated: true };
      },
    );
  }
}
