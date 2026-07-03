import { describe, it, expect } from 'vitest';
import { diffGrants } from '../grants-diff';

describe('diffGrants', () => {
  it('detects added grants', () => {
    const d = diffGrants([], [{ path: 'a', scope: 'self' }]);
    expect(d.added).toEqual([{ path: 'a', scope: 'self' }]);
    expect(d.removed).toEqual([]);
    expect(d.scopeChanged).toEqual([]);
  });

  it('detects removed grants', () => {
    const d = diffGrants([{ path: 'a', scope: 'self' }], []);
    expect(d.removed).toEqual([{ path: 'a', scope: 'self' }]);
    expect(d.added).toEqual([]);
    expect(d.scopeChanged).toEqual([]);
  });

  it('detects scope upgrade', () => {
    const d = diffGrants([{ path: 'a', scope: 'self' }], [{ path: 'a', scope: 'all' }]);
    expect(d.scopeChanged).toEqual([{ path: 'a', from: 'self', to: 'all' }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('no-op on identical', () => {
    const g = [{ path: 'a', scope: 'self' as const }];
    const d = diffGrants(g, g);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.scopeChanged).toEqual([]);
  });

  it('combined add + remove + scope change', () => {
    const before = [
      { path: 'a', scope: 'self' as const },
      { path: 'b', scope: 'self' as const },
    ];
    const after = [
      { path: 'a', scope: 'all' as const }, // scope change
      { path: 'c', scope: 'self' as const }, // added
      // b removed
    ];
    const d = diffGrants(before, after);
    expect(d.added).toEqual([{ path: 'c', scope: 'self' }]);
    expect(d.removed).toEqual([{ path: 'b', scope: 'self' }]);
    expect(d.scopeChanged).toEqual([{ path: 'a', from: 'self', to: 'all' }]);
  });
});
