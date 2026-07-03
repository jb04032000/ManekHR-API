import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RefundPolicy } from '../schemas/refund-policy.schema';
import { AuditAction, AuditLogService } from './audit-log.service';

interface UpdateRefundPolicyInput {
  customerSelfServiceEnabled?: boolean;
  eligibleWithinDays?: number;
  allowPartial?: boolean;
  requireSecondAdminApprovalAfterWindow?: boolean;
  reasons?: string[];
  autoDowngradeOnFullRefund?: boolean;
}

/**
 * RefundPolicy singleton accessor (D1h). Mirrors `BillingPolicyService`
 * — one global document, in-memory 60s cache, atomic ensureExists
 * upsert, admin merge-upsert flushes cache.
 */
@Injectable()
export class RefundPolicyService {
  private readonly logger = new Logger(RefundPolicyService.name);
  private static readonly CACHE_TTL_MS = 60 * 1000;
  private cached: { value: RefundPolicy; expiresAt: number } | null = null;

  constructor(
    @InjectModel(RefundPolicy.name)
    private readonly policyModel: Model<RefundPolicy>,
    private readonly audit: AuditLogService,
  ) {}

  async getPolicy(): Promise<RefundPolicy> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    const policy = await this.ensureExists();
    this.cached = {
      value: policy,
      expiresAt: Date.now() + RefundPolicyService.CACHE_TTL_MS,
    };
    return policy;
  }

  async upsert(
    input: UpdateRefundPolicyInput,
    adminUserId?: string,
  ): Promise<RefundPolicy> {
    const update: any = {};
    for (const key of Object.keys(input) as (keyof UpdateRefundPolicyInput)[]) {
      if (input[key] !== undefined) update[key] = input[key];
    }
    const updated = await this.policyModel
      .findOneAndUpdate(
        { scope: 'global' },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    this.cached = null;
    this.logger.log('RefundPolicy updated by admin');
    await this.audit.log({
      action: AuditAction.AdminRefundPolicyUpdated,
      actorType: 'admin',
      actorUserId: adminUserId,
      metadata: { changedKeys: Object.keys(update) },
    });
    return updated;
  }

  flushCache(): void {
    this.cached = null;
  }

  private async ensureExists(): Promise<RefundPolicy> {
    return this.policyModel
      .findOneAndUpdate(
        { scope: 'global' },
        { $setOnInsert: { scope: 'global' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }
}
