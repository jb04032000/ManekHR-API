import { describe, it, expect, vi } from 'vitest';

/**
 * Phase-2 ERP pricing — the trial reminder window default is 5 days (was 3),
 * giving room for the 2-3 nudge cadence in the final stretch. Stays
 * admin-editable; this only pins the baked-in default.
 *
 * Importing the schema with the REAL @nestjs/mongoose decorators trips
 * vitest's reflect-metadata type inference (a known repo gotcha — see the
 * decorator-mock pattern). So we mock @nestjs/mongoose and have the `@Prop`
 * decorator RECORD the options it receives per field; we then assert the
 * captured `default` for `reminderEmailDaysBeforeEnd`. This reads the real
 * source-of-truth default the schema declares — it fails loudly if anyone
 * flips it back to 3.
 */

// Capture @Prop({ ... }) options keyed by the decorated property name.
const propDefaults: Record<string, unknown> = {};

vi.mock('@nestjs/mongoose', () => {
  return {
    Prop: (opts?: { default?: unknown }) => (target: object, propertyKey: string) => {
      if (opts && 'default' in opts) {
        propDefaults[propertyKey] = opts.default;
      }
      return undefined;
    },
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
  };
});

describe('TrialPolicy default reminder window', () => {
  it('declares reminderEmailDaysBeforeEnd default = 5', async () => {
    // Import AFTER the mock is registered so the decorators record options.
    await import('../billing-policy.schema');
    expect(propDefaults.reminderEmailDaysBeforeEnd).toBe(5);
  });

  it('keeps the other trial defaults intact (duration 14, card not required)', async () => {
    await import('../billing-policy.schema');
    expect(propDefaults.defaultDurationDays).toBe(14);
    expect(propDefaults.defaultCardRequired).toBe(false);
  });
});
