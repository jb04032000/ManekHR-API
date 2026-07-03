import { ArrayMaxSize, IsArray } from 'class-validator';

// D19: generic payload for every import entity (parties, opening balances, ...). Each row is the
// user's Excel/CSV row already mapped to the entity's field keys by the wizard's column-mapping
// step. Per-row content is validated server-side in ImportService (keys are dynamic).
//
// R9: hard cap the row count. Each commit re-validates every row and (for posting entities) issues
// per-row DB writes, so an unbounded payload is a memory/DoS lever. 5000 rows comfortably covers a
// real onboarding file (parties / opening balances / bills); larger migrations should be chunked by
// the wizard. The cap is enforced before any service work runs.
const MAX_IMPORT_ROWS = 5000;

export class ImportRowsDto {
  @IsArray()
  @ArrayMaxSize(MAX_IMPORT_ROWS, {
    message: `Too many rows in one import (max ${MAX_IMPORT_ROWS}); split the file into smaller batches.`,
  })
  rows: Record<string, string>[];
}
