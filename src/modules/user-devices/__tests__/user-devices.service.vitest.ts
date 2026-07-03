import { describe, it, expect, vi } from 'vitest';
import { UserDevicesService } from '../user-devices.service';

// `listWebDevices` wraps userId in `new Types.ObjectId(...)`, which throws on a
// non-24-char-hex string, so the user id literal must be a valid ObjectId.
const USER_ID = '6651f0a1b2c3d4e5f6a7b8c9';

// Minimal model + push-adapter doubles. We only exercise pushUserWeb's filter
// + fan-out contract, not Mongoose internals.
function makeService(webTokens: string[], otherTokens: string[]) {
  const docs = [
    ...webTokens.map((fcmToken) => ({ fcmToken, platform: 'web' })),
    ...otherTokens.map((fcmToken) => ({ fcmToken, platform: 'android' })),
  ];
  // find({ userId, platform:'web' }) -> only web docs
  const deviceModel = {
    find: vi.fn((q: any) => ({
      sort: () => ({
        exec: () =>
          Promise.resolve(q.platform === 'web' ? docs.filter((d) => d.platform === 'web') : docs),
      }),
    })),
    deleteMany: vi.fn(() => ({ exec: () => Promise.resolve({ deletedCount: 0 }) })),
  };
  const push = {
    sendUserPush: vi.fn(() => Promise.resolve({ success: true, messageId: 'm1' })),
  };
  return {
    svc: new UserDevicesService(deviceModel as any, push as any),
    push,
  };
}

describe('UserDevicesService.pushUserWeb', () => {
  it('sends only to web-platform tokens', async () => {
    const { svc, push } = makeService(['web-a', 'web-b'], ['android-c']);
    const res = await svc.pushUserWeb(USER_ID, { title: 'T', body: 'B' });
    expect(push.sendUserPush).toHaveBeenCalledTimes(2);
    const sentTokens = push.sendUserPush.mock.calls.map((c: any[]) => c[0].token).sort();
    expect(sentTokens).toEqual(['web-a', 'web-b']);
    expect(res).toEqual({ attempted: 2, sent: 2, pruned: 0 });
  });

  it('returns a zero result when the user has no web devices', async () => {
    const { svc, push } = makeService([], ['android-c']);
    const res = await svc.pushUserWeb(USER_ID, { title: 'T', body: 'B' });
    expect(push.sendUserPush).not.toHaveBeenCalled();
    expect(res).toEqual({ attempted: 0, sent: 0, pruned: 0 });
  });
});
