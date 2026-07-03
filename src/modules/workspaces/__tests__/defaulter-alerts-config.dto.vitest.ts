import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DefaulterAlertsConfigDto } from '../dto/workspace.dto';

async function errorsFor(payload: unknown): Promise<string[]> {
  const dto = plainToInstance(DefaulterAlertsConfigDto, payload);
  const errors = await validate(dto, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('DefaulterAlertsConfigDto', () => {
  it('accepts a valid payload', async () => {
    expect(
      await errorsFor({
        enabled: true,
        channels: { inApp: true, email: false },
        recipients: { mode: 'managers', specificPeople: [] },
      }),
    ).toEqual([]);
  });

  it('rejects an invalid recipients.mode', async () => {
    const errors = await errorsFor({
      enabled: true,
      channels: { inApp: true, email: true },
      recipients: { mode: 'everyone', specificPeople: [] },
    });
    expect(errors).toContain('recipients');
  });

  it('rejects a non-ObjectId in specificPeople', async () => {
    const errors = await errorsFor({
      enabled: true,
      channels: { inApp: true, email: true },
      recipients: { mode: 'specificPeople', specificPeople: ['not-an-id'] },
    });
    expect(errors).toContain('recipients');
  });
});
