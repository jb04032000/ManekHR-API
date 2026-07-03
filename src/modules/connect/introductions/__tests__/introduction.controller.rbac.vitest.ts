import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose before importing the controller — its transitive
// IntroductionService schema imports would otherwise trip vitest's
// reflect-metadata pipeline. Mirrors the stub used in
// reviews/__tests__/review.controller.rbac.vitest.ts.
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
import { IntroductionController } from '../introduction.controller';
import { AUTHENTICATED_ONLY_KEY } from '../../../../common/decorators/require-permission.decorator';

/**
 * Regression: the global fail-closed `RolesGuard` denies (403) any route that
 * carries no RBAC marker. The introduction WRITE endpoints are cross-workspace
 * user-level writes, so without the class-level `@AuthenticatedOnly()` marker
 * every call would 403. These tests pin the marker and the route handlers in
 * place.
 */
describe('IntroductionController RBAC markers', () => {
  const reflector = new Reflector();

  it('controller is reachable by any authenticated member (@AuthenticatedOnly)', () => {
    const marker = reflector.get<boolean>(AUTHENTICATED_ONLY_KEY, IntroductionController);
    expect(marker).toBe(true);
  });

  it('exposes the create route handler', () => {
    expect(typeof IntroductionController.prototype.create).toBe('function');
  });

  it('exposes the confirm route handler', () => {
    expect(typeof IntroductionController.prototype.confirm).toBe('function');
  });

  it('exposes the decline route handler', () => {
    expect(typeof IntroductionController.prototype.decline).toBe('function');
  });

  it('exposes the pending route handler', () => {
    expect(typeof IntroductionController.prototype.pending).toBe('function');
  });

  it('exposes the mine route handler', () => {
    expect(typeof IntroductionController.prototype.mine).toBe('function');
  });

  it('exposes the received route handler', () => {
    expect(typeof IntroductionController.prototype.received).toBe('function');
  });
});
