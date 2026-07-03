import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Msg91WidgetOtpService } from '../msg91-widget-otp.service';

describe('Msg91WidgetOtpService', () => {
  let svc: Msg91WidgetOtpService;
  const fetchMock = vi.fn();

  beforeEach(() => {
    svc = new Msg91WidgetOtpService();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('returns the verified mobile on a success response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'success', message: '919876543210' }),
    });

    const result = await svc.verifyAccessToken('some-access-token');

    expect(result).toEqual({ mobile: '919876543210' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://control.msg91.com/api/v5/widget/verifyAccessToken',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: expect.stringContaining('"access-token":"some-access-token"'),
      }),
    );
  });

  it('returns null on a failure-type response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'error', message: 'Invalid access token' }),
    });

    const result = await svc.verifyAccessToken('bad-token');

    expect(result).toBeNull();
  });

  it('returns null when the HTTP call itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await svc.verifyAccessToken('some-token');

    expect(result).toBeNull();
  });
});
