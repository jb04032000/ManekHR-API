import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, FilterQuery } from 'mongoose';
import {
  SubscriptionPayment,
} from '../schemas/subscription-payment.schema';
import { ListPaymentsQueryDto } from '../dto/payments.dto';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@Injectable()
export class PaymentsQueryService {
  constructor(
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
  ) {}

  async listForUser(userId: string, query: ListPaymentsQueryDto) {
    const filter: FilterQuery<SubscriptionPayment> = {
      userId: new Types.ObjectId(userId),
    };

    if (query.status) filter.status = query.status;
    if (query.paymentMode) filter.paymentMode = query.paymentMode;
    if (query.billingCycle) filter.billingCycle = query.billingCycle;
    if (query.planId) filter.planId = new Types.ObjectId(query.planId);
    if (query.subscriptionId)
      filter.subscriptionId = new Types.ObjectId(query.subscriptionId);

    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) (filter.createdAt as any).$gte = new Date(query.from);
      if (query.to) (filter.createdAt as any).$lte = new Date(query.to);
    }

    if (query.invoiceNumber) {
      const escaped = query.invoiceNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.invoiceNumber = { $regex: escaped, $options: 'i' } as any;
    }

    if (query.hasInvoice === true) {
      filter.invoiceNumber = { ...(filter.invoiceNumber as any), $exists: true, $ne: null };
    } else if (query.hasInvoice === false) {
      filter.$or = [
        { invoiceNumber: { $exists: false } },
        { invoiceNumber: null },
      ];
    }

    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = query.offset ?? 0;

    const [items, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate({ path: 'planId', select: 'name tier monthlyPrice yearlyPrice' })
        .populate({ path: 'subscriptionId', select: 'status currentPeriodStart currentPeriodEnd' })
        .lean()
        .exec(),
      this.paymentModel.countDocuments(filter).exec(),
    ]);

    return { items, total, limit, offset };
  }
}
