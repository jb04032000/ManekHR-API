import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceRevocationService } from '../workspace-revocation/workspace-revocation.service';

describe('WorkspaceRevocationService', () => {
  let redis: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let svc: WorkspaceRevocationService;

  const wsId = 'ws-123';
  const userId = 'user-456';

  beforeEach(() => {
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    };
    svc = new WorkspaceRevocationService(redis as any);
  });

  describe('revoke', () => {
    it('writes the deny key with the default 24h TTL', async () => {
      await svc.revoke(wsId, userId);
      expect(redis.set).toHaveBeenCalledWith(
        `revoke:ws:${wsId}:user:${userId}`,
        '1',
        'EX',
        24 * 60 * 60,
      );
    });

    it('honours an explicit TTL override', async () => {
      await svc.revoke(wsId, userId, 60);
      expect(redis.set).toHaveBeenCalledWith(`revoke:ws:${wsId}:user:${userId}`, '1', 'EX', 60);
    });

    it('swallows Redis errors (fire-and-forget)', async () => {
      redis.set.mockRejectedValueOnce(new Error('redis down'));
      await expect(svc.revoke(wsId, userId)).resolves.toBeUndefined();
    });
  });

  describe('isRevoked', () => {
    it('returns true when the deny key exists', async () => {
      redis.get.mockResolvedValueOnce('1');
      expect(await svc.isRevoked(wsId, userId)).toBe(true);
      expect(redis.get).toHaveBeenCalledWith(`revoke:ws:${wsId}:user:${userId}`);
    });

    it('returns false when the deny key is missing', async () => {
      redis.get.mockResolvedValueOnce(null);
      expect(await svc.isRevoked(wsId, userId)).toBe(false);
    });

    it('returns false on Redis errors (fail-open — DB-backed status check still protects)', async () => {
      redis.get.mockRejectedValueOnce(new Error('redis down'));
      expect(await svc.isRevoked(wsId, userId)).toBe(false);
    });
  });

  describe('clear', () => {
    it('deletes the deny key', async () => {
      await svc.clear(wsId, userId);
      expect(redis.del).toHaveBeenCalledWith(`revoke:ws:${wsId}:user:${userId}`);
    });

    it('swallows Redis errors', async () => {
      redis.del.mockRejectedValueOnce(new Error('redis down'));
      await expect(svc.clear(wsId, userId)).resolves.toBeUndefined();
    });
  });
});
