import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { TdsTracker } from './tds-tracker.schema';

export interface TdsComputationResult {
  section: 'sec_194c' | 'sec_194h' | 'sec_194j' | 'sec_194q';
  rate: number;
  basePaise: number;
  tdsPaise: number;
  cumulativeBeforePaise: number;
}

const PAISE_PER_RUPEE = 100;
// ₹50L in paise = 50 * 100_000 * 100 = 5_000_000_00
const THRESHOLD_194Q_PAISE = 50 * 100_000 * PAISE_PER_RUPEE;
// ₹10 Cr in paise = 10 * 10_000_000 * 100 = 10_000_000_000
const FIRM_AATO_THRESHOLD_PAISE = 10 * 10_000_000 * PAISE_PER_RUPEE;
// ₹1L cumulative = 100_000 * 100 = 10_000_000
const THRESHOLD_194C_CUM_PAISE = 100_000 * PAISE_PER_RUPEE;
// ₹30k single = 30_000 * 100 = 3_000_000
const THRESHOLD_194C_SINGLE_PAISE = 30_000 * PAISE_PER_RUPEE;
// ₹15k cumulative = 15_000 * 100 = 1_500_000
const THRESHOLD_194H_CUM_PAISE = 15_000 * PAISE_PER_RUPEE;
// ₹30k cumulative = 30_000 * 100 = 3_000_000
const THRESHOLD_194J_CUM_PAISE = 30_000 * PAISE_PER_RUPEE;

@Injectable()
export class TdsService {
  private readonly logger = new Logger(TdsService.name);

  constructor(
    @InjectModel(TdsTracker.name) private readonly trackerModel: Model<TdsTracker>,
  ) {}

  /**
   * Compute TDS-194Q at PurchaseBill post time.
   * Returns null if not applicable:
   *   - party absent
   *   - firm.aato <= ₹10Cr (firm not covered by Sec 194Q)
   *   - cumulative vendor spend still <= ₹50L threshold after this bill
   */
  async compute194Q(
    bill: {
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      partyId?: Types.ObjectId;
      taxableValuePaise: number;
      financialYear: string;
    },
    party: { pan?: string },
    firm: { aato?: number },
    session?: ClientSession,
  ): Promise<TdsComputationResult | null> {
    if (!bill.partyId) return null;
    // Sec 194Q applies only when buyer's turnover > ₹10Cr
    if (!firm.aato || firm.aato <= FIRM_AATO_THRESHOLD_PAISE) return null;

    // Atomic $inc: safe for concurrent requests — post-update value is authoritative
    const updated = await this.trackerModel.findOneAndUpdate(
      {
        workspaceId: bill.workspaceId,
        firmId: bill.firmId,
        vendorPartyId: bill.partyId,
        section: 'sec_194q',
        financialYear: bill.financialYear,
      },
      { $inc: { cumulativePaise: bill.taxableValuePaise } },
      { new: true, upsert: true, session },
    );

    const cumulativeBefore = updated.cumulativePaise - bill.taxableValuePaise;

    // Still below ₹50L threshold — no TDS
    if (updated.cumulativePaise <= THRESHOLD_194Q_PAISE) {
      return null;
    }

    // Sec 206AA: 20% if vendor has no PAN; otherwise 0.1%
    const rate = party.pan ? 0.001 : 0.20;

    let basePaise: number;
    if (cumulativeBefore < THRESHOLD_194Q_PAISE) {
      // First crossing: TDS only on the excess above ₹50L
      basePaise = updated.cumulativePaise - THRESHOLD_194Q_PAISE;
    } else {
      // Already crossed in a prior bill: TDS on full taxable value of this bill
      basePaise = bill.taxableValuePaise;
    }
    const tdsPaise = Math.round(basePaise * rate);

    // Record TDS deducted on the tracker
    await this.trackerModel.updateOne(
      { _id: updated._id },
      { $inc: { totalTdsDeductedPaise: tdsPaise } },
      { session },
    );

    return {
      section: 'sec_194q',
      rate,
      basePaise,
      tdsPaise,
      cumulativeBeforePaise: cumulativeBefore,
    };
  }

  /**
   * Compute TDS at PaymentOut time (sec_194c | sec_194h | sec_194j).
   * Returns null if:
   *   - party.supplierType is not contractor / broker / professional
   *   - threshold not crossed (cumulative <= threshold AND single payment <= singleThreshold)
   */
  async computeAtPaymentOut(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    party: {
      _id: Types.ObjectId;
      supplierType?: string | null;
      deducteeStatus?: string | null;
      pan?: string;
    },
    paymentBasePaise: number,
    financialYear: string,
    session?: ClientSession,
  ): Promise<TdsComputationResult | null> {
    if (!party.supplierType) return null;

    let section: 'sec_194c' | 'sec_194h' | 'sec_194j' | null = null;
    let rate = 0;
    let cumulativeThreshold = 0;
    let singleThreshold = Infinity;

    if (party.supplierType === 'contractor') {
      section = 'sec_194c';
      if (!party.pan) {
        rate = 0.20; // Sec 206AA: no PAN
      } else if (party.deducteeStatus === 'company_firm') {
        rate = 0.02; // 2% for company/firm contractors
      } else {
        rate = 0.01; // 1% for individual/HUF contractors
      }
      cumulativeThreshold = THRESHOLD_194C_CUM_PAISE;
      singleThreshold = THRESHOLD_194C_SINGLE_PAISE;
    } else if (party.supplierType === 'broker') {
      section = 'sec_194h';
      rate = party.pan ? 0.05 : 0.20; // post-Oct 2024 rate; Sec 206AA applies
      cumulativeThreshold = THRESHOLD_194H_CUM_PAISE;
    } else if (party.supplierType === 'professional') {
      section = 'sec_194j';
      rate = party.pan ? 0.10 : 0.20;
      cumulativeThreshold = THRESHOLD_194J_CUM_PAISE;
    } else {
      // transporter etc. — not covered by these sections
      return null;
    }

    // Atomic $inc — reads post-increment cumulative
    const updated = await this.trackerModel.findOneAndUpdate(
      { workspaceId, firmId, vendorPartyId: party._id, section, financialYear },
      { $inc: { cumulativePaise: paymentBasePaise } },
      { new: true, upsert: true, session },
    );
    const cumulativeBefore = updated.cumulativePaise - paymentBasePaise;

    // Threshold check: cumulative must exceed cumulativeThreshold OR single payment > singleThreshold
    const crossesCumulative = updated.cumulativePaise > cumulativeThreshold;
    const crossesSingle = paymentBasePaise > singleThreshold;
    if (!crossesCumulative && !crossesSingle) {
      return null;
    }

    // For first cumulative crossing: TDS only on excess above threshold (mirrors 194Q logic).
    // If crossesSingle fired (194C single-payment threshold), TDS is always on full payment.
    let basePaise: number;
    if (crossesCumulative && !crossesSingle && cumulativeBefore < cumulativeThreshold) {
      // First crossing via cumulative threshold — TDS on excess only
      basePaise = updated.cumulativePaise - cumulativeThreshold;
    } else {
      // Already past threshold in prior payments, or single-payment threshold triggered
      basePaise = paymentBasePaise;
    }
    const tdsPaise = Math.round(basePaise * rate);

    // Record TDS deducted
    await this.trackerModel.updateOne(
      { _id: updated._id },
      { $inc: { totalTdsDeductedPaise: tdsPaise } },
      { session },
    );

    return {
      section,
      rate,
      basePaise,
      tdsPaise,
      cumulativeBeforePaise: cumulativeBefore,
    };
  }
}
