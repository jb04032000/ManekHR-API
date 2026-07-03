import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import {
  RequirePermission,
  AuthenticatedOnly,
  REQUIRE_PERMISSION_KEY,
  AUTHENTICATED_ONLY_KEY,
  type RequiredPermissionMeta,
} from '../require-permission.decorator';

describe('require-permission decorators', () => {
  it('RequirePermission attaches path + scope metadata', () => {
    @RequirePermission('team.profile.bank.edit', 'all')
    class Target {
      noop() {}
    }
    const meta = new Reflector().get<RequiredPermissionMeta>(REQUIRE_PERMISSION_KEY, Target);
    expect(meta).toEqual({ path: 'team.profile.bank.edit', scope: 'all' });
  });

  it('RequirePermission works without a scope', () => {
    @RequirePermission('team.directory.view')
    class Target {
      noop() {}
    }
    const meta = new Reflector().get<RequiredPermissionMeta>(REQUIRE_PERMISSION_KEY, Target);
    expect(meta).toEqual({ path: 'team.directory.view', scope: undefined });
  });

  it('AuthenticatedOnly attaches its marker', () => {
    @AuthenticatedOnly()
    class Target {
      noop() {}
    }
    const meta = new Reflector().get<boolean>(AUTHENTICATED_ONLY_KEY, Target);
    expect(meta).toBe(true);
  });
});
