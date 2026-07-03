import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  JobWorkInwardChallan,
  JobWorkInwardChallanDocument,
} from '../jw-inward/jw-inward-challan.schema';
import {
  JobWorkOutwardChallan,
  JobWorkOutwardChallanDocument,
} from '../jw-outward/jw-outward-challan.schema';
import { JobWorkLot, JobWorkLotDocument } from '../jw-lot/jw-lot.schema';
import { assignSequentialSno } from './itc04-serial.util';
import { Firm } from '../../firms/firm.schema';
import { Itc04QueryDto } from './dto/itc04-query.dto';

/** Zero-pad a number to 2 digits */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format Date as DD/MM/YYYY */
function fmtDate(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

@Injectable()
export class Itc04Service {
  constructor(
    @InjectModel(JobWorkInwardChallan.name)
    private readonly jwiModel: Model<JobWorkInwardChallanDocument>,
    @InjectModel(JobWorkOutwardChallan.name)
    private readonly jwoModel: Model<JobWorkOutwardChallanDocument>,
    @InjectModel(JobWorkLot.name)
    private readonly lotModel: Model<JobWorkLotDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,
  ) {}

  /**
   * Derive quarter start/end dates and last-month-of-quarter for fp (MMYYYY) field.
   * FY input: '2526', '2025-26', or '25-26' — all accepted.
   * Quarter-end month (inclusive): Q1=Jun, Q2=Sep, Q3=Dec, Q4=Mar
   * endDate is EXCLUSIVE (RESEARCH Pitfall 7 — use $lt, not $lte).
   */
  private getQuarterDates(
    quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4',
    fy: string,
  ): {
    startDate: Date;
    endDate: Date;
    lastMonth: number;
    calendarYear: number;
  } {
    const m = fy.match(/^(?:20)?(\d{2})-?(?:20)?(\d{2})$/);
    if (!m) throw new BadRequestException('Invalid fy format');
    const startYear = 2000 + parseInt(m[1], 10); // e.g. 2025
    const endYear = 2000 + parseInt(m[2], 10); // e.g. 2026

    // sm = start month (1-based), em = exclusive end month, lm = last month, cy = calendar year of lm
    const ranges: Record<
      'Q1' | 'Q2' | 'Q3' | 'Q4',
      { sm: number; sy: number; em: number; ey: number; lm: number; cy: number }
    > = {
      Q1: { sm: 4, sy: startYear, em: 7, ey: startYear, lm: 6, cy: startYear },
      Q2: { sm: 7, sy: startYear, em: 10, ey: startYear, lm: 9, cy: startYear },
      Q3: { sm: 10, sy: startYear, em: 1, ey: endYear, lm: 12, cy: startYear },
      Q4: { sm: 1, sy: endYear, em: 4, ey: endYear, lm: 3, cy: endYear },
    };
    const r = ranges[quarter];
    const startDate = new Date(Date.UTC(r.sy, r.sm - 1, 1));
    const endDate = new Date(Date.UTC(r.ey, r.em - 1, 1)); // exclusive end
    return { startDate, endDate, lastMonth: r.lm, calendarYear: r.cy };
  }

  /**
   * Map free-text unit to GSTN UQC codes.
   * Unmapped units fall back to 'OTH' (RESEARCH Open Q4 — THAAN/BARDAAN map to OTH).
   */
  private mapUqc(unit: string): string {
    const u = (unit || '').toUpperCase().trim();
    if (['MTR', 'METER', 'METRE'].includes(u)) return 'MTR';
    if (['KG', 'KGS', 'KILOGRAM'].includes(u)) return 'KGS';
    if (['NO', 'NOS', 'PCS', 'PIECE', 'PIECES'].includes(u)) return 'NOS';
    if (['SET', 'SETS'].includes(u)) return 'SET';
    if (['LTR', 'LITRE', 'LITER'].includes(u)) return 'LTR';
    return 'OTH';
  }

  /**
   * D-07 Tabular report: build table4a (from JWI) + table4b (from JWO) for a quarter.
   * Also returns pending lot balances from the lot register.
   */
  async buildReport(wsId: string, firmId: string, q: Itc04QueryDto) {
    const { startDate, endDate } = this.getQuarterDates(q.quarter, q.fy);
    const baseFilter: any = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      status: 'posted',
      isDeleted: false,
      voucherDate: { $gte: startDate, $lt: endDate }, // RESEARCH Pitfall 7 — exclusive $lt
    };
    if (q.partyId) baseFilter.partyId = new Types.ObjectId(q.partyId);

    // Table 4A — one row per JWI line (goods received from principal)
    const jwis = await this.jwiModel.find(baseFilter).populate('partyId', 'name gstin').lean();

    const table4a = assignSequentialSno(
      jwis.flatMap((j) =>
        j.lines.map((line: any) => ({
          challanNo: j.voucherNumber,
          challanDate: j.voucherDate,
          principalGstin: (j.partyId as any)?.gstin ?? '',
          principalName: (j.partyId as any)?.name ?? '',
          description: line.itemDescription,
          uqc: this.mapUqc(line.unit),
          qtySent: line.qty,
          valuePaise: 0, // custody movement - no GST value on JWI
        })),
      ),
    );

    // Table 4B — return lines + wastage lines from JWO
    const jwos = await this.jwoModel.find(baseFilter).populate('partyId', 'name gstin').lean();

    const table4b = assignSequentialSno(
      jwos.flatMap((jwo) => {
        const returnRows = (jwo.returnLines ?? []).map((line: any) => ({
          challanNo: jwo.voucherNumber,
          challanDate: jwo.voucherDate,
          lotNo: line.lotNo,
          description: line.itemDescription,
          uqc: this.mapUqc(line.unit),
          qtyReceived: line.qtyReturning,
          qtyPending: 0,
          remarks: '',
        }));
        const wastageRows = (jwo.wastageLines ?? []).map((line: any) => ({
          challanNo: jwo.voucherNumber,
          challanDate: jwo.voucherDate,
          lotNo: '',
          description: line.itemDescription,
          uqc: this.mapUqc(line.unit ?? ''),
          qtyReceived: 0,
          qtyPending: line.qtyWasted,
          remarks: `Wastage: ${line.reasonCode}`,
        }));
        return [...returnRows, ...wastageRows];
      }),
    );

    // Pending lot balances (for ITC-04 section 5 — not yet returned)
    const lotFilter: any = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      status: { $in: ['pending', 'partial', 'deemed_supply'] },
      isDeleted: false,
    };
    if (q.partyId) lotFilter.principalPartyId = new Types.ObjectId(q.partyId);

    const pendingLots = await this.lotModel.find(lotFilter).lean();
    const pendingByLot = pendingLots.map((l) => ({
      lotNo: l.lotNo,
      principalPartyId: l.principalPartyId,
      qtyRemaining: l.qtyRemaining,
      isDeemedSupply: l.status === 'deemed_supply',
    }));

    return {
      table4a,
      table4b,
      pendingByLot,
      period: { quarter: q.quarter, fy: q.fy, startDate, endDate },
    };
  }

  /**
   * D-07 GSTN JSON export: wraps buildReport output in the GSTN ITC-04 envelope.
   * Keys: gstin, fp (MMYYYY of quarter-end month), version, table4a[], table4b[].
   * hash/signature are empty placeholders (RESEARCH Open Q2 — F-12 GSTN integration).
   */
  async exportJson(wsId: string, firmId: string, q: Itc04QueryDto) {
    const report = await this.buildReport(wsId, firmId, q);
    const firm = await this.firmModel.findById(new Types.ObjectId(firmId)).lean();
    const { lastMonth, calendarYear } = this.getQuarterDates(q.quarter, q.fy);
    const fp = `${pad2(lastMonth)}${calendarYear}`; // MMYYYY per GSTN spec

    return {
      gstin: (firm as any)?.gstin ?? '',
      fp,
      version: 'GST3.1.3',
      table4a: report.table4a.map((r) => ({
        sno: r.sno,
        chnum: r.challanNo,
        chdt: fmtDate(new Date(r.challanDate)),
        jgstin: r.principalGstin,
        nm: r.principalName,
        typ: r.principalGstin ? '1' : '2', // 1 = registered, 2 = unregistered
        inum: r.challanNo,
        idt: fmtDate(new Date(r.challanDate)),
        val: 0,
        desc: r.description,
        uqc: r.uqc,
        qty: r.qtySent,
        txval: 0,
        rt: 0,
        iamt: 0,
        camt: 0,
        samt: 0,
        csamt: 0,
      })),
      table4b: report.table4b.map((r) => ({
        sno: r.sno,
        chnum: r.challanNo,
        chdt: fmtDate(new Date(r.challanDate)),
        nm: '',
        desc: r.description,
        uqc: r.uqc,
        qty: r.qtyReceived,
        pqty: r.qtyPending,
        remarks: r.remarks,
      })),
      table5b: [], // not in F-11 scope
      hash: '', // placeholder per Open Q2
      signature: '',
    };
  }
}
