import { describe, it, expect } from 'vitest';
import { resolveCorsOrigin } from '../cors-origin';

describe('resolveCorsOrigin', () => {
  it('is fully open (true) in non-production for dev convenience, even if origins are set', () => {
    expect(
      resolveCorsOrigin({
        nodeEnv: 'development',
        allowedOrigins: ['https://x'],
        knownWebUrls: [],
      }),
    ).toBe(true);
    expect(resolveCorsOrigin({ nodeEnv: 'test', allowedOrigins: [], knownWebUrls: [] })).toBe(true);
  });

  it('locks production to the explicit allowlist when CORS_ALLOWED_ORIGINS is set', () => {
    const out = resolveCorsOrigin({
      nodeEnv: 'production',
      allowedOrigins: ['https://app.crewroster.app', 'https://www.crewroster.app'],
      knownWebUrls: ['https://ignored.example'],
    });
    expect(out).toEqual(['https://app.crewroster.app', 'https://www.crewroster.app']);
  });

  it('falls back to the app-configured web URLs in production when no explicit allowlist is set', () => {
    const out = resolveCorsOrigin({
      nodeEnv: 'production',
      allowedOrigins: [],
      knownWebUrls: ['https://app.crewroster.app', '', 'https://app.crewroster.app/'],
    });
    // deduped + trailing slash stripped
    expect(out).toEqual(['https://app.crewroster.app']);
  });

  it('fails closed (false = no cross-origin) in production when nothing is configured', () => {
    expect(resolveCorsOrigin({ nodeEnv: 'production', allowedOrigins: [], knownWebUrls: [] })).toBe(
      false,
    );
    expect(
      resolveCorsOrigin({ nodeEnv: 'production', allowedOrigins: ['', '  '], knownWebUrls: [''] }),
    ).toBe(false);
  });

  it('strips trailing slashes and de-duplicates the explicit allowlist', () => {
    const out = resolveCorsOrigin({
      nodeEnv: 'production',
      allowedOrigins: ['https://a.com/', 'https://a.com', 'https://b.com'],
      knownWebUrls: [],
    });
    expect(out).toEqual(['https://a.com', 'https://b.com']);
  });
});
