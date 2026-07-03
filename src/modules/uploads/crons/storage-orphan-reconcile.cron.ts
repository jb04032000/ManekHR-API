import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UploadEvent } from '../schemas/upload-event.schema';
import { UploadsService } from '../uploads.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { SingleFlightService } from '../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../common/scheduler/period-key';
import {
  CronJobKey,
  CRON_SCHEDULES,
  CRON_TIMEZONES,
} from '../../../common/constants/cron.constants';

/**
 * StorageOrphanReconcileCron - nightly at 04:15 UTC. REPORT-ONLY.
 *
 * The UploadEvent log now records every uploaded file (owner + url + soft-delete
 * marker). This cron cross-checks those records against the ACTUAL objects in
 * the active storage provider and reports two drift classes:
 *   (a) `missing`  - a LIVE record (deletedAt = null) whose object is gone
 *                    (deleted out-of-band, lost in a failed write) -> a dead
 *                    reference users may still try to load.
 *   (b) `lingering`- a record marked deleted whose object STILL exists (a
 *                    tolerated delete that silently failed at the storage layer)
 *                    -> storage we are paying for but no longer track.
 *
 * It NEVER deletes anything (no auto-remediation): drift is surfaced via
 * structured logs + a PostHog metric so a human can investigate. Bounded by
 * SAMPLE_LIMIT per bucket so one run never fans out unboundedly; existence
 * checks run in small concurrent batches.
 *
 * Cross-module: reads UploadEvent (uploads schema) + UploadsService.objectExists
 * (active storage adapter). Mirrors the ads ReconcileCron conventions (CronJobKey
 * + Redis single-flight + dayBucket + CRON CONTRACT header).
 */

/** Max records inspected per bucket per run (keeps one tick bounded). */
const SAMPLE_LIMIT = 2000;
/** Concurrent existence probes (HeadObject / fs) per batch. */
const PROBE_CONCURRENCY = 10;
/** Max drift key-hints carried in the report (the rest are counted, not listed). */
const SAMPLE_HINTS = 25;

export type DriftClass = 'missing' | 'lingering' | 'ok' | 'skip';

/**
 * Pure classifier (exported for unit testing): given whether a record is
 * soft-deleted and whether its object exists, decide the drift class.
 *  - exists === null  -> 'skip'      (indeterminate; never reported as drift)
 *  - live  + absent   -> 'missing'
 *  - deleted + present-> 'lingering'
 *  - otherwise        -> 'ok'
 */
export function classifyDrift(isDeleted: boolean, exists: boolean | null): DriftClass {
  if (exists === null) return 'skip';
  if (!isDeleted && exists === false) return 'missing';
  if (isDeleted && exists === true) return 'lingering';
  return 'ok';
}

/** Last path segment of a url/ref for log context (no full URL, no PII). */
function keyHint(fileUrl: string): string {
  return fileUrl.split('/').pop() || fileUrl.slice(-32);
}

export interface OrphanReconcileSummary {
  liveChecked: number;
  deletedChecked: number;
  /** Live records whose object is missing. */
  missing: number;
  /** Deleted records whose object still exists. */
  lingering: number;
  /** Existence indeterminate (skipped, not counted as drift). */
  indeterminate: number;
  /** Bounded samples of drift key-hints for the log line. */
  missingHints: string[];
  lingeringHints: string[];
}

interface LeanEvent {
  fileUrl: string;
  deletedAt?: Date | null;
}

@Injectable()
export class StorageOrphanReconcileCron {
  private readonly logger = new Logger(StorageOrphanReconcileCron.name);

  constructor(
    @InjectModel(UploadEvent.name) private readonly uploadEventModel: Model<UploadEvent>,
    private readonly uploads: UploadsService,
    private readonly singleFlight: SingleFlightService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /**
   * CRON CONTRACT - Uploads storage-orphan reconcile
   * Execution:   @Cron gated to worker role (web stops it at boot) + Redis
   *              single-flight per day. See docs/architecture/scheduler-contract.md.
   * Schedule:    daily 04:15 UTC - sample UploadEvent rows and report storage drift.
   * Idempotent:  YES (read + log only) - no writes, no deletes. A re-run just
   *              re-reports; running twice is harmless.
   * Reads:       upload_events (UploadEvent); active storage provider (HeadObject /
   *              fs existence probes via UploadsService.objectExists).
   * Writes:      NONE. REPORT-ONLY (structured logs + a PostHog metric).
   * Missed run:  A skipped day just delays the report; the next run re-samples.
   * Owner:       uploads
   */
  @Cron(CRON_SCHEDULES.EVERY_DAY_AT_4_15_UTC, {
    name: CronJobKey.UPLOADS_ORPHAN_RECONCILE,
    timeZone: CRON_TIMEZONES.UTC,
  })
  async run(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.UPLOADS_ORPHAN_RECONCILE, dayBucket(), () =>
      this.tick(),
    );
  }

  /**
   * One reconcile pass. Returns the drift summary (also logged + emitted) so the
   * unit test can assert on it without scraping logs.
   */
  async tick(): Promise<OrphanReconcileSummary> {
    const summary: OrphanReconcileSummary = {
      liveChecked: 0,
      deletedChecked: 0,
      missing: 0,
      lingering: 0,
      indeterminate: 0,
      missingHints: [],
      lingeringHints: [],
    };

    // Bucket A: LIVE rows (deletedAt null) whose object should still exist.
    const live = (await this.uploadEventModel
      .find({ deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(SAMPLE_LIMIT)
      .select('fileUrl deletedAt')
      .lean()
      .exec()) as unknown as LeanEvent[];
    summary.liveChecked = live.length;
    await this.scan(live, summary);

    // Bucket B: DELETED rows whose object should be gone.
    const deleted = (await this.uploadEventModel
      .find({ deletedAt: { $ne: null } })
      .sort({ createdAt: -1 })
      .limit(SAMPLE_LIMIT)
      .select('fileUrl deletedAt')
      .lean()
      .exec()) as unknown as LeanEvent[];
    summary.deletedChecked = deleted.length;
    await this.scan(deleted, summary);

    this.report(summary);
    return summary;
  }

  /** Probe a batch of records in small concurrent chunks and fold the result. */
  private async scan(records: LeanEvent[], summary: OrphanReconcileSummary): Promise<void> {
    for (let i = 0; i < records.length; i += PROBE_CONCURRENCY) {
      const chunk = records.slice(i, i + PROBE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (r) => {
          // A probe error is treated as indeterminate (never reported as drift).
          const exists = await this.uploads.objectExists(r.fileUrl).catch(() => null);
          return { r, klass: classifyDrift(r.deletedAt != null, exists) };
        }),
      );
      for (const { r, klass } of results) {
        if (klass === 'missing') {
          summary.missing += 1;
          if (summary.missingHints.length < SAMPLE_HINTS)
            summary.missingHints.push(keyHint(r.fileUrl));
        } else if (klass === 'lingering') {
          summary.lingering += 1;
          if (summary.lingeringHints.length < SAMPLE_HINTS)
            summary.lingeringHints.push(keyHint(r.fileUrl));
        } else if (klass === 'skip') {
          summary.indeterminate += 1;
        }
      }
    }
  }

  /** Emit the report-only output: a structured log + a PostHog metric. No PII. */
  private report(s: OrphanReconcileSummary): void {
    const drift = s.missing + s.lingering;
    const line =
      `storage orphan reconcile: checked ${s.liveChecked} live + ${s.deletedChecked} deleted; ` +
      `missing=${s.missing} lingering=${s.lingering} indeterminate=${s.indeterminate}`;
    if (drift > 0) {
      this.logger.warn(
        `${line}; missing[${s.missingHints.join(', ')}]; lingering[${s.lingeringHints.join(', ')}]`,
      );
    } else {
      this.logger.log(line);
    }

    this.posthog?.capture({
      distinctId: 'system',
      event: 'uploads.orphan_reconcile_ran',
      properties: {
        liveChecked: s.liveChecked,
        deletedChecked: s.deletedChecked,
        missing: s.missing,
        lingering: s.lingering,
        indeterminate: s.indeterminate,
      },
    });
  }
}
