/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose BEFORE importing the controller so that the transitive
// schema imports don't trip vitest's reflect-metadata pipeline under esbuild.
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

import { BadRequestException } from '@nestjs/common';
import { AnomaliesController } from '../anomalies.controller';

/**
 * AnomaliesController.toggleRule — 400 path coverage (Task 3 Steps 8-9).
 *
 * The implementation at anomalies.controller.ts:122-124 already throws
 * BadRequestException('invalid_rule_type') when the :ruleType param is not
 * in ALL_RULE_TYPES. This test exists solely to backfill that coverage.
 *
 * The controller is NOT modified — only a unit test is added.
 */
describe('AnomaliesController.toggleRule', () => {
  let controller: AnomaliesController;
  let ruleModel: any;
  let anomaliesService: any;

  beforeEach(() => {
    ruleModel = {
      find: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      findOneAndUpdate: vi.fn(),
    };
    anomaliesService = {
      list: vi.fn(),
      acknowledge: vi.fn(),
      count24h: vi.fn(),
    };
    // Direct construction: InjectModel is a no-op decorator under the mock,
    // so the constructor receives (anomaliesService, ruleModel) positionally.
    controller = new AnomaliesController(anomaliesService, ruleModel);
  });

  it('throws BadRequestException("invalid_rule_type") when ruleType is not in ALL_RULE_TYPES', async () => {
    await expect(
      controller.toggleRule('ws-123', 'binding_conflict', { enabled: false } as any),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.toggleRule('ws-123', 'binding_conflict', { enabled: false } as any),
    ).rejects.toThrow('invalid_rule_type');
  });

  it('throws BadRequestException("invalid_rule_type") for locked_payroll_push', async () => {
    await expect(
      controller.toggleRule('ws-123', 'locked_payroll_push', { enabled: true } as any),
    ).rejects.toThrow('invalid_rule_type');
  });

  it('throws BadRequestException("invalid_rule_type") for a completely unknown ruleType string', async () => {
    await expect(
      controller.toggleRule('ws-123', 'nonexistent_rule', { enabled: true } as any),
    ).rejects.toThrow('invalid_rule_type');
  });

  it('does NOT throw for a valid ruleType (unknown_sn)', async () => {
    // Use a valid 24-char hex ObjectId so Types.ObjectId() in the controller doesn't throw
    const validWsId = '60a0000000000000000000a1';
    ruleModel.findOneAndUpdate.mockResolvedValueOnce({ ruleType: 'unknown_sn', enabled: true });
    await expect(
      controller.toggleRule(validWsId, 'unknown_sn', { enabled: true } as any),
    ).resolves.not.toThrow();
  });
});
