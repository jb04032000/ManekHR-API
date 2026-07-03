import { Injectable } from '@nestjs/common';

export interface DepreciationInput {
  costPaise: number;
  salvageValuePaise: number;
  depreciableAmountPaise: number;        // costPaise - salvageValuePaise
  usefulLifeYears: number;
  depreciationMethod: 'slm' | 'wdv';
  slmRate: number;                        // decimal
  wdvRate: number;                        // decimal
  shiftType: 'single' | 'double' | 'triple';
  isNesd: boolean;                        // if true, ignore shift multiplier
  openingNbvPaise: number;                // current NBV at period start
  accumulatedDepreciationPaise: number;   // running total
  purchaseDate: Date;                     // for first-year pro-rata + 180-day rule
}

export interface DepreciationOutput {
  amountPaise: number;
  daysInPeriod: number;
  shiftMultiplier: number;
  capped: boolean;       // true if capped at salvage
}

@Injectable()
export class DepreciationMathService {
  /** Days between two dates inclusive of start, exclusive of end. */
  private daysBetween(start: Date, end: Date): number {
    const ms = end.getTime() - start.getTime();
    return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
  }

  /** Resolve shift multiplier; NESD assets always 1.0. */
  shiftMultiplier(shiftType: 'single' | 'double' | 'triple', isNesd: boolean): number {
    if (isNesd) return 1.0;
    if (shiftType === 'double') return 1.5;
    if (shiftType === 'triple') return 2.0;
    return 1.0;
  }

  /**
   * Compute depreciation for a specific period (typically a calendar month).
   * Caps at remaining depreciable amount (NBV - salvage). Never returns negative.
   */
  computeForPeriod(
    input: DepreciationInput,
    periodStart: Date,
    periodEnd: Date,
  ): DepreciationOutput {
    const daysInPeriod = this.daysBetween(periodStart, periodEnd);
    const multiplier = this.shiftMultiplier(input.shiftType, input.isNesd);

    // Effective period start: max(purchaseDate, periodStart) for first-period pro-rata.
    const effectiveStart = input.purchaseDate > periodStart ? input.purchaseDate : periodStart;
    const effectiveDays = this.daysBetween(effectiveStart, periodEnd);
    if (effectiveDays <= 0) {
      return { amountPaise: 0, daysInPeriod, shiftMultiplier: multiplier, capped: false };
    }

    let amountPaise = 0;
    if (input.depreciationMethod === 'slm') {
      // Annual = depreciableAmount / usefulLife
      const annualBase = input.depreciableAmountPaise / input.usefulLifeYears;
      amountPaise = Math.round((annualBase * effectiveDays / 365) * multiplier);
    } else {
      // WDV: annual = openingNbv * rate (uses current NBV — caller advances NBV between periods)
      const annualBase = input.openingNbvPaise * input.wdvRate;
      amountPaise = Math.round((annualBase * effectiveDays / 365) * multiplier);
    }

    // Cap at remaining depreciable amount = nbv - salvage
    const remainingDepreciable = Math.max(0, input.openingNbvPaise - input.salvageValuePaise);
    let capped = false;
    if (amountPaise > remainingDepreciable) {
      amountPaise = remainingDepreciable;
      capped = true;
    }
    if (amountPaise < 0) amountPaise = 0;

    return { amountPaise, daysInPeriod, shiftMultiplier: multiplier, capped };
  }

  /**
   * IT Act 180-day rule: applies to first FY of acquisition.
   * Returns multiplier (0.5 if days_in_first_FY < 180, else 1.0).
   */
  itAct180DayMultiplier(purchaseDate: Date, fyEndDate: Date): number {
    const days = this.daysBetween(purchaseDate, fyEndDate);
    return days < 180 ? 0.5 : 1.0;
  }

  /** Convenience: annual depreciation per Companies Act (no shift, no pro-rata). */
  computeAnnualBase(input: DepreciationInput): number {
    if (input.depreciationMethod === 'slm') {
      return Math.round(input.depreciableAmountPaise / input.usefulLifeYears);
    }
    return Math.round(input.openingNbvPaise * input.wdvRate);
  }
}
