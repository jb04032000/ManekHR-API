/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

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

import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AccountsService } from '../accounts.service';

function makeService(existing: any) {
  const model: any = {
    findOne: vi.fn(() => ({ exec: () => Promise.resolve(existing) })),
    findOneAndUpdate: vi.fn(() => ({
      exec: () => Promise.resolve({ ...existing, name: 'updated' }),
    })),
  };
  return { svc: new AccountsService(model), model };
}

const ws = new Types.ObjectId().toString();
const firm = new Types.ObjectId().toString();
const acc = new Types.ObjectId().toString();

// P0.1: a system account's code/type drive findByCode postings + report grouping; re-coding one
// bricks the books. update() must block those fields on system accounts (name still editable).
describe('AccountsService.update system-account guard', () => {
  it('rejects a code change on a system account (and does not write)', async () => {
    const { svc, model } = makeService({ code: '1001', type: 'asset', isSystem: true });
    await expect(svc.update(ws, firm, acc, { code: '9999' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a type change on a system account', async () => {
    const { svc } = makeService({ code: '1001', type: 'asset', isSystem: true });
    await expect(svc.update(ws, firm, acc, { type: 'expense' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a name change on a system account', async () => {
    const { svc, model } = makeService({ code: '1001', type: 'asset', isSystem: true });
    await svc.update(ws, firm, acc, { name: 'Cash in Hand' });
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('allows a code change on a NON-system account', async () => {
    const { svc, model } = makeService({ code: '4100', type: 'income', isSystem: false });
    await svc.update(ws, firm, acc, { code: '4200' });
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
