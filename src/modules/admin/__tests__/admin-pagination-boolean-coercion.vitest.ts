import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { AdminPaginationDto } from '../dto/admin.dto';

// Query-string booleans arrive as the STRINGS 'true'/'false'. The old
// @Type(() => Boolean) coerced 'false' to TRUE (Boolean('false') === true), so
// an unchecked "Show demo/deleted" box still enabled the filter. These lock the
// explicit @Transform parse so 'false' means false.
describe('AdminPaginationDto boolean query coercion', () => {
  it("parses includeDemo 'false' -> false and 'true' -> true", () => {
    expect(plainToInstance(AdminPaginationDto, { includeDemo: 'false' }).includeDemo).toBe(false);
    expect(plainToInstance(AdminPaginationDto, { includeDemo: 'true' }).includeDemo).toBe(true);
  });

  it("parses includeDeleted 'false' -> false and 'true' -> true", () => {
    expect(plainToInstance(AdminPaginationDto, { includeDeleted: 'false' }).includeDeleted).toBe(
      false,
    );
    expect(plainToInstance(AdminPaginationDto, { includeDeleted: 'true' }).includeDeleted).toBe(
      true,
    );
  });

  it('leaves an absent flag undefined', () => {
    expect(plainToInstance(AdminPaginationDto, {}).includeDemo).toBeUndefined();
  });
});
