/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose decorators BEFORE importing UsersService so the
// `@InjectModel` decoration on the constructor doesn't trip vitest's
// reflect-metadata pipeline. We pass a plain mocked Model directly.
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

import { UsersService } from '../users.service';

/**
 * Regression coverage for the identifier-lookup mobile-shape bug fixed
 * 2026-05-09: combined-signup persists `mobile` as the canonical
 * `91XXXXXXXXXX` E.164 form, but `LoginDto.identifier` arrives raw (typically
 * the bare 10-digit body the user typed). Pre-fix, the `findByIdentifier*`
 * helpers did an exact `mobile: identifier` match and missed the canonical
 * row, so password-login after a fresh signup returned 401 even with the
 * correct password.
 *
 * The fix moved the normalisation INTO UsersService so all four call sites
 * (login, register-existence-check, terminate-and-login, invitee lookup)
 * stay in lockstep with the SmsOtpService write path.
 */
describe('UsersService — identifier mobile-shape normalisation', () => {
  let svc: UsersService;
  let userModel: any;
  let findOneSpy: ReturnType<typeof vi.fn>;
  let chain: any;

  beforeEach(() => {
    chain = {
      select: vi.fn(() => chain),
      exec: vi.fn().mockResolvedValue(null),
    };
    findOneSpy = vi.fn(() => chain);
    userModel = {
      findOne: findOneSpy,
    };
    svc = new UsersService(userModel);
  });

  // ── findByIdentifierWithCredentials ────────────────────────────────────

  it('login lookup with bare 10-digit mobile queries both 91-prefixed + bare forms', async () => {
    await svc.findByIdentifierWithCredentials('9876543210');

    expect(findOneSpy).toHaveBeenCalledTimes(1);
    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ mobile: { $in: ['919876543210', '9876543210'] } }],
    });
    expect(chain.select).toHaveBeenCalledWith('+passwordHash +pinHash');
  });

  it('login lookup with already-canonical 91-prefixed mobile is idempotent', async () => {
    await svc.findByIdentifierWithCredentials('919876543210');

    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ mobile: { $in: ['919876543210', '9876543210'] } }],
    });
  });

  it('login lookup with +91-prefixed mobile strips the plus + non-digits', async () => {
    await svc.findByIdentifierWithCredentials('+91 98765 43210');

    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ mobile: { $in: ['919876543210', '9876543210'] } }],
    });
  });

  it('login lookup with email falls through to exact email + mobile match', async () => {
    await svc.findByIdentifierWithCredentials('jay@example.com');

    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ email: 'jay@example.com' }, { mobile: 'jay@example.com' }],
    });
  });

  it('login lookup with non-Indian-mobile digit string falls through to exact match (no false positives)', async () => {
    // 9-digit input — fewer than 10 digits → not a valid Indian mobile.
    // Must NOT be coerced into a mobile lookup.
    await svc.findByIdentifierWithCredentials('123456789');

    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ email: '123456789' }, { mobile: '123456789' }],
    });
  });

  // ── findByIdentifier (no credentials projection) ───────────────────────

  it('findByIdentifier mirrors the same normalisation rules', async () => {
    await svc.findByIdentifier('9876543210');

    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ mobile: { $in: ['919876543210', '9876543210'] } }],
    });
    // No credentials projection on this helper.
    expect(chain.select).not.toHaveBeenCalled();
  });

  // ── findByInviteeIdentifier ────────────────────────────────────────────

  it('findByInviteeIdentifier scopes to active users + uses normalised $or', async () => {
    await svc.findByInviteeIdentifier('9876543210');

    const filter = findOneSpy.mock.calls[0][0];
    expect(filter).toEqual({
      $or: [{ mobile: { $in: ['919876543210', '9876543210'] } }],
      isActive: true,
    });
  });
});
