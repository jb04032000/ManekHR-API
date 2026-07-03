import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingPolicy } from '../schemas/billing-policy.schema';
import { AuditAction, AuditLogService } from './audit-log.service';

interface UpdateBillingPolicyInput {
  failedPaymentRetry?: {
    maxAttempts?: number;
    retryIntervalDays?: number;
  };
  gracePeriod?: {
    durationDays?: number;
    readOnlyMode?: boolean;
    showContactSalesCta?: boolean;
  };
  trial?: {
    defaultDurationDays?: number;
    defaultCardRequired?: boolean;
    reminderEmailDaysBeforeEnd?: number;
  };
  marketing?: {
    sendTrialReminder?: boolean;
    sendRenewalNotice?: boolean;
    renewalNoticeDaysBeforeEnd?: number;
    sendWinBack?: boolean;
    winBackAfterDays?: number;
    sendAbandonedCheckout?: boolean;
    abandonedCheckoutAfterHours?: number;
  };
  proration?: {
    upgradeMode?: string;
    downgradeMode?: string;
    creditUnusedOnUpgrade?: boolean;
    allowDowngrade?: boolean;
    minProratedChargePaise?: number;
  };
  salesContactPhone?: string;
  salesContactEmail?: string;
}

/**
 * BillingPolicy singleton accessor (D1g).
 *
 * The `billingpolicies` collection holds exactly one document
 * (`scope='global'`). All read paths on the hot dunning + grace flow
 * go through `getPolicy()`, which keeps an in-memory cache with a
 * 60-second TTL. Admin updates flush the cache so the new policy
 * takes effect within seconds across the fleet (each replica's cache
 * expires independently — no inter-process invalidation needed for a
 * doc this hot, this small).
 *
 * `ensureExists()` upserts the singleton with schema defaults on
 * first read, so the system stays usable before any admin has opened
 * the policy editor.
 */
@Injectable()
export class BillingPolicyService {
  private readonly logger = new Logger(BillingPolicyService.name);
  private static readonly CACHE_TTL_MS = 60 * 1000;
  private cached: { value: BillingPolicy; expiresAt: number } | null = null;

  constructor(
    @InjectModel(BillingPolicy.name)
    private readonly policyModel: Model<BillingPolicy>,
    private readonly audit: AuditLogService,
  ) {}

  async getPolicy(): Promise<BillingPolicy> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }
    const policy = await this.ensureExists();
    this.cached = {
      value: policy,
      expiresAt: Date.now() + BillingPolicyService.CACHE_TTL_MS,
    };
    return policy;
  }

  /**
   * Admin upsert. Merges supplied subdocs onto the singleton; absent
   * fields keep their prior values. Flushes the cache on success so
   * downstream readers see the change on their next call.
   */
  async upsert(input: UpdateBillingPolicyInput, adminUserId?: string): Promise<BillingPolicy> {
    const update: any = {};
    if (input.failedPaymentRetry) {
      if (input.failedPaymentRetry.maxAttempts !== undefined) {
        update['failedPaymentRetry.maxAttempts'] = input.failedPaymentRetry.maxAttempts;
      }
      if (input.failedPaymentRetry.retryIntervalDays !== undefined) {
        update['failedPaymentRetry.retryIntervalDays'] = input.failedPaymentRetry.retryIntervalDays;
      }
    }
    if (input.gracePeriod) {
      if (input.gracePeriod.durationDays !== undefined) {
        update['gracePeriod.durationDays'] = input.gracePeriod.durationDays;
      }
      if (input.gracePeriod.readOnlyMode !== undefined) {
        update['gracePeriod.readOnlyMode'] = input.gracePeriod.readOnlyMode;
      }
      if (input.gracePeriod.showContactSalesCta !== undefined) {
        update['gracePeriod.showContactSalesCta'] = input.gracePeriod.showContactSalesCta;
      }
    }
    if (input.trial) {
      if (input.trial.defaultDurationDays !== undefined) {
        update['trial.defaultDurationDays'] = input.trial.defaultDurationDays;
      }
      if (input.trial.defaultCardRequired !== undefined) {
        update['trial.defaultCardRequired'] = input.trial.defaultCardRequired;
      }
      if (input.trial.reminderEmailDaysBeforeEnd !== undefined) {
        update['trial.reminderEmailDaysBeforeEnd'] = input.trial.reminderEmailDaysBeforeEnd;
      }
    }
    if (input.marketing) {
      if (input.marketing.sendTrialReminder !== undefined) {
        update['marketing.sendTrialReminder'] = input.marketing.sendTrialReminder;
      }
      if (input.marketing.sendRenewalNotice !== undefined) {
        update['marketing.sendRenewalNotice'] = input.marketing.sendRenewalNotice;
      }
      if (input.marketing.renewalNoticeDaysBeforeEnd !== undefined) {
        update['marketing.renewalNoticeDaysBeforeEnd'] = input.marketing.renewalNoticeDaysBeforeEnd;
      }
      if (input.marketing.sendWinBack !== undefined) {
        update['marketing.sendWinBack'] = input.marketing.sendWinBack;
      }
      if (input.marketing.winBackAfterDays !== undefined) {
        update['marketing.winBackAfterDays'] = input.marketing.winBackAfterDays;
      }
      if (input.marketing.sendAbandonedCheckout !== undefined) {
        update['marketing.sendAbandonedCheckout'] = input.marketing.sendAbandonedCheckout;
      }
      if (input.marketing.abandonedCheckoutAfterHours !== undefined) {
        update['marketing.abandonedCheckoutAfterHours'] =
          input.marketing.abandonedCheckoutAfterHours;
      }
    }
    if (input.proration) {
      if (input.proration.upgradeMode !== undefined) {
        update['proration.upgradeMode'] = input.proration.upgradeMode;
      }
      if (input.proration.downgradeMode !== undefined) {
        update['proration.downgradeMode'] = input.proration.downgradeMode;
      }
      if (input.proration.creditUnusedOnUpgrade !== undefined) {
        update['proration.creditUnusedOnUpgrade'] = input.proration.creditUnusedOnUpgrade;
      }
      if (input.proration.allowDowngrade !== undefined) {
        update['proration.allowDowngrade'] = input.proration.allowDowngrade;
      }
      if (input.proration.minProratedChargePaise !== undefined) {
        update['proration.minProratedChargePaise'] = input.proration.minProratedChargePaise;
      }
    }
    if (input.salesContactPhone !== undefined) {
      update.salesContactPhone = input.salesContactPhone;
    }
    if (input.salesContactEmail !== undefined) {
      update.salesContactEmail = input.salesContactEmail;
    }

    const updated = await this.policyModel
      .findOneAndUpdate(
        { scope: 'global' },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    this.cached = null;
    this.logger.log('BillingPolicy updated by admin');
    await this.audit.log({
      action: AuditAction.AdminBillingPolicyUpdated,
      actorType: 'admin',
      actorUserId: adminUserId,
      metadata: { changedKeys: Object.keys(update) },
    });
    return updated;
  }

  /** Force-flush the cache. Useful in tests + after out-of-band Mongo writes. */
  flushCache(): void {
    this.cached = null;
  }

  private async ensureExists(): Promise<BillingPolicy> {
    return this.policyModel
      .findOneAndUpdate(
        { scope: 'global' },
        { $setOnInsert: { scope: 'global' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }
}
