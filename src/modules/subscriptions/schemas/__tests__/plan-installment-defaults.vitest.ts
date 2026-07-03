import { describe, it, expect, vi } from 'vitest';

/**
 * Upfront-vs-installments pricing rework — the Plan schema now bakes three
 * admin-tunable billing defaults:
 *   - upfrontDiscountPercent = 0  (no discount until an admin sets one)
 *   - installmentsEnabled    = true  (the 12×0% option is offered by default)
 *   - installmentMonths      = 12  (yearly price split into 12 monthly charges)
 *
 * Importing the schema with the REAL @nestjs/mongoose decorators trips vitest's
 * reflect-metadata type inference (a known repo gotcha — see the decorator-mock
 * pattern). So we mock @nestjs/mongoose and have the `@Prop` decorator RECORD
 * the options per field; we then assert the captured `default`. This reads the
 * real source-of-truth defaults the schema declares — it fails loudly if anyone
 * flips them.
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

describe('Plan schema upfront/installment defaults', () => {
  it('declares upfrontDiscountPercent default = 0', async () => {
    // Import AFTER the mock is registered so the decorators record options.
    await import('../plan.schema');
    expect(propDefaults.upfrontDiscountPercent).toBe(0);
  });

  it('declares installmentsEnabled default = true', async () => {
    await import('../plan.schema');
    expect(propDefaults.installmentsEnabled).toBe(true);
  });

  it('declares installmentMonths default = 12', async () => {
    await import('../plan.schema');
    expect(propDefaults.installmentMonths).toBe(12);
  });
});
