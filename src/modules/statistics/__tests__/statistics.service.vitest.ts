/**
 * Statistics service — dashboard enrichment integration test.
 *
 * Exercises the REAL getDashboardStats against mongodb-memory-server with a
 * deterministic clock (now is injected). Asserts the NEW enrichment blocks added
 * for the dashboard rebuild:
 *   - teamView.previousTotalMembers  (staff trend)
 *   - attendance.previousPresent     (present-today trend; most recent prior day)
 *   - salary.previousTotalPaid/Remaining (payroll trend; previous month)
 *   - workforce { byDesignation, byEmploymentType, byShift }
 *   - peopleRadar { newJoiners, birthdays, anniversaries }
 *
 * Decorator-mock + inline narrow schemas: the production Attendance/Salary/
 * TeamMember schemas use union-typed @Prop fields the Vitest decorator pipeline
 * can't resolve, so we neutralise @nestjs/mongoose and build real models with
 * only the fields the service reads (same technique as the regularization +
 * start-trial integration tests). Models still hit real in-memory MongoDB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import { Types, Schema } from 'mongoose';
import {
  createTestMongoose,
  stopTestMongoose,
  clearCollections,
  TestMongo,
} from '../../../test-utils/mongo-memory';
import { StatisticsService } from '../statistics.service';

// Fixed clock: mid-June so "this month" + "next 30 days" windows are unambiguous.
const NOW = new Date('2026-06-15T12:00:00.000Z');
const d = (iso: string) => new Date(iso);

const TeamMemberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.Mixed, required: true },
    name: String,
    designation: String,
    employmentType: String,
    shiftId: { type: Schema.Types.ObjectId },
    gender: String,
    dateOfBirth: Date,
    dateOfJoining: Date,
    salaryAmount: { type: Number, default: 0 },
    weeklyOff: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const AttendanceSchema = new Schema({
  workspaceId: { type: Schema.Types.Mixed, required: true },
  teamMemberId: { type: Schema.Types.ObjectId },
  date: Date,
  status: String,
});

const SalarySchema = new Schema({
  workspaceId: { type: Schema.Types.Mixed, required: true },
  teamMemberId: { type: Schema.Types.ObjectId },
  month: Number,
  year: Number,
  baseSalary: { type: Number, default: 0 },
  netSalary: { type: Number, default: 0 },
});

const PaymentSchema = new Schema({
  workspaceId: { type: Schema.Types.Mixed, required: true },
  salaryId: { type: Schema.Types.ObjectId },
  teamMemberId: { type: Schema.Types.ObjectId },
  amount: { type: Number, default: 0 },
});

const ShiftSchema = new Schema({
  workspaceId: { type: Schema.Types.Mixed, required: true },
  name: String,
});

describe('StatisticsService.getDashboardStats — enrichment blocks', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongo: TestMongo;
  let svc: StatisticsService;
  let TeamModel: any;
  let AttModel: any;
  let SalModel: any;
  let PayModel: any;
  let ShiftModel: any;

  const ws = new Types.ObjectId();
  const shiftMorning = new Types.ObjectId();
  const shiftNight = new Types.ObjectId();
  const m1 = new Types.ObjectId(); // Weaver, full_time, Morning, bday in window, joined 2024
  const m2 = new Types.ObjectId(); // Weaver, full_time, Morning, NEW joiner this month
  const m3 = new Types.ObjectId(); // Helper, contract, Night, anniversary in window, joined 2023
  const m4 = new Types.ObjectId(); // unassigned designation + shift, joined 2022

  beforeAll(async () => {
    mongo = await createTestMongoose();
    TeamModel = mongo.connection.model('TeamMember', TeamMemberSchema);
    AttModel = mongo.connection.model('Attendance', AttendanceSchema);
    SalModel = mongo.connection.model('Salary', SalarySchema);
    PayModel = mongo.connection.model('Payment', PaymentSchema);
    ShiftModel = mongo.connection.model('Shift', ShiftSchema);
    svc = new StatisticsService(AttModel, SalModel, PayModel, TeamModel, ShiftModel);
  });

  afterAll(async () => {
    await stopTestMongoose(mongo);
  });

  beforeEach(async () => {
    await clearCollections(mongo);

    await ShiftModel.create([
      { _id: shiftMorning, workspaceId: ws, name: 'Morning' },
      { _id: shiftNight, workspaceId: ws, name: 'Night' },
    ]);

    await TeamModel.create([
      {
        _id: m1,
        workspaceId: ws,
        name: 'Asha',
        designation: 'Weaver',
        employmentType: 'full_time',
        shiftId: shiftMorning,
        gender: 'female',
        dateOfBirth: d('1992-06-20T00:00:00.000Z'),
        dateOfJoining: d('2024-03-10T00:00:00.000Z'),
        salaryAmount: 10000,
        isActive: true,
        isDeleted: false,
      },
      {
        _id: m2,
        workspaceId: ws,
        name: 'Bhavna',
        designation: 'Weaver',
        employmentType: 'full_time',
        shiftId: shiftMorning,
        gender: 'female',
        dateOfBirth: d('1990-12-01T00:00:00.000Z'),
        dateOfJoining: d('2026-06-05T00:00:00.000Z'),
        salaryAmount: 12000,
        isActive: true,
        isDeleted: false,
      },
      {
        _id: m3,
        workspaceId: ws,
        name: 'Chetan',
        designation: 'Helper',
        employmentType: 'contract',
        shiftId: shiftNight,
        gender: 'male',
        dateOfBirth: d('1985-01-01T00:00:00.000Z'),
        dateOfJoining: d('2023-06-25T00:00:00.000Z'),
        salaryAmount: 8000,
        isActive: true,
        isDeleted: false,
      },
      {
        _id: m4,
        workspaceId: ws,
        name: 'Dipak',
        employmentType: 'full_time',
        gender: 'male',
        dateOfJoining: d('2022-01-01T00:00:00.000Z'),
        salaryAmount: 9000,
        isActive: true,
        isDeleted: false,
      },
    ]);

    // Attendance: today (Jun 15) + prior days. previousPresent must read the MOST
    // RECENT prior day (Jun 14 = 3 present), not the older Jun 10 row.
    await AttModel.create([
      { workspaceId: ws, teamMemberId: m1, date: d('2026-06-15T00:00:00.000Z'), status: 'present' },
      { workspaceId: ws, teamMemberId: m2, date: d('2026-06-15T00:00:00.000Z'), status: 'present' },
      { workspaceId: ws, teamMemberId: m3, date: d('2026-06-15T00:00:00.000Z'), status: 'absent' },
      { workspaceId: ws, teamMemberId: m4, date: d('2026-06-15T00:00:00.000Z'), status: 'late' },
      { workspaceId: ws, teamMemberId: m1, date: d('2026-06-14T00:00:00.000Z'), status: 'present' },
      { workspaceId: ws, teamMemberId: m2, date: d('2026-06-14T00:00:00.000Z'), status: 'present' },
      { workspaceId: ws, teamMemberId: m3, date: d('2026-06-14T00:00:00.000Z'), status: 'present' },
      { workspaceId: ws, teamMemberId: m4, date: d('2026-06-10T00:00:00.000Z'), status: 'present' },
    ]);

    // Current month salary (6/2026): payable 39000, paid 15000 (M1 full, M2 partial).
    const curSal = await SalModel.create([
      {
        workspaceId: ws,
        teamMemberId: m1,
        month: 6,
        year: 2026,
        baseSalary: 10000,
        netSalary: 10000,
      },
      {
        workspaceId: ws,
        teamMemberId: m2,
        month: 6,
        year: 2026,
        baseSalary: 12000,
        netSalary: 12000,
      },
      {
        workspaceId: ws,
        teamMemberId: m3,
        month: 6,
        year: 2026,
        baseSalary: 8000,
        netSalary: 8000,
      },
      {
        workspaceId: ws,
        teamMemberId: m4,
        month: 6,
        year: 2026,
        baseSalary: 9000,
        netSalary: 9000,
      },
    ]);
    await PayModel.create([
      { workspaceId: ws, salaryId: curSal[0]._id, teamMemberId: m1, amount: 10000 },
      { workspaceId: ws, salaryId: curSal[1]._id, teamMemberId: m2, amount: 5000 },
    ]);

    // Previous month salary (5/2026): payable 39000, fully paid 39000 → remaining 0.
    const prevSal = await SalModel.create([
      {
        workspaceId: ws,
        teamMemberId: m1,
        month: 5,
        year: 2026,
        baseSalary: 10000,
        netSalary: 10000,
      },
      {
        workspaceId: ws,
        teamMemberId: m2,
        month: 5,
        year: 2026,
        baseSalary: 12000,
        netSalary: 12000,
      },
      {
        workspaceId: ws,
        teamMemberId: m3,
        month: 5,
        year: 2026,
        baseSalary: 8000,
        netSalary: 8000,
      },
      {
        workspaceId: ws,
        teamMemberId: m4,
        month: 5,
        year: 2026,
        baseSalary: 9000,
        netSalary: 9000,
      },
    ]);
    await PayModel.create([
      { workspaceId: ws, salaryId: prevSal[0]._id, teamMemberId: m1, amount: 10000 },
      { workspaceId: ws, salaryId: prevSal[1]._id, teamMemberId: m2, amount: 12000 },
      { workspaceId: ws, salaryId: prevSal[2]._id, teamMemberId: m3, amount: 8000 },
      { workspaceId: ws, salaryId: prevSal[3]._id, teamMemberId: m4, amount: 9000 },
    ]);
  });

  const run = () => svc.getDashboardStats(ws.toString(), NOW) as Promise<any>;

  it('keeps the existing headline numbers correct', async () => {
    const { data } = await run();
    expect(data.teamView.totalMembers).toBe(4);
    expect(data.attendance.present).toBe(2);
    expect(data.attendance.total).toBe(4);
    expect(data.salary.totalPayable).toBe(39000);
    expect(data.salary.totalPaid).toBe(15000);
    expect(data.salary.totalRemaining).toBe(24000);
  });

  it('emits previousTotalMembers = headcount excluding this month joiners', async () => {
    const { data } = await run();
    // m1(2024), m3(2023), m4(2022) joined before June 2026; m2 joined this month.
    expect(data.teamView.previousTotalMembers).toBe(3);
  });

  it('emits previousPresent from the most recent prior day with records', async () => {
    const { data } = await run();
    expect(data.attendance.previousPresent).toBe(3); // Jun 14, not Jun 10
  });

  it('emits previous-month salary paid/remaining', async () => {
    const { data } = await run();
    expect(data.salary.previousTotalPaid).toBe(39000);
    expect(data.salary.previousTotalRemaining).toBe(0);
  });

  it('groups the workforce by designation, employment type and shift', async () => {
    const { data } = await run();
    const byKey = (arr: any[]) =>
      Object.fromEntries(arr.map((r) => [r.label ?? '__none__', r.count]));

    expect(byKey(data.workforce.byDesignation)).toEqual({ Weaver: 2, Helper: 1, __none__: 1 });
    expect(byKey(data.workforce.byEmploymentType)).toEqual({ full_time: 3, contract: 1 });
    expect(byKey(data.workforce.byShift)).toEqual({ Morning: 2, Night: 1, __none__: 1 });
  });

  it('builds the people radar: new joiners, birthdays, anniversaries', async () => {
    const { data } = await run();
    const names = (arr: any[]) => arr.map((r) => r.name).sort();

    expect(names(data.peopleRadar.newJoiners)).toEqual(['Bhavna']); // joined June 2026
    expect(names(data.peopleRadar.birthdays)).toEqual(['Asha']); // DOB Jun 20, in next 30d
    expect(names(data.peopleRadar.anniversaries)).toEqual(['Chetan']); // DOJ Jun 25 (prior year)
    const chetan = data.peopleRadar.anniversaries.find((r: any) => r.name === 'Chetan');
    expect(chetan.years).toBe(3); // 2026 - 2023
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
