import { describe, it, expect } from 'vitest';
import { TEAM_ROLE_PRESETS, type RolePreset } from '../role-presets';
import { assertViewEditCoherent } from '../coherence';
import { assertDepsResolved } from '../dep-resolver';
import { isValidPermissionPath } from '../permission-registry';

describe('TEAM_ROLE_PRESETS', () => {
  it('exposes hrAdmin, hrMember, manager, worker in that exact order', () => {
    const keys = TEAM_ROLE_PRESETS.map((p) => p.key);
    expect(keys).toEqual(['hrAdmin', 'hrMember', 'manager', 'worker']);
  });

  it.each(TEAM_ROLE_PRESETS)('preset $key is view-edit coherent', (preset: RolePreset) => {
    expect(() => assertViewEditCoherent(preset.paths)).not.toThrow();
  });

  it.each(TEAM_ROLE_PRESETS)('preset $key has all dependencies resolved', (preset: RolePreset) => {
    expect(() => assertDepsResolved(preset.paths)).not.toThrow();
  });

  it.each(TEAM_ROLE_PRESETS)(
    'preset $key uses only valid registry leaf paths',
    (preset: RolePreset) => {
      for (const g of preset.paths) expect(isValidPermissionPath(g.path)).toBe(true);
    },
  );

  it.each(TEAM_ROLE_PRESETS)('preset $key has labelKey + descriptionKey', (preset: RolePreset) => {
    expect(preset.labelKey).toMatch(/^rbac\.preset\./);
    expect(preset.descriptionKey).toMatch(/^rbac\.presetDesc\./);
  });

  // Lock the grant count per preset — protects against accidental
  // drift (added/dropped grants without spec update). Phase 1d follow-up:
  // `team.member.create` was lifted out of hrMember + manager when its
  // per-action `requires` was extended to bundle every profile-edit path
  // (the create form opens a full-row write — implying wider access than
  // those mid-tier roles intend).
  const EXPECTED_COUNTS: Record<string, number> = {
    hrAdmin: 18,
    hrMember: 11, // was 12; dropped team.member.create
    manager: 7, // was 8; dropped team.member.create
    worker: 10,
  };
  it.each(TEAM_ROLE_PRESETS)('preset $key has the expected grant count', (preset: RolePreset) => {
    expect(preset.paths.length).toBe(EXPECTED_COUNTS[preset.key]);
  });
});
