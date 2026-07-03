import { describe, it, expect } from 'vitest';
import { resolveSubFeatureAccess } from '../entitlement-resolve.util';
import { FeatureAccessLevel } from '../../enums/feature-access.enum';

// Convenience alias
const MODULE = 'attendance';
const KEY = 'defaulter_alerts';

describe('resolveSubFeatureAccess', () => {
  // ── Null / undefined entitlements ─────────────────────────────────────────

  it('returns LOCKED when entitlements is null', () => {
    expect(resolveSubFeatureAccess(null, MODULE, KEY)).toBe(FeatureAccessLevel.LOCKED);
  });

  it('returns LOCKED when entitlements is undefined', () => {
    expect(resolveSubFeatureAccess(undefined, MODULE, KEY)).toBe(FeatureAccessLevel.LOCKED);
  });

  // ── Legacy fallback: moduleAccess empty, module present in modules[] ───────

  it('returns FULL when moduleAccess is absent and legacy modules[] includes the module', () => {
    expect(resolveSubFeatureAccess({ modules: [MODULE, 'salary'] }, MODULE, KEY)).toBe(
      FeatureAccessLevel.FULL,
    );
  });

  it('returns FULL when moduleAccess is an empty array and legacy modules[] includes the module', () => {
    expect(resolveSubFeatureAccess({ moduleAccess: [], modules: [MODULE] }, MODULE, KEY)).toBe(
      FeatureAccessLevel.FULL,
    );
  });

  it('returns LOCKED when moduleAccess is empty and legacy modules[] does NOT include the module', () => {
    expect(resolveSubFeatureAccess({ moduleAccess: [], modules: ['salary'] }, MODULE, KEY)).toBe(
      FeatureAccessLevel.LOCKED,
    );
  });

  it('returns LOCKED when moduleAccess is empty and no modules[] is present', () => {
    expect(resolveSubFeatureAccess({ moduleAccess: [] }, MODULE, KEY)).toBe(
      FeatureAccessLevel.LOCKED,
    );
  });

  // ── Module entry disabled ──────────────────────────────────────────────────

  it('returns LOCKED when the module entry exists but enabled=false', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [
            { module: MODULE, enabled: false, subFeatures: [{ key: KEY, access: 'full' }] },
          ],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.LOCKED);
  });

  it('returns LOCKED when the module is absent from a non-empty moduleAccess array', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [{ module: 'salary', enabled: true, subFeatures: [] }],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.LOCKED);
  });

  // ── Empty subFeatures → FULL legacy fallback ──────────────────────────────

  it('returns FULL when module is enabled and subFeatures array is empty (legacy subscription)', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [{ module: MODULE, enabled: true, subFeatures: [] }],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.FULL);
  });

  it('returns FULL when module is enabled and subFeatures is absent', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [{ module: MODULE, enabled: true }],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.FULL);
  });

  // ── Key absent from non-empty subFeatures → LOCKED ────────────────────────

  it('returns LOCKED when subFeatures is non-empty but the key is absent', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [
            {
              module: MODULE,
              enabled: true,
              subFeatures: [{ key: 'some_other_feature', access: 'full' }],
            },
          ],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.LOCKED);
  });

  // ── Sub-feature access levels ──────────────────────────────────────────────

  it('returns LOCKED when the sub-feature key is present with access=locked', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [
            {
              module: MODULE,
              enabled: true,
              subFeatures: [{ key: KEY, access: 'locked' }],
            },
          ],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.LOCKED);
  });

  it('returns LIMITED when the sub-feature key is present with access=limited', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [
            {
              module: MODULE,
              enabled: true,
              subFeatures: [{ key: KEY, access: 'limited' }],
            },
          ],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.LIMITED);
  });

  it('returns FULL when the sub-feature key is present with access=full', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [
            {
              module: MODULE,
              enabled: true,
              subFeatures: [{ key: KEY, access: 'full' }],
            },
          ],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.FULL);
  });

  it('returns LOCKED for an unrecognised access string', () => {
    expect(
      resolveSubFeatureAccess(
        {
          moduleAccess: [
            {
              module: MODULE,
              enabled: true,
              subFeatures: [{ key: KEY, access: 'unknown_value' }],
            },
          ],
        },
        MODULE,
        KEY,
      ),
    ).toBe(FeatureAccessLevel.LOCKED);
  });
});
