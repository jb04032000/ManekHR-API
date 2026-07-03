/**
 * Smart Defaults / Field Prediction service.
 *
 * Owns the FieldPredictionMemory collection: a tenant-scoped store of a party's
 * last-used invoice settings, so the web new-invoice form can pre-fill fields.
 *
 * Two surfaces:
 *   - rememberMany(...) — BEST-EFFORT bulk upsert called from the sale-invoice
 *     post flow (the orchestrator wires that call). It must NEVER throw; a
 *     memory write failing can never be allowed to fail an invoice post. All
 *     errors are caught and logged via Nest Logger + recorded on the OTel span.
 *   - getForParty(...) — read path for the GET endpoint; returns party-scope
 *     fields (dueDays, placeOfSupplyStateCode) + a map of party_item rate rows.
 *
 * Tenant isolation: every query filters by workspaceId AND firmId. There is no
 * code path that reads or writes without both. The unique index
 * {workspaceId, firmId, scope, key, field} backs idempotent upserts.
 *
 * Observability: wrapped with withFinanceSpan (shared finance OTel helper).
 * Read-only getForParty emits an OTel span only (no PostHog, no audit) per the
 * repo convention for read endpoints.
 *
 * Links to: field-prediction-memory.schema (storage), smart-defaults.controller
 * (read consumer), sale-invoice.service (write caller, wired by orchestrator).
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace } from '@opentelemetry/api';
import { withFinanceSpan } from '../common/finance-observability';
import {
  FieldPredictionMemory,
  FieldPredictionScope,
} from './schemas/field-prediction-memory.schema';

/** One memory entry to upsert. `scope`+`key`+`field` identify the slot. */
export interface RememberEntry {
  scope: FieldPredictionScope;
  key: string;
  field: string;
  valueNum?: number;
  valueStr?: string;
}

/** Tidy read shape for the new-invoice form pre-fill. */
export interface PartyDefaults {
  dueDays?: number;
  placeOfSupplyStateCode?: string;
  /** itemId → last-used ratePaise for this party. */
  itemRates: Record<string, number>;
}

@Injectable()
export class SmartDefaultsService {
  private readonly logger = new Logger(SmartDefaultsService.name);
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(FieldPredictionMemory.name)
    private readonly model: Model<FieldPredictionMemory>,
  ) {}

  /**
   * Best-effort bulk upsert of remembered field values for a tenant.
   *
   * NEVER throws — a memory write must not be able to fail the invoice post
   * that calls it. On any error we log + record on the span and return.
   *
   * Each entry upserts on the unique key {workspaceId, firmId, scope, key,
   * field}; the value lands in valueNum/valueStr and updatedAt is refreshed
   * (last-write-wins).
   *
   * @param wsId   workspace ObjectId (string OK)
   * @param firmId firm ObjectId (string OK)
   * @param entries slots to remember; empty array is a no-op
   */
  async rememberMany(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    entries: RememberEntry[],
  ): Promise<void> {
    if (!entries || entries.length === 0) return;
    try {
      await withFinanceSpan(
        this.tracer,
        'finance.rememberSmartDefaults',
        {
          workspaceId: String(wsId),
          firmId: String(firmId),
          entryCount: entries.length,
        },
        async () => {
          // Pitfall 1 (Mongoose 8 autocast): wrap ObjectId params at the write
          // site rather than trusting query-shape coercion.
          const wsOid = new Types.ObjectId(String(wsId));
          const firmOid = new Types.ObjectId(String(firmId));

          const ops = entries.map((e) => {
            const set: Record<string, unknown> = { updatedAt: new Date() };
            // Only set the slots actually provided so a numeric write never
            // clobbers an existing string value (and vice-versa).
            if (e.valueNum !== undefined) set.valueNum = e.valueNum;
            if (e.valueStr !== undefined) set.valueStr = e.valueStr;
            return {
              updateOne: {
                filter: {
                  workspaceId: wsOid,
                  firmId: firmOid,
                  scope: e.scope,
                  key: e.key,
                  field: e.field,
                },
                update: { $set: set },
                upsert: true,
              },
            };
          });

          await this.model.bulkWrite(ops, { ordered: false });
        },
      );
    } catch (err) {
      // Swallow — best-effort memory must never break the caller (invoice post).
      this.logger.warn(
        `rememberMany failed for ws=${String(wsId)} firm=${String(
          firmId,
        )} (${entries.length} entries): ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Read a party's remembered defaults for the new-invoice form pre-fill.
   *
   * Pulls every memory row for this tenant that is either:
   *   - scope 'party' with key === partyId (dueDays / placeOfSupplyStateCode), or
   *   - scope 'party_item' with key starting `${partyId}:` (per-item rates).
   *
   * Tenant-scoped: filters on workspaceId + firmId. Returns a tidy object;
   * unknown fields are simply omitted.
   *
   * @param wsId    workspace ObjectId (string OK)
   * @param firmId  firm ObjectId (string OK)
   * @param partyId party ObjectId (string OK)
   */
  async getForParty(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    partyId: string | Types.ObjectId,
  ): Promise<PartyDefaults> {
    return withFinanceSpan(
      this.tracer,
      'finance.getSmartDefaultsForParty',
      {
        workspaceId: String(wsId),
        firmId: String(firmId),
      },
      async () => {
        const wsOid = new Types.ObjectId(String(wsId));
        const firmOid = new Types.ObjectId(String(firmId));
        const partyKey = String(partyId);

        // Match party-scope rows for this party OR party_item rows whose key is
        // prefixed `${partyId}:`. The leading workspaceId+firmId+scope index
        // fields keep this selective; the anchored regex hits the index range
        // on `key`.
        const rows = await this.model
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            $or: [
              { scope: 'party', key: partyKey },
              {
                scope: 'party_item',
                // Anchored prefix match on `${partyId}:` — escape the key in
                // case a partyId ever contains regex metacharacters (defensive;
                // ObjectId hex never does).
                key: new RegExp(`^${escapeRegExp(partyKey)}:`),
              },
            ],
          })
          .lean()
          .maxTimeMS(10_000);

        const result: PartyDefaults = { itemRates: {} };

        for (const row of rows) {
          if (row.scope === 'party' && row.key === partyKey) {
            if (row.field === 'dueDays' && typeof row.valueNum === 'number') {
              result.dueDays = row.valueNum;
            } else if (row.field === 'placeOfSupplyStateCode' && typeof row.valueStr === 'string') {
              result.placeOfSupplyStateCode = row.valueStr;
            }
          } else if (
            row.scope === 'party_item' &&
            row.field === 'ratePaise' &&
            typeof row.valueNum === 'number'
          ) {
            // key === `${partyId}:${itemId}` → strip the partyId prefix.
            const itemId = row.key.slice(partyKey.length + 1);
            if (itemId) result.itemRates[itemId] = row.valueNum;
          }
        }

        return result;
      },
    );
  }
}

/** Escape regex metacharacters so a key prefix can be matched literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
