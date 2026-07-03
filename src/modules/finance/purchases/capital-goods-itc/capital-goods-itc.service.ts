import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { ClientSession, Model, Types } from 'mongoose';
import { CapitalGoodsItcSchedule } from './capital-goods-itc-schedule.schema';
import { withFinanceSpan } from '../../common/finance-observability';

/** Format a Date as YYYY-MM string (no external dependency) */
function formatYearMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Return a new Date with N months added */
function addMonthsToDate(d: Date, n: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + n);
  return result;
}

@Injectable()
export class CapitalGoodsItcService {
  private readonly logger = new Logger(CapitalGoodsItcService.name);
  // Platform-bar observability: shared finance tracer (read spans only — the
  // write path createScheduleForBill runs inside the PurchaseBillService.post()
  // transaction span and carries no userId, so it is intentionally left unwrapped).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(CapitalGoodsItcSchedule.name)
    private readonly model: Model<CapitalGoodsItcSchedule>,
  ) {}

  /**
   * Creates one CapitalGoodsItcSchedule per PurchaseBill lineItem where
   * isCapitalGoods=true AND total ITC (cgst+sgst+igst) > 0.
   *
   * Called inside the PurchaseBillService.post() transaction.
   */
  async createScheduleForBill(
    bill: {
      _id: Types.ObjectId;
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      voucherNumber: string;
      voucherDate: Date;
      financialYear: string;
      lineItems: Array<{
        isCapitalGoods?: boolean;
        itemName?: string;
        cgstPaise?: number;
        sgstPaise?: number;
        igstPaise?: number;
      }>;
    },
    session?: ClientSession,
  ): Promise<CapitalGoodsItcSchedule[]> {
    const created: CapitalGoodsItcSchedule[] = [];
    const startMonth = formatYearMonth(bill.voucherDate);
    const nextAmortisationMonth = formatYearMonth(addMonthsToDate(bill.voucherDate, 1));

    for (let i = 0; i < bill.lineItems.length; i++) {
      const line = bill.lineItems[i];
      if (!line.isCapitalGoods) continue;

      const cgst = line.cgstPaise ?? 0;
      const sgst = line.sgstPaise ?? 0;
      const igst = line.igstPaise ?? 0;
      const totalItcPaise = cgst + sgst + igst;
      if (totalItcPaise <= 0) continue;

      // itcSplit: cgst_sgst if intra-state, igst if inter-state
      const itcSplit: 'cgst_sgst' | 'igst' = igst > 0 ? 'igst' : 'cgst_sgst';
      const monthlyAmountPaise = Math.round(totalItcPaise / 60);

      const [doc] = await this.model.create(
        [
          {
            workspaceId: bill.workspaceId,
            firmId: bill.firmId,
            sourceBillId: bill._id,
            sourceBillNumber: bill.voucherNumber,
            sourceLineNo: i,
            itemName: line.itemName ?? `Line ${i + 1}`,
            totalItcPaise,
            monthsTotal: 60,
            monthsAmortised: 0,
            monthlyAmountPaise,
            startMonth,
            nextAmortisationMonth,
            status: 'amortising',
            financialYear: bill.financialYear,
            itcSplit,
            cgstTotalPaise: cgst,
            sgstTotalPaise: sgst,
            igstTotalPaise: igst,
            cgstReleasedPaise: 0,
            sgstReleasedPaise: 0,
            igstReleasedPaise: 0,
          },
        ],
        { session },
      );
      created.push(doc);
    }

    return created;
  }

  async listForFirm(wsId: string, firmId: string, status?: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.listCapitalGoodsItc',
      { workspaceId: wsId, firmId },
      async () => {
        const filter: Record<string, any> = {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
        };
        if (status) filter.status = status;
        return this.model.find(filter).sort({ startMonth: -1 }).limit(200).exec();
      },
    );
  }

  async findOne(wsId: string, firmId: string, id: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.findCapitalGoodsItc',
      { workspaceId: wsId, firmId },
      async () => {
        return this.model
          .findOne({
            _id: new Types.ObjectId(id),
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
          })
          .exec();
      },
    );
  }
}
