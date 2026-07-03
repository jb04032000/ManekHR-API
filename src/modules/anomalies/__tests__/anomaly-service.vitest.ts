import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AnomaliesService } from '../anomalies.service';
import { AnomalyNotifyService } from '../anomaly-notify.service';

describe('AnomaliesService.record()', () => {
  let service: AnomaliesService;
  let anomalyModel: any;
  let ruleModel: any;
  let notifyService: any;

  const wsId = '60a0000000000000000000a1';

  beforeEach(() => {
    anomalyModel = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((doc) => Promise.resolve({ _id: 'anom1', ...doc })),
    };
    ruleModel = {
      findOne: vi.fn().mockResolvedValue({ enabled: true }),
    };
    notifyService = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const postHogStub = { capture: vi.fn() } as any;
    service = new AnomaliesService(anomalyModel, ruleModel, notifyService, postHogStub);
  });

  it('creates an Anomaly document when no duplicate exists', async () => {
    await service.record({
      wsId,
      ruleType: 'unknown_sn',
      severity: 'high',
      deviceSerial: 'SN-123',
      context: { serial: 'SN-123' },
      contextKey: 'SN-123',
    });
    expect(anomalyModel.create).toHaveBeenCalledTimes(1);
  });

  it('skips create when unknown_sn unacknowledged record already exists for same contextKey', async () => {
    anomalyModel.findOne.mockResolvedValueOnce({ _id: 'existing', acknowledged: false });
    await service.record({
      wsId,
      ruleType: 'unknown_sn',
      severity: 'high',
      deviceSerial: 'SN-123',
      context: { serial: 'SN-123' },
      contextKey: 'SN-123',
    });
    expect(anomalyModel.create).not.toHaveBeenCalled();
  });

  it('creates new unknown_sn anomaly when prior record is acknowledged', async () => {
    // findOne for de-dupe is filtered by acknowledged:false → returning null here means no unacknowledged dupe
    anomalyModel.findOne.mockResolvedValueOnce(null);
    await service.record({
      wsId,
      ruleType: 'unknown_sn',
      severity: 'high',
      deviceSerial: 'SN-123',
      context: { serial: 'SN-123' },
      contextKey: 'SN-123',
    });
    expect(anomalyModel.create).toHaveBeenCalledTimes(1);
  });

  it('skips when AnomalyRule.enabled=false', async () => {
    ruleModel.findOne.mockResolvedValueOnce({ enabled: false });
    await service.record({
      wsId,
      ruleType: 'rapid_dup',
      severity: 'high',
      context: {},
      contextKey: 'k',
    });
    expect(anomalyModel.create).not.toHaveBeenCalled();
  });

  it('triggers notify.dispatch exactly once after create', async () => {
    await service.record({
      wsId,
      ruleType: 'rapid_dup',
      severity: 'high',
      context: {},
      contextKey: 'k',
    });
    // Allow setImmediate microtask to flush
    await new Promise((r) => setImmediate(r));
    expect(notifyService.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not throw when notify.dispatch rejects (Pitfall 1)', async () => {
    notifyService.dispatch.mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.record({
        wsId,
        ruleType: 'rapid_dup',
        severity: 'high',
        context: {},
        contextKey: 'k',
      }),
    ).resolves.not.toThrow();
  });
});

describe('AnomalyNotifyService.dispatch()', () => {
  let notify: AnomalyNotifyService;
  let anomalyModel: any;
  let notificationsService: any;
  let mailService: any;
  let workspaceModel: any;
  let workspaceMemberModel: any;
  let userModel: any;

  const wsId = '60a0000000000000000000a1';

  const adminUsers = [
    { _id: 'u1', email: 'owner@a.com', name: 'Owner' },
    { _id: 'u2', email: 'admin@a.com', name: 'Admin' },
  ];

  beforeEach(() => {
    anomalyModel = {
      findOne: vi.fn().mockResolvedValue(null), // no prior email
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    notificationsService = { createNotification: vi.fn().mockResolvedValue(undefined) };
    mailService = { sendAnomalyAlertEmail: vi.fn().mockResolvedValue(undefined) };
    workspaceModel = {
      findById: vi.fn().mockReturnValue({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve({ _id: wsId, name: 'Acme', ownerId: 'u1' }),
          }),
        }),
      }),
    };
    workspaceMemberModel = {
      find: vi.fn().mockReturnValue({
        populate: () => ({
          populate: () => ({
            lean: () => ({
              exec: () =>
                Promise.resolve([
                  {
                    userId: { _id: 'u2', email: 'admin@a.com', name: 'Admin' },
                    // Fixed: manage_anomalies is the correct permission for the anomaly surface
                    roleId: {
                      permissions: [{ module: 'attendance', actions: ['manage_anomalies'] }],
                    },
                  },
                  {
                    userId: { _id: 'u3', email: 'viewer@a.com', name: 'Viewer' },
                    roleId: { permissions: [{ module: 'attendance', actions: ['view'] }] }, // filtered out
                  },
                ]),
            }),
          }),
        }),
      }),
    };
    userModel = {
      find: vi.fn().mockReturnValue({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(adminUsers) }) }),
      }),
    };
    notify = new AnomalyNotifyService(
      anomalyModel,
      notificationsService,
      mailService,
      workspaceModel,
      workspaceMemberModel,
      userModel,
    );
  });

  it('sends in-app notification to every resolved recipient', async () => {
    await notify.dispatch({
      _id: 'anom1',
      wsId,
      ruleType: 'rapid_dup',
      severity: 'high',
      context: {},
      contextKey: 'k',
    } as any);
    expect(notificationsService.createNotification).toHaveBeenCalledTimes(adminUsers.length);
  });

  it('sends email when no prior email for (wsId, ruleType, contextKey) in last 24h', async () => {
    await notify.dispatch({
      _id: 'anom1',
      wsId,
      ruleType: 'rapid_dup',
      severity: 'high',
      context: {},
      contextKey: 'k',
    } as any);
    expect(mailService.sendAnomalyAlertEmail).toHaveBeenCalledTimes(adminUsers.length);
  });

  it('skips email when prior emailDispatchedAt is within 24h for same (wsId, ruleType, contextKey)', async () => {
    anomalyModel.findOne.mockResolvedValueOnce({
      emailDispatchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
    });
    await notify.dispatch({
      _id: 'anom1',
      wsId,
      ruleType: 'rapid_dup',
      severity: 'high',
      context: {},
      contextKey: 'k',
    } as any);
    expect(mailService.sendAnomalyAlertEmail).not.toHaveBeenCalled();
    // In-app notification still fires (only email has de-dupe)
    expect(notificationsService.createNotification).toHaveBeenCalled();
  });

  it('updates anomaly.emailDispatchedAt after sending email', async () => {
    await notify.dispatch({
      _id: 'anom1',
      wsId,
      ruleType: 'rapid_dup',
      severity: 'high',
      context: {},
      contextKey: 'k',
    } as any);
    expect(anomalyModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'anom1' }),
      expect.objectContaining({
        $set: expect.objectContaining({ emailDispatchedAt: expect.any(Date) }),
      }),
    );
  });

  /**
   * Null-contextKey email dedup guard (Task 3 Step 7).
   *
   * When anomaly.contextKey is null, the prior code skipped the dedup query
   * entirely, allowing unbounded email sends. The fix always runs the dedup
   * query: when contextKey is null it groups on
   * {wsId, ruleType, contextKey:null, teamMemberId} — matching the
   * contextKey:null value the anomaly docs are stored with — so a missing
   * contextKey cannot cause email spam. (A synthetic string key would never
   * match the stored docs, so the query field/value matters here.)
   */
  it('dedupes email when contextKey is null — queries the null-contextKey group and suppresses', async () => {
    anomalyModel.findOne.mockResolvedValueOnce({
      emailDispatchedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
    });
    await notify.dispatch({
      _id: 'anom2',
      wsId,
      ruleType: 'unknown_sn',
      severity: 'high',
      context: {},
      contextKey: null, // null contextKey — the bug case
      teamMemberId: 'tm-7',
      createdAt: new Date(),
    } as any);
    // The dedup query MUST filter on contextKey:null + teamMemberId (not a
    // synthetic string) so it can match the stored null-contextKey docs.
    expect(anomalyModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        wsId,
        ruleType: 'unknown_sn',
        contextKey: null,
        teamMemberId: 'tm-7',
        emailDispatchedAt: expect.objectContaining({ $gte: expect.any(Date) }),
      }),
    );
    // Email must be suppressed — prior dispatch found within 24h.
    expect(mailService.sendAnomalyAlertEmail).not.toHaveBeenCalled();
    // In-app notification still fires.
    expect(notificationsService.createNotification).toHaveBeenCalled();
  });

  it('sends email when contextKey is null and no prior email within 24h', async () => {
    // findOne returns null → no prior email, dispatch proceeds
    anomalyModel.findOne.mockResolvedValueOnce(null);
    await notify.dispatch({
      _id: 'anom3',
      wsId,
      ruleType: 'unknown_sn',
      severity: 'high',
      context: {},
      contextKey: null,
      teamMemberId: null,
      createdAt: new Date(),
    } as any);
    expect(mailService.sendAnomalyAlertEmail).toHaveBeenCalledTimes(adminUsers.length);
  });

  it('resolveAdminRecipients scopes by wsId (does not return members of a different workspace)', async () => {
    // The workspaceMemberModel.find should be called with a filter containing workspaceId (ObjectId).
    const recipients = await notify.resolveAdminRecipients(wsId);
    expect(workspaceMemberModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: expect.anything() }),
      expect.anything(),
    );
    expect(recipients).not.toBeNull();
  });

  it('resolveAdminRecipients filters members to those with attendance.manage_anomalies permission', async () => {
    const recipients = await notify.resolveAdminRecipients(wsId);
    // Owner + Admin only (Viewer excluded); Admin has manage_anomalies not manage_devices
    expect(recipients.length).toBe(2);
    expect(recipients.map((r: any) => r._id).sort()).toEqual(['u1', 'u2']);
  });

  it('resolveAdminRecipients always includes workspace owner', async () => {
    // Simulate owner has NO role permissions but is still workspace.ownerId
    workspaceMemberModel.find.mockReturnValueOnce({
      populate: () => ({
        populate: () => ({
          lean: () => ({
            exec: () => Promise.resolve([]),
          }),
        }),
      }),
    });
    userModel.find.mockReturnValueOnce({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve([{ _id: 'u1', email: 'owner@a.com', name: 'Owner' }]),
        }),
      }),
    });
    const recipients = await notify.resolveAdminRecipients(wsId);
    expect(recipients.some((r: any) => r._id === 'u1')).toBe(true);
  });
});

describe('AnomaliesService.acknowledge() + count24h()', () => {
  let service: AnomaliesService;
  let anomalyModel: any;

  const wsId = '60a0000000000000000000a1';
  const other = '60a0000000000000000000a2';

  beforeEach(() => {
    anomalyModel = {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      countDocuments: vi.fn().mockResolvedValue(7),
    };
    service = new AnomaliesService(
      anomalyModel,
      { findOne: vi.fn().mockResolvedValue({ enabled: true }) } as any,
      { dispatch: vi.fn() } as any,
      { capture: vi.fn() } as any,
    );
  });

  it('acknowledge sets acknowledged=true, acknowledgedBy, acknowledgedAt', async () => {
    const anomalyOid = '60a0000000000000000000b1';
    anomalyModel.findOneAndUpdate.mockResolvedValueOnce({ _id: anomalyOid, acknowledged: true });
    await service.acknowledge(wsId, anomalyOid, 'userX');
    expect(anomalyModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.anything(), wsId: expect.anything() }),
      expect.objectContaining({
        $set: expect.objectContaining({
          acknowledged: true,
          acknowledgedBy: expect.anything(),
          acknowledgedAt: expect.any(Date),
        }),
      }),
      expect.anything(),
    );
  });

  it('acknowledge throws when the anomaly belongs to another workspace', async () => {
    const anomalyOid = '60a0000000000000000000b1';
    anomalyModel.findOneAndUpdate.mockResolvedValueOnce(null); // filter wsId mismatch => nothing matched
    await expect(service.acknowledge(other, anomalyOid, 'userX')).rejects.toThrow();
  });

  it('count24h returns countDocuments filtered by wsId + acknowledged:false + createdAt>=now-24h', async () => {
    const count = await service.count24h(wsId);
    expect(count).toBe(7);
    expect(anomalyModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        wsId: expect.anything(),
        acknowledged: false,
        createdAt: expect.objectContaining({ $gte: expect.any(Date) }),
      }),
    );
  });
});
