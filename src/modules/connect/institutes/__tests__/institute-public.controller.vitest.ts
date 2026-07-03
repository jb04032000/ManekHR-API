/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstitutePublicController } from '../institute-public.controller';

/**
 * Unit coverage for the Institutes Phase 2 (Feature 3) PUBLIC institute-page
 * controller. Verifies each route forwards the validated pageId + query to the
 * right `ConnectProfileService` method, and that the controller adds NO gating of
 * its own (the page gate + DPDP filter live in the service, which is stubbed here).
 */

const PAGE_ID = '60b0000000000000000000b1';

function build() {
  const profiles: any = {
    getInstituteAlumni: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
    getInstitutePlacements: vi
      .fn()
      .mockResolvedValue({ employers: [], otherEmployerCount: 0, totalStudents: 0 }),
  };
  const controller = new InstitutePublicController(profiles);
  return { controller, profiles };
}

beforeEach(() => vi.clearAllMocks());

describe('InstitutePublicController', () => {
  it('alumni -> getInstituteAlumni(pageId, { cursor, limit })', async () => {
    const f = build();
    await f.controller.alumni({ pageId: PAGE_ID }, { cursor: 'abc', limit: 10 });
    expect(f.profiles.getInstituteAlumni).toHaveBeenCalledWith(PAGE_ID, {
      cursor: 'abc',
      limit: 10,
    });
  });

  it('alumni forwards an absent cursor/limit (first page, default size)', async () => {
    const f = build();
    await f.controller.alumni({ pageId: PAGE_ID }, {});
    expect(f.profiles.getInstituteAlumni).toHaveBeenCalledWith(PAGE_ID, {
      cursor: undefined,
      limit: undefined,
    });
  });

  it('placements -> getInstitutePlacements(pageId, { limit })', async () => {
    const f = build();
    await f.controller.placements({ pageId: PAGE_ID }, { limit: 25 });
    expect(f.profiles.getInstitutePlacements).toHaveBeenCalledWith(PAGE_ID, { limit: 25 });
  });

  it('returns the service result verbatim (explicit empty marker passes through)', async () => {
    const f = build();
    const res = await f.controller.placements({ pageId: PAGE_ID }, {});
    expect(res).toEqual({ employers: [], otherEmployerCount: 0, totalStudents: 0 });
  });
});
