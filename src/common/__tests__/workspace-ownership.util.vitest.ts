import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { isWorkspaceOwner, isWorkspaceOwnerById } from '../utils/workspace-ownership.util';

describe('isWorkspaceOwner', () => {
  const ownerId = new Types.ObjectId();
  const otherId = new Types.ObjectId();

  it('returns true when ownerId === userId (both ObjectId)', () => {
    expect(isWorkspaceOwner({ ownerId }, ownerId)).toBe(true);
  });

  it('returns true when ownerId === userId (string vs ObjectId)', () => {
    expect(isWorkspaceOwner({ ownerId }, ownerId.toString())).toBe(true);
  });

  it('returns true when ownerId === userId (both strings)', () => {
    expect(isWorkspaceOwner({ ownerId: ownerId.toString() }, ownerId.toString())).toBe(true);
  });

  it('returns false when ownerId !== userId', () => {
    expect(isWorkspaceOwner({ ownerId }, otherId)).toBe(false);
  });

  it('returns false when workspace is null', () => {
    expect(isWorkspaceOwner(null, ownerId)).toBe(false);
  });

  it('returns false when workspace is undefined', () => {
    expect(isWorkspaceOwner(undefined, ownerId)).toBe(false);
  });

  it('returns false when ownerId is null', () => {
    expect(isWorkspaceOwner({ ownerId: null }, ownerId)).toBe(false);
  });

  it('returns false when ownerId is undefined', () => {
    expect(isWorkspaceOwner({}, ownerId)).toBe(false);
  });

  it('returns false when userId is null', () => {
    expect(isWorkspaceOwner({ ownerId }, null)).toBe(false);
  });

  it('returns false when userId is undefined', () => {
    expect(isWorkspaceOwner({ ownerId }, undefined)).toBe(false);
  });
});

describe('isWorkspaceOwnerById', () => {
  const wsId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const otherId = new Types.ObjectId();

  function makeModel(workspace: { ownerId: Types.ObjectId } | null) {
    return {
      findById: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue(workspace),
      }),
    };
  }

  it('returns true when fetched workspace owner matches userId', async () => {
    const model = makeModel({ ownerId });
    expect(await isWorkspaceOwnerById(model, wsId, ownerId)).toBe(true);
    expect(model.findById).toHaveBeenCalledWith(wsId);
  });

  it('returns false when fetched workspace owner does not match', async () => {
    const model = makeModel({ ownerId });
    expect(await isWorkspaceOwnerById(model, wsId, otherId)).toBe(false);
  });

  it('returns false when workspace is not found', async () => {
    const model = makeModel(null);
    expect(await isWorkspaceOwnerById(model, wsId, ownerId)).toBe(false);
  });

  it('returns false when workspaceId is null without DB call', async () => {
    const model = makeModel({ ownerId });
    expect(await isWorkspaceOwnerById(model, null, ownerId)).toBe(false);
    expect(model.findById).not.toHaveBeenCalled();
  });

  it('returns false when userId is null without DB call', async () => {
    const model = makeModel({ ownerId });
    expect(await isWorkspaceOwnerById(model, wsId, null)).toBe(false);
    expect(model.findById).not.toHaveBeenCalled();
  });
});
