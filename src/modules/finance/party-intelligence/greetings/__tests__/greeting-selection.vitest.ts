/**
 * Phase 17 / FIN-16-05 — GreetingsService unit tests (executable body).
 *
 * Tests the pure selection helpers in isolation (pickChannel, matchOccasion,
 * latestConsentByChannel, todayDateInTz, monthDayInTz). The full
 * selectGreetingsForToday flow is covered by the integration test colocated
 * at greetings-dispatch.vitest.ts.
 */

import { describe, it, expect } from 'vitest';
import { GreetingsService } from '../greetings.service';

// Build a bare service instance with stubbed deps — only pure helpers tested.
function svc(): GreetingsService {
  return new GreetingsService(
    {} as any, // partyModel
    {} as any, // workspaceModel
    {} as any, // firmModel
    {} as any, // reminderLogModel
    {} as any, // logModel
    {} as any, // templates
    {} as any, // emailAdapter
    {} as any, // smsAdapter
    {} as any, // whatsAppAdapter
    {} as any, // events
  );
}

describe('GreetingsService — selection helpers', () => {
  const s = svc();

  // Test 7: per-channel sub-toggle whatsapp=false → email becomes priority.
  it('1. pickChannel — sub-toggle whatsapp=false demotes whatsapp to email', () => {
    const contact = { phone: '9876543210', email: 'a@b.com' };
    const consent = new Map();
    const ch = s.pickChannel(contact, consent, {
      whatsapp: false,
      email: true,
      sms: true,
    });
    expect(ch).toBe('email');
  });

  // Test 2: birthday match AND has email → email channel (no whatsapp identifier).
  it('2. pickChannel — only email available → email', () => {
    const contact = { email: 'a@b.com' };
    const consent = new Map();
    const ch = s.pickChannel(contact, consent, {
      whatsapp: true,
      email: true,
      sms: true,
    });
    expect(ch).toBe('email');
  });

  // Test 3: phone present → whatsapp channel (priority).
  it('3. pickChannel — phone present → whatsapp wins', () => {
    const contact = { phone: '9876543210', email: 'a@b.com' };
    const consent = new Map();
    const ch = s.pickChannel(contact, consent, {
      whatsapp: true,
      email: true,
      sms: true,
    });
    expect(ch).toBe('whatsapp');
  });

  // Test 5: consentLog whatsapp consented:false → falls through to email.
  it('5. pickChannel — consentLog whatsapp=false falls through to email', () => {
    const contact = { phone: '9876543210', email: 'a@b.com' };
    const consent = new Map<string, boolean>([['whatsapp', false]]);
    const ch = s.pickChannel(contact, consent as any, {
      whatsapp: true,
      email: true,
      sms: true,
    });
    expect(ch).toBe('email');
  });

  // Test 9: no email + no phone → null (silently skipped at caller).
  it('9. pickChannel — no identifier → null', () => {
    const contact = {};
    const consent = new Map();
    const ch = s.pickChannel(contact, consent, {
      whatsapp: true,
      email: true,
      sms: true,
    });
    expect(ch).toBeNull();
  });

  // Test 6: anniversary Feb-29 on non-leap year → match on Feb-28.
  it('6. matchOccasion — Feb-29 anniversary on non-leap year matches Feb-28', () => {
    const contact = {
      anniversary: new Date(Date.UTC(2020, 1, 29)), // Feb 29 2020
    };
    // Today = Feb 28, 2026 (non-leap)
    const monthDay = { month: 2, day: 28, isLeapYear: false };
    expect(s.matchOccasion(contact, monthDay)).toBe('anniversary');
  });

  it('6b. matchOccasion — Feb-29 anniversary on leap year matches Feb-29', () => {
    const contact = {
      anniversary: new Date(Date.UTC(2020, 1, 29)),
    };
    const monthDay = { month: 2, day: 29, isLeapYear: true };
    expect(s.matchOccasion(contact, monthDay)).toBe('anniversary');
  });

  it('6c. matchOccasion — Feb-29 anniversary does NOT match March-1 on non-leap', () => {
    const contact = {
      anniversary: new Date(Date.UTC(2020, 1, 29)),
    };
    const monthDay = { month: 3, day: 1, isLeapYear: false };
    expect(s.matchOccasion(contact, monthDay)).toBeNull();
  });

  it('matchOccasion — birthday match returns birthday', () => {
    const contact = { birthday: new Date(Date.UTC(1990, 5, 15)) };
    const monthDay = { month: 6, day: 15, isLeapYear: false };
    expect(s.matchOccasion(contact, monthDay)).toBe('birthday');
  });

  it('matchOccasion — no match returns null', () => {
    const contact = { birthday: new Date(Date.UTC(1990, 5, 15)) };
    const monthDay = { month: 6, day: 16, isLeapYear: false };
    expect(s.matchOccasion(contact, monthDay)).toBeNull();
  });

  it('latestConsentByChannel — picks the most recent entry per channel', () => {
    const log = [
      {
        channel: 'whatsapp',
        consented: true,
        timestamp: new Date('2026-01-01'),
      },
      {
        channel: 'whatsapp',
        consented: false,
        timestamp: new Date('2026-04-01'),
      },
      { channel: 'email', consented: true, timestamp: new Date('2026-01-01') },
    ];
    const res = s.latestConsentByChannel(log);
    expect(res.get('whatsapp')).toBe(false);
    expect(res.get('email')).toBe(true);
  });

  it('todayDateInTz — formats YYYY-MM-DD in workspace tz', () => {
    // 2026-04-15 18:00 UTC in Asia/Kolkata = 2026-04-15 23:30 → still Apr 15.
    const t = new Date('2026-04-15T18:00:00Z');
    expect(s.todayDateInTz(t, 'Asia/Kolkata')).toBe('2026-04-15');
  });

  it('todayDateInTz — date-line crossing example', () => {
    // 2026-04-15 22:00 UTC = 2026-04-16 03:30 IST.
    const t = new Date('2026-04-15T22:00:00Z');
    expect(s.todayDateInTz(t, 'Asia/Kolkata')).toBe('2026-04-16');
  });

  it('resolveLocale — defaults to en when preferredLocale missing', () => {
    expect(s.resolveLocale({})).toBe('en');
    expect(s.resolveLocale({ preferredLocale: 'gu' })).toBe('gu');
    expect(s.resolveLocale({ preferredLocale: 'INVALID' })).toBe('en');
  });

  it('applyVars — substitutes {var} placeholders, missing → empty', () => {
    const out = s.applyVars(
      'Dear {contactName}, from {firmName}. {missing}',
      { contactName: 'Jay', firmName: 'Acme' },
    );
    expect(out).toBe('Dear Jay, from Acme. ');
  });
});

// Tests 1, 4, 8 — master switch OFF, suppressGreetings, dedupe — are covered
// in the integration test (require Mongo + full service wiring). See
// greetings-dispatch.vitest.ts for those cases.
