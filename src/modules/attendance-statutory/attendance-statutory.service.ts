import { Injectable, BadRequestException } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as path from 'path';
import pLimit from 'p-limit';
import { StatutoryDataService } from './services/statutory-data.service';
import { GenerateStatutoryDto, StatutoryTemplate } from './dto/generate-statutory.dto';
import type { StatutoryBuildResult } from './types/statutory.types';

const PDF_MIME = 'application/pdf';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Injectable()
export class AttendanceStatutoryService {
  /** WR-01: cap concurrent worker threads to prevent OOM under parallel HTTP requests. */
  private readonly workerLimit = pLimit(4);

  constructor(private readonly data: StatutoryDataService) {}

  async generate(
    workspaceId: string,
    dto: GenerateStatutoryDto,
    generatedByName?: string,
  ): Promise<StatutoryBuildResult> {
    const meta = await this.data.loadWorkspaceMeta(workspaceId, dto.from, dto.to, generatedByName);

    switch (dto.template) {
      case StatutoryTemplate.MH_FORM_T: {
        const rows = await this.data.buildAttendanceSummaries(
          workspaceId, dto.from, dto.to, dto.memberScope,
        );
        const buffer = await this.runGeneratorInWorker(StatutoryTemplate.MH_FORM_T, rows, meta);
        return {
          buffer,
          filename: this.buildFilename('mh-form-t', dto.from, dto.to, 'pdf'),
          mimeType: PDF_MIME,
        };
      }
      case StatutoryTemplate.FORM_25_OT: {
        const rows = await this.data.buildOtSummaries(
          workspaceId, dto.from, dto.to, dto.memberScope, dto.customDailyRate,
        );
        const buffer = await this.runGeneratorInWorker(StatutoryTemplate.FORM_25_OT, rows, meta);
        return {
          buffer,
          filename: this.buildFilename('ot-register-form25', dto.from, dto.to, 'pdf'),
          mimeType: PDF_MIME,
        };
      }
      case StatutoryTemplate.LOP_AUDIT: {
        const rows = await this.data.buildLopSummaries(
          workspaceId, dto.from, dto.to, dto.memberScope,
        );
        const buffer = await this.runGeneratorInWorker(StatutoryTemplate.LOP_AUDIT, rows, meta);
        return {
          buffer,
          filename: this.buildFilename('lop-audit', dto.from, dto.to, 'pdf'),
          mimeType: PDF_MIME,
        };
      }
      case StatutoryTemplate.PF_ESI_WAGE: {
        const rows = await this.data.buildPfEsiRows(
          workspaceId, dto.from, dto.to, dto.memberScope,
        );
        const buffer = await this.runGeneratorInWorker(StatutoryTemplate.PF_ESI_WAGE, rows, meta);
        return {
          buffer,
          filename: this.buildFilename('pf-esi-wage', dto.from, dto.to, 'xlsx'),
          mimeType: XLSX_MIME,
        };
      }
      case StatutoryTemplate.GJ_FORM_D: {
        const rows = await this.data.buildAttendanceSummaries(
          workspaceId, dto.from, dto.to, dto.memberScope,
        );
        const buffer = await this.runGeneratorInWorker(StatutoryTemplate.GJ_FORM_D, rows, meta);
        return {
          buffer,
          filename: this.buildFilename('gj-form-d', dto.from, dto.to, 'pdf'),
          mimeType: PDF_MIME,
        };
      }
      default: {
        // Exhaustiveness guard — should be unreachable given DTO @IsEnum
        const exhaustive: never = dto.template;
        throw new BadRequestException(`Unsupported template: ${exhaustive}`);
      }
    }
  }

  /**
   * WR-01: Gate worker spawning through a pLimit semaphore (max 4 concurrent).
   * Prevents unbounded worker-thread creation under simultaneous HTTP requests.
   *
   * PERF-04 (H6-CONTEXT D-09/D-10): run a pure generator inside a worker_threads
   * worker. The worker path is resolved relative to this compiled module via
   * __dirname — at runtime this is dist/modules/attendance-statutory, so the
   * worker lives at dist/modules/attendance-statutory/generators/worker.js
   * (H6-RESEARCH §Pitfall 2). ts-node (nest start:dev) resolves the .ts sibling
   * when the .js path is requested.
   *
   * The Promise resolves with the Buffer and rejects on worker error or non-zero
   * exit. The HTTP caller awaits this Promise directly (D-10: no background job).
   */
  private runGeneratorInWorker(
    template: StatutoryTemplate,
    rows: unknown,
    meta: unknown,
  ): Promise<Buffer> {
    return this.workerLimit(() => this._spawnWorker(template, rows, meta));
  }

  private _spawnWorker(
    template: StatutoryTemplate,
    rows: unknown,
    meta: unknown,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const workerPath = path.join(__dirname, 'generators', 'worker.js');
      const worker = new Worker(workerPath, {
        workerData: { template, rows, meta },
      });

      let settled = false;
      worker.once('message', (buf: Buffer) => {
        settled = true;
        resolve(buf);
      });
      worker.once('error', (err) => {
        settled = true;
        reject(err);
      });
      worker.once('exit', (code) => {
        if (!settled && code !== 0) {
          reject(new Error(`Statutory generator worker exited with code ${code}`));
        }
      });
    });
  }

  private buildFilename(prefix: string, from: string, to: string, ext: 'pdf' | 'xlsx'): string {
    const safeFrom = from.replace(/[^0-9-]/g, '');
    const safeTo = to.replace(/[^0-9-]/g, '');
    return `${prefix}_${safeFrom}_to_${safeTo}.${ext}`;
  }
}
