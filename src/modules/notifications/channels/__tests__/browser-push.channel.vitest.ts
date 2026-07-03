import { describe, it, expect, vi } from 'vitest';
import { BrowserPushChannel } from '../browser-push.channel';
import type { ChannelSendInput } from '../notification-channel.interface';

function sendInput(over: Partial<ChannelSendInput> = {}): ChannelSendInput {
  return {
    notificationId: 'n1',
    recipientId: 'u1',
    category: 'connect.message_received',
    title: 'New message',
    message: 'Hi there',
    actorId: 'a1',
    aggregatedCount: 1,
    entityType: 'inbox_thread',
    entityId: 't1',
    metadata: null,
    ...over,
  };
}

describe('BrowserPushChannel', () => {
  it('isAvailable = true when the user has web devices', async () => {
    const devices = { listWebDevices: vi.fn(() => Promise.resolve([{ fcmToken: 'web-a' }])) };
    const ch = new BrowserPushChannel(devices as any);
    expect(await ch.isAvailable('u1')).toBe(true);
  });

  it('isAvailable = false when the user has no web devices', async () => {
    const devices = { listWebDevices: vi.fn(() => Promise.resolve([])) };
    const ch = new BrowserPushChannel(devices as any);
    expect(await ch.isAvailable('u1')).toBe(false);
  });

  it('send fans out via pushUserWeb with title, message and deep-link data', async () => {
    const devices = {
      listWebDevices: vi.fn(() => Promise.resolve([{ fcmToken: 'web-a' }])),
      pushUserWeb: vi.fn(() => Promise.resolve({ attempted: 1, sent: 1, pruned: 0 })),
    };
    const ch = new BrowserPushChannel(devices as any);
    await ch.send(sendInput());
    expect(devices.pushUserWeb).toHaveBeenCalledWith('u1', {
      title: 'New message',
      body: 'Hi there',
      data: {
        notificationId: 'n1',
        category: 'connect.message_received',
        link: '/connect/notifications',
      },
    });
  });

  it('send prefers an explicit metadata.link when present', async () => {
    const devices = {
      listWebDevices: vi.fn(() => Promise.resolve([{ fcmToken: 'web-a' }])),
      pushUserWeb: vi.fn(() => Promise.resolve({ attempted: 1, sent: 1, pruned: 0 })),
    };
    const ch = new BrowserPushChannel(devices as any);
    await ch.send(sendInput({ metadata: { link: '/dashboard/finance' } }));
    expect(devices.pushUserWeb).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ data: expect.objectContaining({ link: '/dashboard/finance' }) }),
    );
  });
});
