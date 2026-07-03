import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TeamMember } from './schemas/team-member.schema';
import { CRON_SCHEDULES, CRON_TIMEZONES, CronJobKey } from '../../common/constants/cron.constants';
import { SingleFlightService } from '../../common/scheduler/single-flight.service';
import { dayBucket } from '../../common/scheduler/period-key';

@Injectable()
export class OffboardCron {
  private readonly logger = new Logger(OffboardCron.name);

  constructor(
    @InjectModel(TeamMember.name) private teamModel: Model<TeamMember>,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Member offboarding
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 00:00 IST - deactivate members whose resignation date has passed.
   * Idempotent:  YES (predicate state-flip) - selects only { dateOfResignation < now,
   *              isActive:true }; the updateMany flips isActive=false, so a re-run no
   *              longer matches and cascade-closes nothing again. The machine-assignment
   *              cascade is likewise bounded to still-open rows. Tier C.
   * Reads:       team_members (due for offboarding)
   * Writes:      team_members (isActive/hasAppAccess); closes machine_shift_assignments
   * Missed run:  Self-heals - the next daily run offboards every member still past
   *              their resignation date (predicate is time-bounded, not date-keyed).
   * Owner:       team
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT, {
    timeZone: CRON_TIMEZONES.IST,
    name: CronJobKey.OFFBOARD_CRON,
  })
  async handleCron(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.OFFBOARD_CRON, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    this.logger.log('Running member offboarding cron job...');

    try {
      const now = new Date();
      now.setHours(23, 59, 59, 999);

      const due = await this.teamModel
        .find({
          dateOfResignation: { $lt: now },
          isActive: true,
          isDeleted: { $ne: true },
        })
        .select('_id')
        .exec();

      if (due.length === 0) {
        this.logger.log('No members to offboard today');
        return;
      }

      const ids = due.map((m) => m._id);

      const deactivateResult = await this.teamModel.updateMany(
        { _id: { $in: ids } },
        { isActive: false, hasAppAccess: false },
      );

      this.logger.log(
        `Offboarded ${deactivateResult.modifiedCount} members whose last working day has passed`,
      );

    } catch (error) {
      this.logger.error('Member offboarding cron job failed:', error?.message);
    }
  }
}
