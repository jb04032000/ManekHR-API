import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose before importing the controller — its transitive
// ReviewService schema imports would otherwise trip vitest's reflect-metadata
// pipeline. Mirrors the stub used in common/guards/__tests__/roles.guard.vitest.ts.
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
import { ReviewController, ReviewPublicController } from '../review.controller';
import { AUTHENTICATED_ONLY_KEY } from '../../../../common/decorators/require-permission.decorator';
import { IS_PUBLIC_KEY } from '../../../../common/decorators/public.decorator';

/**
 * Regression: the global fail-closed `RolesGuard` denies (403) any route that
 * carries no RBAC marker. The review WRITE endpoints previously shipped without
 * one, so submitting a review on a storefront returned 403 while the `@Public()`
 * list still loaded. These tests pin the markers in place.
 */
describe('ReviewController RBAC markers', () => {
  const reflector = new Reflector();

  it('write controller is reachable by any authenticated member (@AuthenticatedOnly)', () => {
    const marker = reflector.get<boolean>(AUTHENTICATED_ONLY_KEY, ReviewController);
    expect(marker).toBe(true);
  });

  it('public seller-list endpoint stays @Public()', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- metadata lookup only, never invoked
    const handler = ReviewPublicController.prototype.listForSeller;
    const marker = reflector.get<boolean>(IS_PUBLIC_KEY, handler);
    expect(marker).toBe(true);
  });
});
