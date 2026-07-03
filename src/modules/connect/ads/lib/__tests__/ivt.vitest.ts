import { describe, it, expect } from 'vitest';
import { classifyClick, isBotUserAgent, IVT_DAILY_CLICK_CAP, type ClickSignals } from '../ivt';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function signals(overrides: Partial<ClickSignals> = {}): ClickSignals {
  return {
    clickerUserId: 'viewer-1',
    ownerUserId: 'advertiser-9',
    userAgent: BROWSER_UA,
    recentClickCount: 0,
    dailyClickCount: 0,
    ...overrides,
  };
}

describe('isBotUserAgent', () => {
  it('treats a normal browser UA as not-bot', () => {
    expect(isBotUserAgent(BROWSER_UA)).toBe(false);
  });

  it('treats missing / empty UA as bot-typical', () => {
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent('   ')).toBe(true);
  });

  it.each([
    'Googlebot/2.1',
    'curl/8.4.0',
    'python-requests/2.31',
    'Headless Chrome',
    'Go-http-client/1.1',
  ])('flags bot-like UA: %s', (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });
});

describe('classifyClick', () => {
  it('returns valid for a clean human click', () => {
    expect(classifyClick(signals())).toEqual({ valid: true });
  });

  it('invalidates a self-click (clicker is the campaign owner)', () => {
    expect(
      classifyClick(signals({ clickerUserId: 'advertiser-9', ownerUserId: 'advertiser-9' })),
    ).toEqual({
      valid: false,
      reason: 'self_click',
    });
  });

  it('invalidates a bot user-agent', () => {
    expect(classifyClick(signals({ userAgent: 'Googlebot/2.1' }))).toEqual({
      valid: false,
      reason: 'bot_ua',
    });
  });

  it('invalidates a missing user-agent', () => {
    expect(classifyClick(signals({ userAgent: undefined }))).toEqual({
      valid: false,
      reason: 'bot_ua',
    });
  });

  it('invalidates a rapid duplicate (>=1 prior click in the dedupe window)', () => {
    expect(classifyClick(signals({ recentClickCount: 1 }))).toEqual({
      valid: false,
      reason: 'rapid_duplicate',
    });
  });

  it('invalidates once the daily cap is reached', () => {
    expect(classifyClick(signals({ dailyClickCount: IVT_DAILY_CLICK_CAP }))).toEqual({
      valid: false,
      reason: 'daily_cap',
    });
  });

  it('allows clicks below the daily cap with no recent duplicate', () => {
    expect(classifyClick(signals({ dailyClickCount: IVT_DAILY_CLICK_CAP - 1 }))).toEqual({
      valid: true,
    });
  });

  it('precedence: self-click beats every other signal', () => {
    expect(
      classifyClick(
        signals({
          clickerUserId: 'advertiser-9',
          ownerUserId: 'advertiser-9',
          userAgent: 'curl/8',
          recentClickCount: 5,
          dailyClickCount: 99,
        }),
      ),
    ).toEqual({ valid: false, reason: 'self_click' });
  });
});
