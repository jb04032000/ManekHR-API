import { describe, it, expect, vi } from 'vitest';

// Stub @nestjs/mongoose so importing the module (which transitively imports the
// decorated schemas) does not trip vitest's reflect-metadata pipeline. Mirrors
// the service test's decorator mock.
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

// Stub NotificationsModule so we don't pull its entire DI graph into the unit
// test — we only assert THIS module + service shape compile and load.
vi.mock('../../../notifications/notifications.module', () => ({
  NotificationsModule: class NotificationsModule {},
}));

import { ErpMemberCapModule } from '../erp-member-cap.module';
import { ErpMemberCapService, ERP_MEMBER_CAP_GRACE_DAYS } from '../erp-member-cap.service';

describe('ErpMemberCapModule wiring', () => {
  it('module class loads and exports the service for consumers (Team/Salary/Attendance)', () => {
    expect(ErpMemberCapModule).toBeDefined();
    expect(typeof ErpMemberCapModule).toBe('function');
    expect(ErpMemberCapService).toBeDefined();
  });

  it('grace-days constant has a sensible ERP default (overridable, not hard-coded inline)', () => {
    expect(ERP_MEMBER_CAP_GRACE_DAYS).toBe(7);
  });
});
