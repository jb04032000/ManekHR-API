import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Party } from '../parties/party.schema';
import { Item } from '../items/item.schema';
import { Account } from '../ledger/account.schema';
import { VoucherSeries } from '../voucher-series/voucher-series.schema';
import { CronJobKey } from '../../../common/constants/cron.constants';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';

@Injectable()
export class RecycleBinCron {
  private readonly logger = new Logger(RecycleBinCron.name);

  constructor(
    @InjectModel(Party.name) private readonly partyModel: Model<Party>,
    @InjectModel(Item.name) private readonly itemModel: Model<Item>,
    @InjectModel(Account.name) private readonly accountModel: Model<Account>,
    @InjectModel(VoucherSeries.name) private readonly vsModel: Model<VoucherSeries>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Finance recycle-bin purge
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 02:00 - hard-delete soft-deleted finance records older than 90 days.
   * Idempotent:  YES - naturally idempotent predicate delete across party/item/
   *              account/voucher-series ({ isDeleted:true, deletedAt < 90d cutoff });
   *              a second run finds nothing new to delete.
   * Reads:       parties, items, accounts, voucher_series (soft-deleted rows)
   * Writes:      same collections (predicate delete only; no external side effects)
   * Missed run:  Self-heals - the next daily run purges every still-eligible row
   *              (the cutoff is relative to now, not a fixed occurrence key).
   * Owner:       finance/recycle-bin
   */
  @Cron('0 2 * * *', { name: CronJobKey.RECYCLE_BIN_PURGE }) // 2am daily
  async purgeOldDeleted(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.RECYCLE_BIN_PURGE, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const filter = { isDeleted: true, deletedAt: { $lt: cutoff } };

    const [p, i, a, v] = await Promise.all([
      this.partyModel.deleteMany(filter),
      this.itemModel.deleteMany(filter),
      this.accountModel.deleteMany(filter),
      this.vsModel.deleteMany(filter),
    ]);

    const total = p.deletedCount + i.deletedCount + a.deletedCount + v.deletedCount;
    if (total > 0) {
      this.logger.log(`RecycleBin purge: deleted ${total} records older than 90 days`);
    }
  }
}
