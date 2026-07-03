import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose before importing the controller — its transitive
// BrokerReviewService schema imports would otherwise trip vitest's
// reflect-metadata pipeline. Mirrors review.controller.rbac.vitest.ts.
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

import { Reflector } from '@nestjs/core';
import { BrokerReviewController, BrokerReviewPublicController } from '../broker-review.controller';
import { AUTHENTICATED_ONLY_KEY } from '../../../../common/decorators/require-permission.decorator';
import { IS_PUBLIC_KEY } from '../../../../common/decorators/public.decorator';

/**
 * The global fail-closed `RolesGuard` denies (403) any route that carries no RBAC
 * marker. These tests pin the markers: the write/own-read controller is reachable
 * by any authenticated member (`@AuthenticatedOnly`), and the proof-led broker
 * profile stays `@Public()`.
 */
describe('BrokerReviewController RBAC markers', () => {
  const reflector = new Reflector();

  it('write controller is reachable by any authenticated member (@AuthenticatedOnly)', () => {
    const marker = reflector.get<boolean>(AUTHENTICATED_ONLY_KEY, BrokerReviewController);
    expect(marker).toBe(true);
  });

  it('public broker-profile endpoint stays @Public()', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- metadata lookup only, never invoked
    const handler = BrokerReviewPublicController.prototype.getPublicBrokerProfile;
    const marker = reflector.get<boolean>(IS_PUBLIC_KEY, handler);
    expect(marker).toBe(true);
  });

  it('the public controller has NO @AuthenticatedOnly marker (it is unauthenticated)', () => {
    const marker = reflector.get<boolean>(AUTHENTICATED_ONLY_KEY, BrokerReviewPublicController);
    expect(marker).toBeFalsy();
  });
});
