/**
 * KioskService — public kiosk punch + lookup logic.
 *
 * Security model (M-02 threat register):
 *  - T-M02-01: workspace secret is bcrypt-hashed; plaintext shown only once on generate/regen
 *  - T-M02-02: per-employee PIN, bcrypt-hashed; lockout after 5 wrong attempts for 5 min
 *  - T-M02-04: member query scoped by workspaceId — cross-workspace isolation
 *  - T-M02-05: all public failure paths throw identical 'Invalid employee or PIN' 401
 *  - T-M02-08: salary-lock guard fires before event emission
 *  - T-M02-10: trust-proxy deployment note — req.ip reliable only behind a known proxy
 */
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { AttendanceEvent } from '../schemas/attendance-event.schema';
import { Salary } from '../../salary/schemas/salary.schema';
import { AttendanceEventService } from '../attendance-event.service';
import { AttendanceProjectionService } from '../attendance-projection.service';
import { KioskPunchDto, KioskLookupDto } from './dto/kiosk-punch.dto';

// ── Lockout constants ─────────────────────────────────────────────────────────
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ── Minimal IPv4 CIDR helper (no ip-cidr / ip package dependency) ─────────────

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.includes('/') ? cidr.split('/') : [cidr, '32'];
  const bits = parseInt(bitsStr, 10);
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

@Injectable()
export class KioskService {
  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(TeamMember.name)
    private readonly memberModel: Model<TeamMember>,
    @InjectModel(AttendanceEvent.name)
    private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    private readonly eventService: AttendanceEventService,
    private readonly projectionService: AttendanceProjectionService,
  ) {}

  // ── Anti-enumeration guard ────────────────────────────────────────────────

  /**
   * All public failure paths funnel through this single method so the error
   * message string is the same regardless of which check failed (T-M02-05).
   */
  private genericFail(): never {
    throw new UnauthorizedException('Invalid employee or PIN');
  }

  // ── IP allowlist helper ───────────────────────────────────────────────────

  private isIpAllowed(ip: string, ranges: string[]): boolean {
    if (ranges.length === 0) return true;
    return ranges.some((cidr) => {
      try {
        return inCidr(ip, cidr);
      } catch {
        return false;
      }
    });
  }

  // ── Salary lock helper ────────────────────────────────────────────────────

  private async isSalaryLocked(wsId: string, memberId: string, date: Date): Promise<boolean> {
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    const salary = await this.salaryModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        teamMemberId: new Types.ObjectId(memberId),
        month,
        year,
      })
      .select('isLocked')
      .lean()
      .exec();
    return !!(salary as { isLocked?: boolean } | null)?.isLocked;
  }

  // ── Shared workspace + secret + IP validation ─────────────────────────────

  /**
   * Steps 1-3 shared by both punch() and lookup().
   * Returns the workspace document if all checks pass.
   * All failures call genericFail() (for punch) or throw NotFoundException (for lookup).
   */
  private async validateWorkspace(
    wsId: string,
    secret: string,
    requestIp: string,
    onFail: () => never,
  ): Promise<any> {
    const ws = await this.workspaceModel.findById(new Types.ObjectId(wsId)).lean().exec();
    if (!ws || !(ws as any).kioskEnabled) onFail();

    const ws2 = ws as any;
    if (
      ws2.kioskAllowedIpRanges?.length > 0 &&
      !this.isIpAllowed(requestIp, ws2.kioskAllowedIpRanges)
    ) {
      onFail();
    }

    if (!ws2.kioskTokenHash) onFail();
    const secretOk = await bcrypt.compare(secret, ws2.kioskTokenHash);
    if (!secretOk) onFail();

    return ws2;
  }

  // ── Public punch ──────────────────────────────────────────────────────────

  async punch(
    dto: KioskPunchDto,
    requestIp: string,
  ): Promise<{
    name: string;
    photoUrl: string | null;
    punchType: 'CHECK_IN' | 'CHECK_OUT';
    time: Date;
  }> {
    // Steps 1-3: workspace + enabled + IP + secret
    await this.validateWorkspace(dto.wsId, dto.secret, requestIp, () => this.genericFail());

    // Step 4: find member by employeeCode within workspace
    const member = await this.memberModel
      .findOne({
        workspaceId: new Types.ObjectId(dto.wsId),
        employeeCode: dto.employeeCode,
        isDeleted: false,
      })
      .exec();
    if (!member) this.genericFail();

    // Step 5: lockout check
    if (member.kioskLockedUntil && member.kioskLockedUntil.getTime() > Date.now()) {
      this.genericFail();
    }

    // Step 6: PIN hash must exist
    if (!member.kioskPinHash) this.genericFail();

    // Step 7: PIN verification + failed-attempt tracking
    const pinOk = await bcrypt.compare(dto.pin, member.kioskPinHash);
    if (!pinOk) {
      const newCount = (member.kioskFailedAttempts ?? 0) + 1;
      const update: any = { $inc: { kioskFailedAttempts: 1 } };
      if (newCount >= LOCKOUT_THRESHOLD) {
        update.$set = {
          kioskLockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS),
        };
      }
      await this.memberModel.updateOne({ _id: member._id }, update);
      this.genericFail();
    }

    // Step 8: salary-lock guard. Gap ATTEND-5 (attendance hardening): this is
    // reached only AFTER successful secret + PIN auth, so it is not an
    // anti-enumeration surface — but the message must NOT leak internal payroll
    // state to the unauthenticated tablet. Use a neutral "period closed" string
    // (no "payroll generated") and a stable code the tablet UI maps to a
    // friendly localized notice. Kept as BadRequestException (not genericFail)
    // so the user is not misled into thinking their valid PIN was wrong.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (await this.isSalaryLocked(dto.wsId, String(member._id), today)) {
      throw new BadRequestException({
        code: 'KIOSK_PERIOD_CLOSED',
        message: 'Attendance for this period is closed. Please contact your supervisor.',
      });
    }

    // Step 9: reset counters on successful auth
    await this.memberModel.updateOne(
      { _id: member._id },
      { $set: { kioskFailedAttempts: 0, kioskLockedUntil: null } },
    );

    // Step 10: auto-toggle CHECK_IN / CHECK_OUT based on last event today
    const dayStart = new Date(today);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const last = await this.eventModel
      .findOne({
        wsId: new Types.ObjectId(dto.wsId),
        teamMemberId: member._id,
        timestamp: { $gte: dayStart, $lt: dayEnd },
        voidedAt: null,
        punchType: { $in: ['CHECK_IN', 'CHECK_OUT'] },
      })
      .sort({ timestamp: -1 })
      .lean()
      .exec();

    const nextType: 'CHECK_IN' | 'CHECK_OUT' =
      last && (last as any).punchType === 'CHECK_IN' ? 'CHECK_OUT' : 'CHECK_IN';

    // Step 11: emit attendance event
    await this.eventService.createEvent({
      wsId: dto.wsId,
      teamMemberId: String(member._id),
      timestamp: new Date(),
      punchType: nextType,
      source: 'kiosk',
      verifyMethod: 'kiosk',
      sourceMeta: { requestIp },
    });

    // Step 12: recompute projection for today
    await this.projectionService.recompute(dto.wsId, String(member._id), today);

    // Step 13: return member info
    return {
      name: member.name,
      photoUrl: (member as any).avatar ?? null,
      punchType: nextType,
      time: new Date(),
    };
  }

  // ── Public lookup ─────────────────────────────────────────────────────────

  async lookup(
    dto: KioskLookupDto,
    requestIp: string,
  ): Promise<{ name: string; photoUrl: string | null }> {
    const notFound = (): never => {
      throw new NotFoundException({ message: 'Not found' });
    };

    // Validate workspace + secret + IP (same as punch steps 1-3)
    await this.validateWorkspace(dto.wsId, dto.secret, requestIp, notFound);

    // Find member — does NOT increment failed attempts
    const member = await this.memberModel
      .findOne({
        workspaceId: new Types.ObjectId(dto.wsId),
        employeeCode: dto.employeeCode,
        isDeleted: false,
      })
      .lean()
      .exec();
    if (!member) notFound();

    return {
      name: (member as any).name,
      photoUrl: (member as any).avatar ?? null,
    };
  }
}
