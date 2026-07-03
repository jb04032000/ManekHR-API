import { Injectable } from '@nestjs/common';
import { LineItem, AdditionalCharge } from '../voucher-base/voucher-base.interface';
import { CessRulesService } from '../../inventory/cess/cess-rules.service';
import {
  roundPaise,
  gstHalves,
  igstPaise as gstIgst,
  effectiveRateCentiPaise,
  lineAmountPaise,
} from '../../common/precision';

// ─── Input / Output interfaces ──────────────────────────────────────────────

export interface TaxComputationInput {
  lines: LineItem[];
  additionalCharges: AdditionalCharge[];
  /** e.g. "24" (Gujarat) — derived from firm.gstin[0:2] */
  firmStateCode: string;
  /** derived from party.gstin[0:2] OR mapped from party.state */
  partyStateCode: string;
  /** explicit on invoice; usually = partyStateCode */
  placeOfSupplyStateCode: string;
  roundingPolicy: 'half_up' | 'round_off_to_rupee';
  /** TCS paise — pre-computed by PartySalesAggregateService; pass-through */
  tcsPaise?: number;
}

export interface TaxComputationResult {
  /** each line populated with taxableValuePaise/cgst/sgst/igst/cess/lineTotal */
  lines: LineItem[];
  /** sum(qty × rate) before discount */
  subtotalPaise: number;
  totalDiscountPaise: number;
  /** sum(line.taxableValue) + taxable additional charges */
  taxableValuePaise: number;
  /** sum(additionalCharge.amount) */
  additionalChargesPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  /** pass-through from input */
  tcsPaise: number;
  /** grandTotalRounded - grandTotalRaw */
  roundOffPaise: number;
  /** final, includes round-off */
  grandTotalPaise: number;
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class TaxComputationService {
  constructor(private readonly cessRulesService: CessRulesService) {}

  /**
   * D-08 Cess engine: Tier-2 (HSN registry) lookup with Tier-1 (Item.cessRate) fallback.
   *
   * Priority:
   *   1. CessRulesService.findApplicableForHsn(hsnCode) — longest-prefix HSN match in registry
   *   2. Caller-supplied cessRate fallback (typically item.cessRate)
   *
   * @param hsnCode             Item HSN code (e.g., '24011030')
   * @param cessRate            Item-level fallback cess rate (percent, e.g., 60 for 60%)
   * @param qty                 Line quantity
   * @param taxableValuePaise   Taxable value of the line in paise (used for ad-valorem cess)
   * @returns Cess amount in paise (rounded to nearest paise)
   */
  async computeCess(
    hsnCode: string,
    cessRate: number,
    qty: number,
    taxableValuePaise: number,
  ): Promise<number> {
    // Tier-2: HSN registry lookup
    const rule = hsnCode ? await this.cessRulesService.findApplicableForHsn(hsnCode) : null;

    if (rule) {
      // CessRule schema fields: adValoremRate (percent), specificRatePerUnit (paise per unit)
      let cess = 0;
      if (rule.adValoremRate) {
        cess += roundPaise((taxableValuePaise * rule.adValoremRate) / 100);
      }
      if (rule.specificRatePerUnit) {
        cess += roundPaise(qty * rule.specificRatePerUnit);
      }
      return cess;
    }

    // Tier-1: Item.cessRate fallback (ad-valorem only)
    if (cessRate && cessRate > 0) {
      return roundPaise((taxableValuePaise * cessRate) / 100);
    }

    return 0;
  }

  /**
   * Compute all GST line-level and summary figures per D-18 rules.
   * Pure function — no Mongo dependency. Safe to call from any context.
   */
  compute(input: TaxComputationInput): TaxComputationResult {
    const {
      lines,
      additionalCharges,
      firmStateCode,
      placeOfSupplyStateCode,
      roundingPolicy,
      tcsPaise = 0,
    } = input;

    // D-18.1 — intra vs inter state
    const isIntraState = firmStateCode === placeOfSupplyStateCode;

    let subtotalPaise = 0;
    let totalDiscountPaise = 0;
    let taxableValuePaise = 0;
    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;
    let cessPaise = 0;

    // ── Per-line computation ─────────────────────────────────────────────────
    const computedLines: LineItem[] = lines.map((line) => {
      const qtyTotal = lineAmountPaise(line.qty, effectiveRateCentiPaise(line));
      subtotalPaise += qtyTotal;

      // D-18.8 — discount applied before tax
      const discountPaise =
        (line.discountFlatPaise ?? 0) > 0
          ? line.discountFlatPaise
          : roundPaise(qtyTotal * (line.discountPct / 100));

      totalDiscountPaise += discountPaise;
      const lineGross = qtyTotal - discountPaise;

      // D-18.3 / D-18.4 — tax-inclusive vs exclusive
      let lineTaxable: number;
      if (line.isTaxInclusive) {
        // back-calculate: taxable = gross / (1 + rate/100)
        lineTaxable = roundPaise((lineGross * 100) / (100 + line.taxRate));
      } else {
        lineTaxable = lineGross;
      }

      // D-18.5 - per-line tax amounts (equal CGST/SGST halves via gstHalves)
      let lineCgst = 0;
      let lineSgst = 0;
      let lineIgst = 0;

      if (isIntraState) {
        const halves = gstHalves(lineTaxable, line.taxRate);
        lineCgst = halves.cgstPaise;
        lineSgst = halves.sgstPaise;
      } else {
        lineIgst = gstIgst(lineTaxable, line.taxRate);
      }

      // D-18.7 — cess
      const lineCess = roundPaise((lineTaxable * line.cessRate) / 100);

      const lineTotalPaise = lineTaxable + lineCgst + lineSgst + lineIgst + lineCess;

      taxableValuePaise += lineTaxable;
      cgstPaise += lineCgst;
      sgstPaise += lineSgst;
      igstPaise += lineIgst;
      cessPaise += lineCess;

      return {
        ...line,
        taxableValuePaise: lineTaxable,
        cgstPaise: lineCgst,
        sgstPaise: lineSgst,
        igstPaise: lineIgst,
        cessPaise: lineCess,
        lineTotalPaise,
      };
    });

    // ── Additional charges (D-18.9) ─────────────────────────────────────────
    let additionalChargesPaise = 0;
    let additionalTaxableContrib = 0;

    for (const charge of additionalCharges) {
      additionalChargesPaise += charge.amountPaise;

      if (charge.isTaxable && charge.taxRate != null) {
        additionalTaxableContrib += charge.amountPaise;
        const rate = charge.taxRate;

        if (isIntraState) {
          const halves = gstHalves(charge.amountPaise, rate);
          cgstPaise += halves.cgstPaise;
          sgstPaise += halves.sgstPaise;
        } else {
          igstPaise += gstIgst(charge.amountPaise, rate);
        }
      }
    }

    // Taxable value includes taxable additional charges
    taxableValuePaise += additionalTaxableContrib;

    // ── Grand total before round-off ─────────────────────────────────────────
    const rawTotal =
      taxableValuePaise +
      cgstPaise +
      sgstPaise +
      igstPaise +
      cessPaise +
      tcsPaise +
      // non-taxable additional charges not in taxableValuePaise yet
      (additionalChargesPaise - additionalTaxableContrib);

    // D-18.6 — round-off
    let roundOffPaise = 0;
    let grandTotalPaise = rawTotal;

    if (roundingPolicy === 'round_off_to_rupee') {
      const roundedTotal = roundPaise(rawTotal / 100) * 100;
      roundOffPaise = roundedTotal - rawTotal;
      grandTotalPaise = roundedTotal;
    }

    return {
      lines: computedLines,
      subtotalPaise,
      totalDiscountPaise,
      taxableValuePaise,
      additionalChargesPaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      cessPaise,
      tcsPaise,
      roundOffPaise,
      grandTotalPaise,
    };
  }
}
