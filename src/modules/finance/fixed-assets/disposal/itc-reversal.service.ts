import { Injectable } from '@nestjs/common';

export interface ItcReversalResult {
  applicable: boolean;
  reasonCode: 'no_itc' | 'beyond_60_months' | 'within_60_months';
  itcClaimedPaise: number;
  monthsUsed: number;
  monthsRemaining: number;
  reversalPaise: number;
  formula: string;
  rule: 'rule_44_6' | 'none';
}

@Injectable()
export class ItcReversalService {
  /**
   * Compute GST Rule 44(6) ITC reversal on disposal of capital goods.
   *
   * monthsUsed     = full calendar months between purchaseDate and disposalDate
   * monthsRemaining = max(0, 60 − monthsUsed)
   * reversalPaise  = round(itcClaimedPaise × monthsRemaining / 60)
   *
   * Applies only when itcClaimedPaise > 0 AND monthsUsed < 60 (held < 5 years).
   */
  computeReversal(
    itcClaimedPaise: number,
    purchaseDate: Date,
    disposalDate: Date,
  ): ItcReversalResult {
    if (!itcClaimedPaise || itcClaimedPaise <= 0) {
      return {
        applicable: false,
        reasonCode: 'no_itc',
        itcClaimedPaise: 0,
        monthsUsed: 0,
        monthsRemaining: 0,
        reversalPaise: 0,
        formula: 'N/A — no ITC claimed',
        rule: 'none',
      };
    }

    const monthsUsed = this.fullMonthsBetween(purchaseDate, disposalDate);

    if (monthsUsed >= 60) {
      return {
        applicable: false,
        reasonCode: 'beyond_60_months',
        itcClaimedPaise,
        monthsUsed,
        monthsRemaining: 0,
        reversalPaise: 0,
        formula: `${itcClaimedPaise} × 0/60 = 0 (no reversal — held ≥5 years)`,
        rule: 'none',
      };
    }

    const monthsRemaining = 60 - monthsUsed;
    const reversalPaise = Math.round((itcClaimedPaise * monthsRemaining) / 60);

    return {
      applicable: true,
      reasonCode: 'within_60_months',
      itcClaimedPaise,
      monthsUsed,
      monthsRemaining,
      reversalPaise,
      formula: `${itcClaimedPaise} × ${monthsRemaining}/60 = ${reversalPaise} paise`,
      rule: 'rule_44_6',
    };
  }

  /**
   * Full calendar months between two dates (truncates partial months).
   * Partial month rule: if to.date < from.date, that month does not count.
   * This follows the standard Rule 44(6) interpretation used by CAs.
   */
  fullMonthsBetween(from: Date, to: Date): number {
    if (to <= from) return 0;
    let months =
      (to.getFullYear() - from.getFullYear()) * 12 +
      (to.getMonth() - from.getMonth());
    // If disposal day is earlier than purchase day, partial month — truncate
    if (to.getDate() < from.getDate()) months -= 1;
    return Math.max(0, months);
  }
}
