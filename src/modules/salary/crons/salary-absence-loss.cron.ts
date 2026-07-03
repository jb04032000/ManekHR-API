import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { SalaryAbsenceLossService } from '../salary-absence-loss.service';

/**
 * SalaryAbsenceLossCron
 *
 * CRON CONTRACT — Absence salary-loss posting
 * Schedule:  daily at 01:00 UTC  (@Cron '0 1 * * *')
 * Purpose:   Iterates all workspaces and delegates to SalaryAbsenceLossService
 *            to convert unregularized absences past the configured window into
 *            next-month SalaryAdjustment deductions (D-03).
 * Idempotent: YES — each deduction is keyed by `absence-loss:{memberId}:{date}`
 *             in the adjustment note; re-runs skip already-posted entries.
 * Reads:     Attendance, RegularizationRequest, PayrollConfig
 * Writes:    SalaryAdjustment (deduction category: absence_recovery)
 * Owner:     salary
 *
 * Mirror of payroll-auto-generate.cron.ts workspace-iteration pattern.
 */
@Injectable()
export class SalaryAbsenceLossCron {
  private readonly logger = new Logger(SalaryAbsenceLossCron.name);

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    private readonly salaryAbsenceLossService: SalaryAbsenceLossService,
  ) {}

  @Cron('0 1 * * *')
  async run(): Promise<void> {
    this.logger.log('Salary absence-loss cron starting...');

    let workspaces: { _id: unknown; name?: string }[] = [];

    try {
      workspaces = (await this.workspaceModel.find({}).select('_id name').lean().exec()) as {
        _id: unknown;
        name?: string;
      }[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch workspaces for absence-loss cron: ${msg}`);
      return;
    }

    this.logger.log(`Processing absence-loss for ${workspaces.length} workspaces`);

    for (const workspace of workspaces) {
      try {
        const workspaceId = String(workspace._id);
        const result = await this.salaryAbsenceLossService.processExpiredAbsences(workspaceId);

        if (result.processed > 0) {
          this.logger.log(
            `Absence-loss: workspace "${workspace.name ?? workspaceId}" — posted ${result.processed} deduction(s)`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Absence-loss cron failed for workspace ${String(workspace._id)}: ${msg}`,
        );
      }
    }

    this.logger.log('Salary absence-loss cron complete');
  }
}
