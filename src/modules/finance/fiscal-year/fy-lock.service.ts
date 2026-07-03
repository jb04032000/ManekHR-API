import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FiscalYear } from './fiscal-year.schema';
import { Firm } from '../firms/firm.schema';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * FY-Lock guard (D-16, D-44).
 *
 * Refuses voucher writes whose voucherDate falls inside a CLOSED fiscal year.
 * Inserted at the top of every voucher-write service method (create/update/
 * cancel) AFTER subscription/RBAC validation but BEFORE existing business
 * validations.
 *
 * If `bypassLock` is set on the calling opts (FY-close internal posts), the
 * caller MUST NOT call this service — the calling service skips the call
 * itself per the bypassLock contract (B6).
 *
 * Mongoose-9 autocast: every ObjectId read filter is wrapped with
 * `new Types.ObjectId(...)`.
 */
@Injectable()
export class FyLockService {
  constructor(
    @InjectModel(FiscalYear.name)
    private readonly fyModel: Model<FiscalYear>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,
    private readonly audit: AuditService,
  ) {}

  /**
   * @param opts.amendment D21 amendment path - when the date falls in the soft books-lock window,
   *   an authorized caller may pass a reason to post a dated correction INTO the locked period
   *   (recorded as an audited amendment) instead of globally unlocking/relocking. Does NOT bypass
   *   a CLOSED fiscal year (that still requires a reopen).
   */
  async assertOpen(
    wsId: Types.ObjectId | string,
    firmId: Types.ObjectId | string,
    voucherDate: Date,
    opts?: { amendment?: { reason: string; actorId: string } },
  ): Promise<void> {
    const fy = await this.fyModel
      .findOne({
        wsId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        startDate: { $lte: voucherDate },
        endDate: { $gte: voucherDate },
      })
      .select('status startDate endDate')
      .lean();

    if (fy?.status === 'CLOSED') {
      const start = fy.startDate.toISOString().slice(0, 10);
      const end = fy.endDate.toISOString().slice(0, 10);
      throw new BadRequestException(
        `Financial year ${start} – ${end} is closed; reopen before posting.`,
      );
    }

    // D21 period lock: block postings/edits dated on or before the firm's books-lock date
    // (set after a month's GSTR is filed / the CA closes it), even within an open FY.
    const firm = await this.firmModel
      .findById(new Types.ObjectId(firmId))
      .select('booksLockedUptoDate')
      .lean();
    if (
      firm?.booksLockedUptoDate &&
      voucherDate.getTime() <= new Date(firm.booksLockedUptoDate).getTime()
    ) {
      const upto = new Date(firm.booksLockedUptoDate).toISOString().slice(0, 10);
      // D21 amendment path: an authorized caller may post a dated correction INTO the locked
      // period by supplying a reason, instead of globally unlocking/relocking (which loses the
      // "why" and re-exposes the whole period). We allow it and record an audit trail. A CLOSED FY
      // (handled above) is stricter and still requires a reopen - amendments apply only to the
      // soft books-lock date.
      const reason = opts?.amendment?.reason?.trim();
      if (reason) {
        await this.audit
          .logEvent({
            workspaceId: String(wsId),
            module: AppModule.FINANCE,
            entityType: 'period_amendment',
            entityId: String(firmId),
            action: 'finance.period_amendment',
            actorId: opts.amendment.actorId,
            meta: {
              firmId: String(firmId),
              lockedUptoDate: upto,
              voucherDate: voucherDate.toISOString().slice(0, 10),
              reason,
            },
          })
          .catch(() => undefined);
        return;
      }
      // R4: machine-readable discriminator so the editor can tell the soft books-lock
      // (amendable with a reason) apart from a hard CLOSED FY, and pop the amendment-reason
      // prompt instead of a generic save error. `message` stays for existing consumers
      // (extractErrorMessage reads response.data.message).
      throw new BadRequestException({
        message: `Books are locked up to ${upto}. Unlock the period, or post a dated amendment with a reason, to write on or before that date.`,
        code: 'FINANCE_PERIOD_LOCKED',
        lockedUptoDate: upto,
      });
    }
  }
}
