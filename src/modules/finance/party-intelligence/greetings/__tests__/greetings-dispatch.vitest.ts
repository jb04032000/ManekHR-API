/**
 * Phase 17 / FIN-16-05 — Greetings dispatch + cron integration tests.
 *
 * These tests use unit-style mocks rather than mongodb-memory-server because
 * the GreetingsService injects 4 Mongoose models + 3 channel adapters + the
 * EventEmitter — full DI wiring would require wiring every dispatcher
 * dependency. The behaviors covered:
 *
 *   1. Cron `shouldRunInWorkspaceNow` filters by per-ws local hour.
 *   2. dispatch() respects master switch via runForWorkspace flow.
 *   3. dispatch() success → adapter.send + dedupe-log + reminder-log + timeline
 *   4. dispatch() dedupe — re-run hits 11000 race → swallowed
 *   5. dispatch() failure → failed dedupe-log; no timeline; no reminder-log
 *   6. Locale resolution — party.preferredLocale='gu' → gu template fetched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { GreetingsService } from '../greetings.service';
import { GreetingsCron } from '../greetings.cron';

// Valid 24-char ObjectIds for fixtures.
const WS_ID = new Types.ObjectId().toHexString();
const FIRM_ID = new Types.ObjectId().toHexString();
const PARTY_ID = new Types.ObjectId().toHexString();
const CONTACT_ID = new Types.ObjectId().toHexString();

// ── Test doubles ──────────────────────────────────────────────────────────

function makeMockModel(initial: any[] = []): any {
  const docs: any[] = [...initial];
  return {
    docs,
    find: vi.fn((_filter?: any) => ({
      select: () => ({
        lean: () => Promise.resolve(docs),
      }),
      lean: () => Promise.resolve(docs),
    })),
    findById: vi.fn((id: any) => ({
      select: () => ({
        lean: () =>
          Promise.resolve(
            docs.find((d) => String(d._id) === String(id)) ?? null,
          ),
      }),
      lean: () =>
        Promise.resolve(
          docs.find((d) => String(d._id) === String(id)) ?? null,
        ),
    })),
    findOne: vi.fn(() => ({
      lean: () => Promise.resolve(null),
    })),
    create: vi.fn((doc: any) => {
      docs.push(doc);
      return Promise.resolve(doc);
    }),
  };
}

function makeAdapter(success: boolean = true) {
  return {
    send: vi.fn().mockResolvedValue({
      success,
      status: success ? 'sent' : 'failed',
      recipient: success ? '+91*****1234' : 'unknown',
      messageId: success ? 'msg-1' : undefined,
      errorMessage: success ? undefined : 'quota_exceeded',
    }),
  };
}

function makeService(opts: {
  ws?: any;
  parties?: any[];
  templateAvailable?: boolean;
  templateLanguage?: string;
  adapterSuccess?: boolean;
  partyConsentLogModel?: any;
  emailAdapter?: any;
  smsAdapter?: any;
  whatsAppAdapter?: any;
  events?: any;
  logModel?: any;
  reminderLogModel?: any;
  templates?: any;
}) {
  const partyModel = makeMockModel(opts.parties ?? []);
  const workspaceModel = makeMockModel(opts.ws ? [opts.ws] : []);
  const firmModel = makeMockModel([
    { _id: FIRM_ID, firmName: 'Acme Trading' },
  ]);
  const reminderLogModel =
    opts.reminderLogModel ?? makeMockModel();
  const logModel = opts.logModel ?? makeMockModel();
  const templates =
    opts.templates ??
    {
      getGreetingTemplate: vi.fn(async (_ws: string, kind: string, locale: string) =>
        opts.templateAvailable === false
          ? null
          : {
              eventType: kind,
              language: opts.templateLanguage ?? locale,
              subject: 'Wishing you a happy {occasion}, {contactName}!',
              body: 'Dear {contactName}, from {firmName}.',
            },
      ),
    };
  const emailAdapter = opts.emailAdapter ?? makeAdapter(opts.adapterSuccess !== false);
  const smsAdapter = opts.smsAdapter ?? makeAdapter(opts.adapterSuccess !== false);
  const whatsAppAdapter =
    opts.whatsAppAdapter ?? makeAdapter(opts.adapterSuccess !== false);
  const events = opts.events ?? { emit: vi.fn() };

  const svc = new GreetingsService(
    partyModel,
    workspaceModel,
    firmModel,
    reminderLogModel,
    logModel,
    templates,
    emailAdapter,
    smsAdapter,
    whatsAppAdapter,
    events,
  );
  return {
    svc,
    partyModel,
    workspaceModel,
    firmModel,
    reminderLogModel,
    logModel,
    templates,
    emailAdapter,
    smsAdapter,
    whatsAppAdapter,
    events,
  };
}

const partyId = PARTY_ID;
const contactId = CONTACT_ID;

function buildParty(overrides: Partial<any> = {}): any {
  return {
    _id: partyId,
    workspaceId: WS_ID,
    firmId: FIRM_ID,
    name: 'TestParty Pvt Ltd',
    isDeleted: false,
    consentLog: [],
    contacts: [
      {
        _id: contactId,
        name: 'Jay',
        phone: '9876543210',
        email: 'jay@example.com',
        // Today (mocked below) Apr 15.
        birthday: new Date(Date.UTC(1990, 3, 15)),
      },
    ],
    ...overrides,
  };
}

function buildWs(overrides: Partial<any> = {}): any {
  return {
    _id: WS_ID,
    name: 'Test WS',
    isActive: true,
    timezone: 'Asia/Kolkata',
    partyIntelligence: {
      greetings: { enabled: true, whatsapp: true, email: true, sms: true },
    },
    ...overrides,
  };
}

// ── Cron behavior ─────────────────────────────────────────────────────────

describe('GreetingsCron — tz filter', () => {
  it('1. shouldRunInWorkspaceNow returns true at local hour 9', () => {
    const cron = new GreetingsCron({} as any, {} as any);
    // 03:30 UTC = 09:00 IST.
    const t = new Date('2026-04-15T03:30:00Z');
    expect(cron.shouldRunInWorkspaceNow(t, 'Asia/Kolkata')).toBe(true);
  });

  it('1b. shouldRunInWorkspaceNow returns false at local hour 8', () => {
    const cron = new GreetingsCron({} as any, {} as any);
    const t = new Date('2026-04-15T02:30:00Z'); // 08:00 IST
    expect(cron.shouldRunInWorkspaceNow(t, 'Asia/Kolkata')).toBe(false);
  });

  it('1c. shouldRunInWorkspaceNow returns true at hour 9 in non-IST tz', () => {
    const cron = new GreetingsCron({} as any, {} as any);
    // 09:00 in America/New_York = 13:00 UTC.
    const t = new Date('2026-04-15T13:00:00Z');
    expect(cron.shouldRunInWorkspaceNow(t, 'America/New_York')).toBe(true);
  });
});

// ── selectGreetingsForToday master switch + identifier rules ──────────────

describe('GreetingsService — selectGreetingsForToday', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Apr 15 2026, 09:00 IST.
    vi.setSystemTime(new Date('2026-04-15T03:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('2. master switch OFF → returns []', async () => {
    const ws = buildWs({
      partyIntelligence: { greetings: { enabled: false } },
    });
    const { svc } = makeService({ ws, parties: [buildParty()] });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out).toEqual([]);
  });

  it('3. master ON + birthday match + has phone → whatsapp candidate', async () => {
    const ws = buildWs();
    const { svc } = makeService({ ws, parties: [buildParty()] });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe('whatsapp');
    expect(out[0].occasion).toBe('birthday');
  });

  it('4. contact.suppressGreetings=true → skipped', async () => {
    const ws = buildWs();
    const party = buildParty({
      contacts: [
        {
          _id: contactId,
          name: 'Jay',
          phone: '9876543210',
          email: 'jay@example.com',
          birthday: new Date(Date.UTC(1990, 3, 15)),
          suppressGreetings: true,
        },
      ],
    });
    const { svc } = makeService({ ws, parties: [party] });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out).toEqual([]);
  });

  it('5. consentLog whatsapp:false → falls through to email', async () => {
    const ws = buildWs();
    const party = buildParty({
      consentLog: [
        {
          channel: 'whatsapp',
          consented: false,
          timestamp: new Date('2026-04-01'),
        },
      ],
    });
    const { svc } = makeService({ ws, parties: [party] });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out[0].channel).toBe('email');
  });

  it('7. sub-toggle whatsapp=false → email priority', async () => {
    const ws = buildWs({
      partyIntelligence: {
        greetings: { enabled: true, whatsapp: false, email: true, sms: true },
      },
    });
    const { svc } = makeService({ ws, parties: [buildParty()] });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out[0].channel).toBe('email');
  });

  it('9. no email + no phone → silently skipped', async () => {
    const ws = buildWs();
    const party = buildParty({
      contacts: [
        {
          _id: contactId,
          name: 'Jay',
          birthday: new Date(Date.UTC(1990, 3, 15)),
        },
      ],
    });
    const { svc } = makeService({ ws, parties: [party] });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out).toEqual([]);
  });

  it('8. dedupe — alreadySentToday returns true → candidate dropped', async () => {
    const ws = buildWs();
    const dedupeRow = {
      workspaceId: new Types.ObjectId(WS_ID),
      partyId: new Types.ObjectId(partyId),
      contactId: new Types.ObjectId(contactId),
      occasion: 'birthday',
      todayDate: '2026-04-15',
    };
    const logModel = makeMockModel([dedupeRow]);
    // Override findOne to return the existing dedupe row.
    logModel.findOne = vi.fn(() => ({
      lean: () => Promise.resolve(dedupeRow),
    }));
    const { svc } = makeService({ ws, parties: [buildParty()], logModel });
    const out = await svc.selectGreetingsForToday(WS_ID, new Date());
    expect(out).toEqual([]);
  });
});

// ── dispatch happy/sad paths ──────────────────────────────────────────────

describe('GreetingsService — dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T03:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('3. success → adapter.send + dedupe-log + reminder-log + timeline emit', async () => {
    const ws = buildWs();
    const { svc, whatsAppAdapter, logModel, reminderLogModel, events } =
      makeService({ ws, parties: [buildParty()] });
    const candidate = {
      party: buildParty(),
      contact: buildParty().contacts[0],
      occasion: 'birthday' as const,
      channel: 'whatsapp' as const,
    };
    const ok = await svc.dispatch(candidate, ws, 'run-1');
    expect(ok).toBe(true);
    expect(whatsAppAdapter.send).toHaveBeenCalledTimes(1);
    expect(logModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        occasion: 'birthday',
        channel: 'whatsapp',
        status: 'sent',
        todayDate: '2026-04-15',
      }),
    );
    expect(reminderLogModel.create).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'party.timeline',
      expect.objectContaining({ type: 'greeting.sent' }),
    );
  });

  it('4. dedupe race — logModel.create throws E11000 → swallowed, returns true', async () => {
    const ws = buildWs();
    const logModel = makeMockModel();
    logModel.create = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 11000 }),
    );
    const { svc, whatsAppAdapter, events, reminderLogModel } = makeService({
      ws,
      parties: [buildParty()],
      logModel,
    });
    const candidate = {
      party: buildParty(),
      contact: buildParty().contacts[0],
      occasion: 'birthday' as const,
      channel: 'whatsapp' as const,
    };
    const ok = await svc.dispatch(candidate, ws, 'run-1');
    expect(ok).toBe(true);
    expect(whatsAppAdapter.send).toHaveBeenCalledTimes(1);
    // ReminderLog and timeline should NOT have been written after dup race.
    expect(reminderLogModel.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('5. adapter rejects → failed dedupe-log; no timeline; no reminder-log', async () => {
    const ws = buildWs();
    const { svc, logModel, reminderLogModel, events } = makeService({
      ws,
      parties: [buildParty()],
      adapterSuccess: false,
    });
    const candidate = {
      party: buildParty(),
      contact: buildParty().contacts[0],
      occasion: 'birthday' as const,
      channel: 'whatsapp' as const,
    };
    const ok = await svc.dispatch(candidate, ws, 'run-1');
    expect(ok).toBe(false);
    expect(logModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(reminderLogModel.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('6. locale resolution — preferredLocale=gu → gu template fetched', async () => {
    const ws = buildWs();
    const guParty = buildParty({ preferredLocale: 'gu' });
    const { svc, templates } = makeService({
      ws,
      parties: [guParty],
      templateLanguage: 'gu',
    });
    const candidate = {
      party: guParty,
      contact: guParty.contacts[0],
      occasion: 'birthday' as const,
      channel: 'whatsapp' as const,
    };
    await svc.dispatch(candidate, ws, 'run-1');
    expect(templates.getGreetingTemplate).toHaveBeenCalledWith(
      WS_ID,
      'birthday_greeting',
      'gu',
    );
  });

  it('default locale = en when preferredLocale missing', async () => {
    const ws = buildWs();
    const { svc, templates } = makeService({ ws, parties: [buildParty()] });
    const candidate = {
      party: buildParty(),
      contact: buildParty().contacts[0],
      occasion: 'birthday' as const,
      channel: 'whatsapp' as const,
    };
    await svc.dispatch(candidate, ws, 'run-1');
    expect(templates.getGreetingTemplate).toHaveBeenCalledWith(
      WS_ID,
      'birthday_greeting',
      'en',
    );
  });
});

