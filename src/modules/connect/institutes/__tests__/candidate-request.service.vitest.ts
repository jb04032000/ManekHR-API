/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// Stub @nestjs/mongoose BEFORE importing the service so the transitive schema
// imports (CandidateRequest / CompanyPage / User) skip vitest's reflect-metadata
// pipeline. Mirrors the canonical inquiry.service.vitest.ts pure-unit pattern.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

// Sentry-nestjs swallows errors with no transport; stub it so the create catch
// branch can run without spinning up the SDK.
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

import { Types } from 'mongoose';
import { CandidateRequestService } from '../candidate-request.service';

/**
 * Unit coverage for `CandidateRequestService` (Institutes Phase 2, Feature 4:
 * hiring-leads-to-inbox). Exercises:
 *   - the institute-only + public page gate (404 for business / non-public / missing);
 *   - the self-lead block (page owner cannot lead to their own institute);
 *   - the happy path: persists the CandidateRequest + seeds the inbox context
 *     thread (findOrCreateContextThread('CandidateRequest', id) +
 *     sendMessage(clientMsgId 'hirelead-<id>')) + audits + emits PostHog + bells;
 *   - the default first message when no pitch is supplied;
 *   - the notification survives a dispatch rejection (best-effort);
 *   - the status-sync OnEvent handler (institute owner read -> viewed, reply ->
 *     replied; the business actor is ignored; non-CandidateRequest events ignored).
 * Models + the audit / PostHog / notifications / inbox seams are mocked.
 */

const PAGE_ID = new Types.ObjectId();
const PAGE_OWNER = new Types.ObjectId();
const BUSINESS = new Types.ObjectId();

/** Fluent chain whose terminal `.exec()` resolves `result`. */
function chain(result: unknown) {
  const obj: any = {
    select: vi.fn(() => obj),
    sort: vi.fn(() => obj),
    skip: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    lean: vi.fn(() => obj),
    exec: vi.fn().mockResolvedValue(result),
  };
  return obj;
}

const institutePage = {
  _id: PAGE_ID,
  ownerUserId: PAGE_OWNER,
  kind: 'institute',
  visibility: 'public',
  name: 'Surat Zari Academy',
};

function build() {
  const candidateRequestModel: any = {
    create: vi.fn(),
    findById: vi.fn(),
  };
  const companyPageModel: any = {
    findOne: vi.fn(() => chain(institutePage)),
  };
  const userModel: any = {
    findById: vi.fn(() => chain({ name: 'Patel Textiles' })),
  };
  const audit: any = { logEvent: vi.fn().mockResolvedValue(undefined) };
  const posthog: any = { capture: vi.fn() };
  const notifications: any = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const inbox: any = {
    findOrCreateContextThread: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
  const service = new CandidateRequestService(
    candidateRequestModel,
    companyPageModel,
    userModel,
    audit,
    posthog,
    notifications,
    inbox,
  );
  return {
    service,
    candidateRequestModel,
    companyPageModel,
    userModel,
    audit,
    posthog,
    notifications,
    inbox,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('CandidateRequestService.create', () => {
  it('seeds the inbox context thread + the business message so the lead lands in the Inbox', async () => {
    const f = build();
    const leadId = new Types.ObjectId();
    f.candidateRequestModel.create.mockResolvedValue({
      _id: leadId,
      instituteOwnerUserId: PAGE_OWNER,
      message: 'Need 5 aari karigars',
    });

    await f.service.create(BUSINESS.toHexString(), PAGE_ID.toHexString(), 'Need 5 aari karigars');

    expect(f.inbox.findOrCreateContextThread).toHaveBeenCalledWith(
      BUSINESS.toHexString(),
      PAGE_OWNER.toHexString(),
      'CandidateRequest',
      leadId.toHexString(),
    );
    expect(f.inbox.sendMessage).toHaveBeenCalledWith(
      BUSINESS.toHexString(),
      expect.any(String),
      expect.objectContaining({
        body: 'Need 5 aari karigars',
        clientMsgId: `hirelead-${leadId.toHexString()}`,
      }),
    );
  });

  it('seeds a DEFAULT opening message when the business sends no pitch', async () => {
    const f = build();
    const leadId = new Types.ObjectId();
    f.candidateRequestModel.create.mockResolvedValue({
      _id: leadId,
      instituteOwnerUserId: PAGE_OWNER,
      message: '',
    });

    await f.service.create(BUSINESS.toHexString(), PAGE_ID.toHexString());

    expect(f.inbox.findOrCreateContextThread).toHaveBeenCalled();
    // A hire lead always seeds a first message (unlike a bare inquiry).
    const sendArg = f.inbox.sendMessage.mock.calls[0][2];
    expect(typeof sendArg.body).toBe('string');
    expect(sendArg.body.length).toBeGreaterThan(0);
    expect(sendArg.clientMsgId).toBe(`hirelead-${leadId.toHexString()}`);
  });

  it('throws NotFoundException when the page id is not a valid ObjectId', async () => {
    const f = build();
    await expect(f.service.create(BUSINESS.toHexString(), 'not-an-objectid')).rejects.toThrow(
      NotFoundException,
    );
    expect(f.companyPageModel.findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a non-institute (business) or non-public page', async () => {
    const f = build();
    // The gate query (kind:institute + visibility:public) returns null for a
    // business page / hidden page / missing page.
    f.companyPageModel.findOne = vi.fn(() => chain(null));
    await expect(f.service.create(BUSINESS.toHexString(), PAGE_ID.toHexString())).rejects.toThrow(
      NotFoundException,
    );
    // The gate query is institute + public.
    const filter = f.companyPageModel.findOne.mock.calls[0][0];
    expect(filter.kind).toBe('institute');
    expect(filter.visibility).toBe('public');
    expect(f.candidateRequestModel.create).not.toHaveBeenCalled();
  });

  it('blocks the page owner from sending a hire lead to their own institute', async () => {
    const f = build();
    await expect(
      f.service.create(PAGE_OWNER.toHexString(), PAGE_ID.toHexString()),
    ).rejects.toMatchObject({
      response: { code: 'CONNECT_SELF_HIRE_LEAD_NOT_ALLOWED' },
    });
    expect(f.candidateRequestModel.create).not.toHaveBeenCalled();
  });

  it('persists the lead + audits (connect_hire_lead_created) + emits PostHog on the happy path', async () => {
    const f = build();
    const created = {
      _id: new Types.ObjectId(),
      companyPageId: PAGE_ID,
      fromUserId: BUSINESS,
      instituteOwnerUserId: PAGE_OWNER,
      message: 'Interested',
      status: 'sent',
    };
    f.candidateRequestModel.create = vi.fn().mockResolvedValue(created);

    const result = await f.service.create(
      BUSINESS.toHexString(),
      PAGE_ID.toHexString(),
      'Interested',
    );

    expect(result).toBe(created);
    expect(f.candidateRequestModel.create).toHaveBeenCalledTimes(1);
    const createArg = f.candidateRequestModel.create.mock.calls[0][0];
    expect(createArg.message).toBe('Interested');
    expect(createArg.status).toBe('sent');
    expect(createArg.instituteOwnerUserId).toEqual(PAGE_OWNER);
    expect(f.audit.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'CandidateRequest',
        action: 'connect_hire_lead_created',
        actorId: BUSINESS.toHexString(),
      }),
    );
    expect(f.posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'connect.hire_lead_created',
        distinctId: BUSINESS.toHexString(),
      }),
    );
  });

  it('notifies the institute owner (connect.hire_lead_received) with the thread deep-link', async () => {
    const f = build();
    const created = {
      _id: new Types.ObjectId(),
      instituteOwnerUserId: PAGE_OWNER,
      message: 'Interested',
      status: 'sent',
    };
    f.candidateRequestModel.create = vi.fn().mockResolvedValue(created);
    const threadId = new Types.ObjectId();
    f.inbox.findOrCreateContextThread = vi.fn().mockResolvedValue({ _id: threadId });

    await f.service.create(BUSINESS.toHexString(), PAGE_ID.toHexString(), 'Interested');

    expect(f.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'connect.hire_lead_received',
        recipientId: PAGE_OWNER,
        actorId: BUSINESS,
        entityType: 'CandidateRequest',
        entityId: String(created._id),
        metadata: { threadId: threadId.toHexString() },
      }),
    );
    // The sender name + institute name land in the human message.
    const arg = f.notifications.dispatch.mock.calls[0][0];
    expect(arg.message).toContain('Patel Textiles');
    expect(arg.message).toContain('Surat Zari Academy');
  });

  it('still persists the lead when the notification dispatch rejects (best-effort)', async () => {
    const f = build();
    f.candidateRequestModel.create = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      instituteOwnerUserId: PAGE_OWNER,
      status: 'sent',
    });
    f.notifications.dispatch = vi.fn().mockRejectedValue(new Error('bell down'));

    await expect(
      f.service.create(BUSINESS.toHexString(), PAGE_ID.toHexString()),
    ).resolves.toBeTruthy();
  });

  it('still persists the lead when the inbox seed throws (best-effort)', async () => {
    const f = build();
    f.candidateRequestModel.create = vi.fn().mockResolvedValue({
      _id: new Types.ObjectId(),
      instituteOwnerUserId: PAGE_OWNER,
      status: 'sent',
    });
    f.inbox.findOrCreateContextThread = vi.fn().mockRejectedValue(new Error('inbox down'));

    await expect(
      f.service.create(BUSINESS.toHexString(), PAGE_ID.toHexString()),
    ).resolves.toBeTruthy();
    // dispatch still fires with no thread deep-link.
    expect(f.notifications.dispatch).toHaveBeenCalledTimes(1);
    expect(f.notifications.dispatch.mock.calls[0][0].metadata).toBeUndefined();
  });
});

describe('CandidateRequestService.onInboxThreadActivity (status sync)', () => {
  function leadDoc(status: string) {
    return {
      instituteOwnerUserId: PAGE_OWNER,
      fromUserId: BUSINESS,
      status,
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('moves sent -> viewed when the INSTITUTE OWNER opens the thread', async () => {
    const f = build();
    const doc = leadDoc('sent');
    f.candidateRequestModel.findById = vi.fn().mockResolvedValue(doc);
    await f.service.onInboxThreadActivity({
      contextEntityType: 'CandidateRequest',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(PAGE_OWNER),
      kind: 'read',
    });
    expect(doc.status).toBe('viewed');
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it('moves to replied when the INSTITUTE OWNER sends a message', async () => {
    const f = build();
    const doc = leadDoc('viewed');
    f.candidateRequestModel.findById = vi.fn().mockResolvedValue(doc);
    await f.service.onInboxThreadActivity({
      contextEntityType: 'CandidateRequest',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(PAGE_OWNER),
      kind: 'reply',
    });
    expect(doc.status).toBe('replied');
  });

  it('ignores the BUSINESS actor opening their own thread', async () => {
    const f = build();
    const doc = leadDoc('sent');
    f.candidateRequestModel.findById = vi.fn().mockResolvedValue(doc);
    await f.service.onInboxThreadActivity({
      contextEntityType: 'CandidateRequest',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(BUSINESS),
      kind: 'read',
    });
    expect(doc.status).toBe('sent');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('ignores an event for a different context entity type (no findById)', async () => {
    const f = build();
    f.candidateRequestModel.findById = vi.fn();
    await f.service.onInboxThreadActivity({
      contextEntityType: 'Inquiry',
      contextEntityId: new Types.ObjectId().toString(),
      actorId: String(PAGE_OWNER),
      kind: 'read',
    });
    expect(f.candidateRequestModel.findById).not.toHaveBeenCalled();
  });

  it('ignores an event whose contextEntityId is not a valid ObjectId (no findById)', async () => {
    const f = build();
    f.candidateRequestModel.findById = vi.fn();
    await f.service.onInboxThreadActivity({
      contextEntityType: 'CandidateRequest',
      contextEntityId: 'not-an-objectid',
      actorId: String(PAGE_OWNER),
      kind: 'read',
    });
    expect(f.candidateRequestModel.findById).not.toHaveBeenCalled();
  });
});
