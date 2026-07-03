/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { InboxGateway, INBOX_MAX_SOCKETS_PER_USER } from '../inbox.gateway';

function mkClient(ticket: string | null) {
  return {
    handshake: { auth: ticket ? { ticket } : {}, query: {} },
    data: {} as Record<string, unknown>,
    join: vi.fn(),
    disconnect: vi.fn(),
  };
}

function mkGateway(sub: string | null = 'u1') {
  const jwt: any = {
    verify: vi.fn(() => {
      if (sub === null) throw new Error('bad ticket');
      return { sub };
    }),
  };
  return new InboxGateway(jwt);
}

describe('InboxGateway connection hardening (I6)', () => {
  it('rejects a socket with no ticket', () => {
    const gw = mkGateway();
    const c = mkClient(null);
    gw.handleConnection(c as any);
    expect(c.disconnect).toHaveBeenCalledWith(true);
    expect(c.join).not.toHaveBeenCalled();
  });

  it('rejects an invalid / wrong-audience ticket', () => {
    const gw = mkGateway(null); // jwt.verify throws
    const c = mkClient('forged');
    gw.handleConnection(c as any);
    expect(c.disconnect).toHaveBeenCalledWith(true);
    expect(c.join).not.toHaveBeenCalled();
  });

  it('joins the user room and tracks the connection on a valid ticket', () => {
    const gw = mkGateway('u1');
    const c = mkClient('t');
    gw.handleConnection(c as any);
    expect(c.join).toHaveBeenCalledWith('user:u1');
    expect(gw.getStats()).toMatchObject({ activeConnections: 1, distinctUsers: 1 });
  });

  it('caps sockets per user on this instance and rejects beyond the cap', () => {
    const gw = mkGateway('u1');
    for (let i = 0; i < INBOX_MAX_SOCKETS_PER_USER; i += 1) {
      gw.handleConnection(mkClient('t') as any);
    }
    expect(gw.getStats().activeConnections).toBe(INBOX_MAX_SOCKETS_PER_USER);

    const over = mkClient('t');
    gw.handleConnection(over as any);
    expect(over.disconnect).toHaveBeenCalledWith(true);
    expect(over.join).not.toHaveBeenCalled();
    expect(gw.getStats().rejectedConnections).toBe(1);
    expect(gw.getStats().activeConnections).toBe(INBOX_MAX_SOCKETS_PER_USER);
  });

  it('frees a slot on disconnect', () => {
    const gw = mkGateway('u1');
    const c = mkClient('t');
    gw.handleConnection(c as any);
    expect(gw.getStats().activeConnections).toBe(1);
    gw.handleDisconnect(c as any);
    expect(gw.getStats()).toMatchObject({ activeConnections: 0, distinctUsers: 0 });
  });

  it('counts a dropped emit when the adapter throws (never bubbles)', () => {
    const gw = mkGateway();
    (gw as any).server = {
      to: () => {
        throw new Error('adapter down');
      },
    };
    expect(() =>
      gw.emitMessage(['u1'], {
        threadId: 't',
        messageId: 'm',
        senderUserId: 'u2',
        kind: 'text',
        body: 'hi',
        seq: 1,
        createdAt: '',
      }),
    ).not.toThrow();
    expect(gw.getStats().droppedEmits).toBe(1);
  });
});
